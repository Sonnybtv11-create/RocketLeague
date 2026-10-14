// Headless screenshot tool for the visual QA loop.
// Usage:
//   node tools/shot.mjs "<query string>" out.png [--wait=ms] [--w=1920 --h=1080] [--final] [--eval="js"]
// Examples:
//   node tools/shot.mjs "scene=kickoff&q=high" shots/kickoff.png
//   node tools/shot.mjs "cam=0,-7000,1500,0,0,0" shots/wide.png
// Serves the repo root on a local port and loads src/dev.html (or index.html with --final).
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const args = process.argv.slice(2);
const query = args[0] || '';
const out = args[1] || 'shots/shot.png';
const opt = Object.fromEntries(args.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const W = Number(opt.w || 1920), H = Number(opt.h || 1080), WAIT = Number(opt.wait || 2500);
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
const page0 = opt.final ? 'index.html' : 'src/dev.html';
const url = `http://127.0.0.1:${port}/${page0}?shot=1&${query}`;

const browser = await chromium.launch({
  executablePath: existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(240000);
page.setDefaultNavigationTimeout(240000);
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
await page.goto(url, { waitUntil: 'load' });
try { await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 }); } catch { logs.push('[shot] __ready timeout'); }
if (opt.eval) { try { const r = await page.evaluate(opt.eval); if (r !== undefined) logs.push('[eval] ' + JSON.stringify(r)); } catch (e) { logs.push('[eval error] ' + e.message); } }
await page.waitForTimeout(WAIT);
if (opt.eval2) { try { const r = await page.evaluate(opt.eval2); if (r !== undefined) logs.push('[eval2] ' + JSON.stringify(r)); } catch (e) { logs.push('[eval2 error] ' + e.message); } }
if (opt.wait2) await page.waitForTimeout(Number(opt.wait2));
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out, timeout: 240000 });
const fps = await page.evaluate(() => (window.__game && window.__game.fps) || null).catch(() => null);
console.log(logs.filter((l) => !l.includes('GPU stall')).slice(0, 60).join('\n'));
console.log(`saved ${out}`);
await browser.close();
server.close();
