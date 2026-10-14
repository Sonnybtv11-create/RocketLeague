// Live audio smoke test (audio agent). Serves the repo, opens a bot-only 3v3 match with the
// audio engine forced on, samples window.__audioStats() every few seconds, toggles pause
// (Escape) to check suspend/resume, and reports console errors / failed requests.
// Usage (from the repo root, after `node tools/assemble.mjs --dev`):
//   node src/audio/tests/livetest.mjs [seconds=40] ["extra=query"]
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const SECONDS = Number(process.argv[2] || 40);
const EXTRA = process.argv[3] || '';
const root = resolve('.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = join(root, p);
  if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/src/dev.html?scene=spectate&size=3&audio=1&q=low&${EXTRA}`;
const browser = await chromium.launch({
  executablePath: existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [], failed = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => failed.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const stats = () => page.evaluate(() => ({ ...window.__audioStats(), sim: +window.__game.world.time.toFixed(1), fps: Math.round(window.__game.fps || 0), match: window.__game.match.state }));
let maxShots = 0, maxVoices = 0;
for (let t = 0; t < SECONDS; t += 5) {
  await page.waitForTimeout(5000);
  const s = await stats();
  maxShots = Math.max(maxShots, s.shots); maxVoices = Math.max(maxVoices, s.carVoices);
  console.log(`t=${t + 5}s sim=${s.sim}s fps=${s.fps} ctx=${s.state} shots=${s.shots} peakShots=${s.peakShots} carVoices=${s.carVoices} played=${s.played} dropped=${s.dropped} stolen=${s.stolen} excite=${s.excite} hype=${s.hype} match=${s.match}`);
}
// pause / resume via the Escape binding
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
const paused = await stats();
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
const resumed = await stats();
console.log(`pause -> ctx=${paused.state} paused=${paused.paused}; resume -> ctx=${resumed.state} paused=${resumed.paused}`);
const fin = await stats();
console.log('byType', JSON.stringify(fin.byType));
console.log('bakeMs', JSON.stringify(fin.bakeMs), 'crowdReady', fin.crowdReady);
console.log(`max sampled shots=${maxShots}, peakShots=${fin.peakShots}/${fin.maxShots}, carVoices<=${maxVoices}`);
console.log(`console errors/warnings: ${errors.length}`); for (const e of errors.slice(0, 20)) console.log('  ' + e);
console.log(`failed requests: ${failed.length}`); for (const f of failed.slice(0, 10)) console.log('  ' + f);
await browser.close();
server.close();
