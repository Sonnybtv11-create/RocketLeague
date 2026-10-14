// End-to-end test for input + camera in a real browser (Playwright, headless Chromium).
// Run from the repo root after `node tools/assemble.mjs --dev`:
//   node src/input/tests/e2e.mjs [--shots=shots]
// Checks:
//   1. free play: hold W for 1 s of sim time -> forward speed > 800
//   2. RMB tap (down/up 3 ms apart) -> car jumps within a few ticks
//   3. Space toggles ball cam; Esc fires pause; F3 does not throw
//   4. camera never inside a wall: drive into a corner and up a side wall, sample the camera
//      every frame, assert arena SDF(camera) > 20
//   5. zero console errors
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const SHOTS = opt.shots || 'shots';
const root = resolve('.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = join(root, p);
  if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const results = [];
const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

async function open(query, w = 1280, h = 720) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  // resource failures are checked through 'response' below (Chromium's automatic /favicon.ico
  // request 404s because the shell has no icon link — not a game error)
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${port}/src/dev.html?shot=1&${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  // free play starts with the kickoff countdown (cars frozen) — wait for GO
  await page.waitForFunction(() => !window.__game.match || window.__game.match.state === 'playing', null, { timeout: 60000, polling: 100 });
  return page;
}
const simTime = (page) => page.evaluate(() => window.__game.world.time);
async function waitSim(page, seconds) {
  const t0 = await simTime(page);
  await page.waitForFunction((t) => window.__game.world.time >= t, t0 + seconds, { timeout: 60000, polling: 'raf' });
}
const player = (page) => page.evaluate(() => {
  const g = window.__game; const c = g.world.getCar(g.playerCarId);
  return { fwd: c.forwardSpeed, onGround: c.isOnGround, hasJumped: c.hasJumped, z: c.body.pos.z, tick: g.world.tick };
});

try {
  // ------------------------------------------------------------ 1+2 driving & jump
  const page = await open('scene=freeplay');
  await waitSim(page, 0.5);
  await page.keyboard.down('KeyW');
  await waitSim(page, 1.0);
  const p1 = await player(page);
  await page.keyboard.up('KeyW');
  check('hold W 1 s -> forward speed > 800', p1.fwd > 800, `forwardSpeed ${p1.fwd.toFixed(0)} uu/s`);

  await waitSim(page, 0.8);
  const before = await player(page);
  await page.evaluate(() => {
    window.__press = null;
    addEventListener('mousedown', () => { window.__press = { tick: window.__game.world.tick, t: performance.now() }; });
  });
  await page.mouse.move(640, 420);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(3);
  await page.mouse.up({ button: 'right' });
  // when did the jump start? (tick - jumpTime/dt) vs the last completed tick at the press
  let jumped = null;
  for (let i = 0; i < 100 && !jumped; i++) {
    jumped = await page.evaluate(() => {
      const g = window.__game; const c = g.world.getCar(g.playerCarId);
      if (!c.hasJumped) return null;
      return { startTick: g.world.tick - Math.round(c.jumpTime / g.world.dt) + 1, press: window.__press };
    });
    if (!jumped) await page.waitForTimeout(5);
  }
  const lag = jumped && jumped.press ? jumped.startTick - jumped.press.tick : null;
  check('RMB tap (3 ms) -> car jumps on one of the first ticks simulated after the press', !!jumped && before.onGround && lag !== null && lag >= 1 && lag <= 9,
    jumped ? `press after tick ${jumped.press && jumped.press.tick}, jump impulse on tick ${jumped.startTick} (+${lag}; the next frame runs up to 8 ticks covering the time since the press)` : 'never jumped');

  // ------------------------------------------------------------ 3 UI actions
  await page.keyboard.press('Space');
  await waitSim(page, 0.05);
  // the ballCam flag rides along with the Controls sampled into the player car
  const inputBallCam = await page.evaluate(() => window.__game.world.getCar(window.__game.playerCarId).controls.ballCam);
  check('Space toggles ball cam (default on -> off)', inputBallCam === false, `controls.ballCam=${inputBallCam}`);
  await page.keyboard.press('Space');
  await page.keyboard.press('F3');
  await page.keyboard.press('F3');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const paused = await page.evaluate(() => window.__game.paused);
  check('Esc pauses the game', paused === true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const resumed = await page.evaluate(() => window.__game.paused);
  check('Esc again resumes', resumed === false);
  await page.close();

  // ------------------------------------------------------------ 4 camera vs walls
  const page2 = await open('scene=freeplay');
  await page2.evaluate(async () => {
    const m = await import('/src/sim/arena.js');
    window.__sdf = m.arenaSDF;
    window.__minCam = { d: Infinity, at: null };
    const loop = () => {
      const c = window.__camCtl && window.__camCtl.debug.simPos;
      if (c && window.__camCtl.debug.mode === 'car') {
        const d = m.arenaSDF(c.x, c.y, c.z);
        if (d < window.__minCam.d) window.__minCam = { d, at: c };
      }
      requestAnimationFrame(loop);
    };
    loop();
  });
  const scenarios = [
    { name: 'corner', x: 3200, y: 4200, yaw: Math.atan2(1, 1) },
    { name: 'side wall', x: 3300, y: 0, yaw: 0 },
    { name: 'back wall beside goal', x: -1800, y: 4300, yaw: Math.PI / 2 },
    { name: 'into goal', x: 0, y: 4300, yaw: Math.PI / 2 },
  ];
  for (const sc of scenarios) {
    await page2.evaluate((sc) => {
      const g = window.__game; const car = g.world.getCar(g.playerCarId);
      car.setSpawn(sc.x, sc.y, 17, sc.yaw, 100);
      car.body.vel.set(Math.cos(sc.yaw) * 1400, Math.sin(sc.yaw) * 1400, 0);
      window.__minCam = { d: Infinity, at: null };
    }, sc);
    await page2.keyboard.down('KeyW');
    await page2.mouse.move(640, 420);
    await page2.mouse.down({ button: 'left' }); // boost up the wall
    await waitSim(page2, 1.2);
    await page2.mouse.up({ button: 'left' });
    await waitSim(page2, 1.0);
    const state = await page2.evaluate(() => {
      const g = window.__game; const c = g.world.getCar(g.playerCarId);
      return { min: window.__minCam, car: { x: c.body.pos.x, y: c.body.pos.y, z: c.body.pos.z, upz: c.up.z } };
    });
    if (sc.name === 'side wall') { mkdirSync(SHOTS, { recursive: true }); await page2.screenshot({ path: `${SHOTS}/e2e_wall.png` }); }
    await page2.keyboard.up('KeyW');
    check(`camera clearance > 20 uu (${sc.name})`, state.min.d > 20, `min SDF ${state.min.d.toFixed(1)} uu; car at (${state.car.x.toFixed(0)}, ${state.car.y.toFixed(0)}, ${state.car.z.toFixed(0)}) up.z ${state.car.upz.toFixed(2)}`);
  }
  await page2.close();

  // ------------------------------------------------------------ kickoff framing shot
  const page3 = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page3.goto(`http://127.0.0.1:${port}/src/dev.html?shot=1&scene=kickoff&size=1`, { waitUntil: 'load' });
  await page3.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  await page3.waitForTimeout(1500);
  mkdirSync(SHOTS, { recursive: true });
  await page3.screenshot({ path: `${SHOTS}/e2e_kickoff.png` });
  await page3.close();
} catch (e) {
  check('e2e run', false, e.stack || e.message);
}
check('zero console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
