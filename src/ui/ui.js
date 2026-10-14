// OWNER: UI agent. STUB.
// createUI({ root, api, settings, stats }) -> {
//   update(view, frameDt, info), onEvents(events, view), showMainMenu(), showPause(), hideMenus(), showEndScreen(matchView),
//   isMenuOpen(), setDebug(on), dispose() }
// info = { fps, playerCarId, tick, ballCam, inputDevice }
// api (implemented in main.js): startMatch(cfg), startFreePlay(cfg), resumeGame(), quitToMenu(), rematch(),
//   settingsChanged(), saveSettings(), getInput(), runSelfTests(onLine) -> Promise<results>, setPreviewCar(bodyId, accent),
//   skipReplay(), resetBall(), getStats()
export function createUI({ root, api }) {
  root.innerHTML = `<div id="stub-menu" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;font:20px sans-serif;color:#fff;background:rgba(0,0,0,.5)">
  <h1>TURBO PITCH</h1><button id="b1">1v1 vs bot</button><button id="b2">Free play</button></div>
  <div id="stub-hud" style="position:absolute;top:8px;left:50%;transform:translateX(-50%);font:24px monospace;color:#fff"></div>`;
  const menu = root.querySelector('#stub-menu'), hud = root.querySelector('#stub-hud');
  root.querySelector('#b1').onclick = () => api.startMatch({ teamSize: 1, difficulty: 'pro', playerTeam: 0 });
  root.querySelector('#b2').onclick = () => api.startFreePlay({});
  return {
    update(view) { const m = view.match; if (m) { const c = Math.ceil(m.clockSec); hud.textContent = `${m.scores[0]}  ${Math.floor(c / 60)}:${String(c % 60).padStart(2, '0')}  ${m.scores[1]}`; } },
    onEvents() {}, showMainMenu() { menu.style.display = 'flex'; }, showPause() { menu.style.display = 'flex'; }, hideMenus() { menu.style.display = 'none'; },
    showEndScreen() { menu.style.display = 'flex'; }, isMenuOpen() { return menu.style.display !== 'none'; }, setDebug() {}, dispose() {},
  };
}
