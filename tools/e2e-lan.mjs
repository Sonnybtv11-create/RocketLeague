// LAN play end-to-end: two headless browsers connect with the 6-digit game code through the site's
// room worker, either directly (WebRTC) or, with --relay, with all game traffic relayed by the worker
// (what happens on networks that block direct connections). The host starts a 1v1 with no bots and
// the joiner drives its car with the keyboard.
// Usage: npx wrangler dev --port 8787 &   then   node tools/e2e-lan.mjs [--relay | --block-p2p] [--shots] [--base=http://127.0.0.1:8787]
// --block-p2p: direct connections fail on their own, so the game must fall back to the relay by itself
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const shots = process.argv.includes('--shots');
const blockP2P = process.argv.includes('--block-p2p'); // browsers can't make direct connections (like school Wi-Fi)
const relay = process.argv.includes('--relay') || blockP2P;
const forceRelay = process.argv.includes('--relay');
const base = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:8787').slice(7);
const url = `${base}/?q=low${forceRelay ? '&net=relay' : ''}`;
const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launch = () => chromium.launch({
  executablePath: existsSync(exe) ? exe : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
// two separate browsers = two "computers"
const [bA, bB] = await Promise.all([launch(), launch()]);
const host = await bA.newPage({ viewport: { width: 640, height: 360 } });
const join = await bB.newPage({ viewport: { width: 640, height: 360 } });
const logs = [];
// --block-p2p: drop every ICE candidate so direct connections can never form (as on isolated Wi-Fi)
if (blockP2P) for (const pg of [host, join]) await pg.addInitScript(() => { RTCPeerConnection.prototype.addIceCandidate = async () => {}; });
for (const [n, pg] of [['host', host], ['join', join]]) {
  pg.setDefaultTimeout(120000);
  pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${n} ${m.type()}] ${m.text()}`); });
  pg.on('pageerror', (e) => logs.push(`[${n} pageerror] ${e.message}`));
}
await Promise.all([host.goto(url), join.goto(url)]);
await Promise.all([host.waitForFunction(() => window.__ready === true), join.waitForFunction(() => window.__ready === true)]);

let ok = true;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) ok = false; };
const t0 = Date.now();

// host: open the lobby page through the menus and make an invite
await host.evaluate(() => { window.__api.getSettings().game.playerName = 'Hosty'; });
await join.evaluate(() => { window.__api.getSettings().game.playerName = 'Joiny'; });
await host.click('text=Play LAN');
await host.click('text=Host game');
{
  await host.waitForFunction(() => window.__api.lanState().relayStatus !== 'opening' && window.__api.lanState().relayStatus !== 'off', null, { timeout: 20000 });
  const st = await host.evaluate(() => window.__api.lanState());
  check(/^\d{6}$/.test(st.code), `game code "${st.code}" ${st.relayError || ''} (${Date.now() - t0} ms)`);
  if (shots) { mkdirSync('shots', { recursive: true }); await host.screenshot({ path: 'shots/lan-host-code.png' }); }
  await join.click('text=Play LAN');
  await join.click('text=Join game');
  // a wrong code first: should say no game was found
  const wrong = String((Number(st.code) + 1) % 900000 + 100000);
  await join.fill('input.tp-codein', wrong);
  await join.click('button:has-text("Join")');
  await join.waitForFunction(() => { const s = window.__api.lanState(); return s.client && s.client.status === 'idle' && s.client.error; }, null, { timeout: 30000 });
  const err = await join.evaluate(() => window.__api.lanState().client.error);
  check(/No game found/.test(err), `wrong code: "${err}"`);
  await join.fill('input.tp-codein', st.code);
  await join.click('button:has-text("Join")');
}
await host.waitForFunction(() => window.__api.lanState().slots.some((s) => s.status === 'connected'), null, { timeout: 30000 }).catch(async (e) => {
  console.log('host', JSON.stringify(await host.evaluate(() => window.__api.lanState())).slice(0, 600));
  console.log('join', JSON.stringify(await join.evaluate(() => window.__api.lanState())).slice(0, 600));
  throw e;
});
await join.waitForFunction(() => { const s = window.__api.lanState(); return s.client && s.client.status === 'connected' && s.client.lobby; }, null, { timeout: 20000 });
const lobby = await join.evaluate(() => window.__api.lanState().client.lobby);
const modes = [await host.evaluate(() => window.__api.lanState().slots.map((s) => s.mode).join(',')), await join.evaluate(() => window.__api.lanState().client.mode)];
check(modes[0] === (relay ? 'relay' : 'p2p') && modes[1] === modes[0], `connection: host sees ${modes[0]}, joiner ${modes[1]}`);
check(lobby.players.length === 2 && lobby.players.some((p) => p.name === 'Joiny'), `lobby: ${lobby.players.map((p) => p.name + ':' + p.team).join(', ')} (${Date.now() - t0} ms)`);
if (shots) { await host.screenshot({ path: 'shots/lan-host-lobby.png' }); await join.screenshot({ path: 'shots/lan-join-lobby.png' }); }

// host: 1v1, no bots
await host.click('button[data-key="lan-size:1"]');
await host.click('button[data-key="lan-bots:false"]');
await host.click('button[data-key="lan-start"]');
await join.waitForFunction(() => window.__game.lan === 'client', null, { timeout: 10000 });
const hostCars = await host.evaluate(() => window.__game.world.cars.map((c) => ({ id: c.id, name: c.name, team: c.team, isBot: c.isBot })));
const you = await join.evaluate(() => window.__game.playerCarId);
check(hostCars.length === 2 && hostCars.every((c) => !c.isBot), `host world: ${JSON.stringify(hostCars)}`);
check(hostCars.find((c) => c.id === you)?.name === 'Joiny', `joiner controls car ${you}`);

// wait for the kickoff countdown, then the joiner holds throttle + boost
console.log('host fps', await host.evaluate(() => window.__game.fps), 'join fps', await join.evaluate(() => window.__game.fps));
await host.waitForFunction(() => window.__game.match.state === 'playing', null, { timeout: 60000 });
console.log('playing after', Date.now() - t0, 'ms');
const startPos = await host.evaluate((id) => { const c = window.__game.world.getCar(id); return { x: c.body.pos.x, y: c.body.pos.y }; }, you);
await join.bringToFront();
await join.click('canvas', { position: { x: 640, y: 360 }, button: 'middle' }).catch(() => {});
await join.keyboard.down('KeyW');
const tick0 = await host.evaluate(() => window.__game.world.tick);
await host.waitForFunction((t) => window.__game.world.tick > t + 180, tick0, { timeout: 60000 }); // 1.5 s of sim time
await join.keyboard.up('KeyW');
const after = await host.evaluate((id) => { const c = window.__game.world.getCar(id); return { x: c.body.pos.x, y: c.body.pos.y, speed: c.body.vel.len() }; }, you);
const moved = Math.hypot(after.x - startPos.x, after.y - startPos.y);
check(moved > 300, `joiner's throttle moved its car on the host by ${moved.toFixed(0)} uu (speed ${after.speed.toFixed(0)})`);

// joiner renders the host's state (snapshot interpolation, ~5 tick delay)
const sync = await Promise.all([
  host.evaluate((id) => { const c = window.__game.world.getCar(id); return [c.body.pos.x, c.body.pos.y, window.__game.world.ball.body.pos.z]; }, you),
  join.evaluate(() => { const n = window.__game.net; const v = n.buildView(performance.now()); const c = v.view.cars.find((x) => x.id === window.__game.playerCarId); return [c.pos.x, c.pos.y, v.view.ball.pos.z, window.__game.match.getView().state]; }),
]);
const d = Math.hypot(sync[0][0] - sync[1][0], sync[0][1] - sync[1][1]);
check(d < 250, `joiner view tracks the host (car offset ${d.toFixed(0)} uu, joiner match state ${sync[1][3]})`);

// host scores: put the ball in orange's net and check the joiner sees the goal + score
await host.evaluate(() => { const b = window.__game.world.ball.body; b.pos.set(0, 4900, 200); b.vel.set(0, 2000, 0); });
await join.waitForFunction(() => window.__game.match.getView().scores[0] === 1, null, { timeout: 5000 }).then(() => check(true, 'joiner sees the goal on the scoreboard'), () => check(false, 'joiner sees the goal'));
await join.waitForFunction(() => { const n = window.__game.net; const v = n && n.buildView(performance.now()); return v && v.hint; }, null, { timeout: 60000 }).then(() => check(true, 'joiner receives the goal replay'), () => check(false, 'joiner receives the goal replay'));
if (shots) { await host.screenshot({ path: 'shots/lan-host-game.png' }); await join.screenshot({ path: 'shots/lan-join-game.png' }); }

// host leaves -> joiner returns to the LAN page with a message
await host.evaluate(() => window.__api.quitToMenu());
await join.waitForFunction(() => window.__game.lan === null && window.__api.lanState().notice, null, { timeout: 8000 });
const notice = await join.evaluate(() => window.__api.lanState().notice);
check(/host/i.test(notice), `joiner told: "${notice}"`);

const errs = logs.filter((l) => !/GPU stall|WebGL|swiftshader|AudioContext|Automatic fallback/i.test(l));
check(errs.length === 0, `no page errors${errs.length ? ':\n  ' + errs.slice(0, 10).join('\n  ') : ''}`);
console.log(ok ? 'LAN E2E OK' : 'LAN E2E FAILED');
await Promise.all([bA.close(), bB.close()]);
process.exit(ok ? 0 : 1);
