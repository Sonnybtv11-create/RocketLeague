// OWNER: UI agent.
// createUI({ root, api, settings, stats }) -> {
//   update(view, frameDt, info), onEvents(events, view), showMainMenu(), showPause(), hideMenus(),
//   showEndScreen(matchView), showScoreboard(bool), isMenuOpen(), setDebug(on), dispose() }
// info = { fps, playerCarId, tick, ballCam, inputDevice, mode ('menu'|'exhibition'|'freeplay'), paused, playerCar, world }
//
// Modules: style.js (CSS, injected once), hud.js (in-match HUD + Tab scoreboard), menus.js (main / play /
// free play / garage / settings / bindings / controls help / stats / pause / end screen), nav.js (keyboard &
// gamepad menu navigation), debug.js (F3 overlay + FPS counter), scoreboard.js, dom.js (helpers).
// window.__tpUI exposes this instance for automation (screenshot scripts), like window.__game.
import { CSS } from './style.js';
import { createHUD } from './hud.js';
import { createMenus } from './menus.js';
import { createDebug } from './debug.js';
import { setShown } from './dom.js';

export function createUI({ root, api, settings, stats }) {
  let styleEl = document.getElementById('tp-ui-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'tp-ui-style';
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }
  root.innerHTML = '';
  root.classList.add('tp-root');

  const hud = createHUD({ api, settings });
  const menus = createMenus({ api, settings, stats, onOpenChange: () => {} });
  const debug = createDebug({ api });
  root.append(hud.el, menus.el, debug.el, debug.fpsEl);

  let mode = 'menu';
  let endShown = false;

  const ui = {
    update(view, dt, info) {
      mode = info.mode;
      const inGame = info.mode !== 'menu' && !!view;
      const ctx = menus.context();
      // HUD visible in matches; hidden behind the full-screen end screen
      const showHud = inGame && ctx !== 'end' && ctx !== 'main';
      setShown(hud.el, showHud);
      if (showHud) hud.update(view, dt, info);
      menus.update(dt, info);
      debug.update(view, dt, info, !!settings.graphics.showFps);
    },
    onEvents(events, view) {
      if (mode === 'menu') return;
      hud.onEvents(events, view);
    },
    showMainMenu() {
      endShown = false;
      hud.clearTransient();
      hud.setScoreboard(false);
      menus.showMain();
    },
    showPause() { hud.setScoreboard(false); menus.showPause(); },
    hideMenus() {
      if (endShown) hud.clearTransient();
      endShown = false;
      menus.hide();
    },
    showEndScreen(matchView) {
      endShown = true;
      hud.setScoreboard(false);
      menus.showEnd(matchView);
    },
    showScoreboard(on) {
      if (menus.isOpen() && on) return;
      hud.setScoreboard(!!on);
    },
    isMenuOpen() { return menus.isOpen(); },
    // Optional hook for main's pause/Esc handling: true = the UI consumed it (closed a sub-menu or a rebind prompt).
    handleBack() { return menus.handleBack(); },
    setDebug(on) { debug.setOn(on); root.classList.toggle('dbg', !!on); },
    dispose() {
      menus.dispose();
      root.innerHTML = '';
      root.classList.remove('tp-root');
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      if (window.__tpUI === ui) delete window.__tpUI;
    },
  };
  window.__tpUI = ui;
  return ui;
}
