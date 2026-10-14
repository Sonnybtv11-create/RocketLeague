// TURBO PITCH — input (camera & input agent).
// createInput({ canvas, settings, onAction }) -> {
//   poll(now), sampleTick() -> Controls, getLook() -> {x,y}, isBallCam(), setEnabled(bool),
//   startRebind(action, 'kb'|'pad', cb(code|null)), cancelRebind(), resetBallCam(), lastDevice, dispose() }
//   Mouse free-look: hold settings.bindings.kb.freeLook (default middle mouse, 'Mouse1') and move.
//
// Thin DOM layer over the pure, unit-tested core in ./core.js:
//   * keyboard + mouse buttons -> timestamped edges (performance.now() at dispatch)
//   * gamepad polled once per frame in poll() AND on every sampleTick() so 120 Hz
//     sampling sees the latest state
//   * optional mouse air pitch/yaw with pointer lock (settings.controls.mouseAirPitch)
//   * context menu blocked on the canvas; Space / arrows / Tab / F3 don't scroll or
//     move focus while playing; everything is released on blur / tab hide
import { createInputCore } from './core.js';

const GAME_KEYS_PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F3', 'Backspace']);
const MOUSE_CODES = ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4'];

function isTextField(el) {
  if (!el || !el.tagName) return false;
  const t = el.tagName;
  if (t === 'TEXTAREA' || t === 'SELECT') return true;
  if (t === 'INPUT') {
    const ty = (el.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(ty);
  }
  return !!el.isContentEditable;
}

// Snapshot the most relevant connected gamepad into a plain object the core understands.
// Prefers 'standard' mapping pads; Safari / some drivers report '' mapping, which we still
// read with the standard indices (missing buttons/axes read as 0).
let _lastPadIndex = -1;
function readGamepad() {
  let pads;
  try { pads = (typeof navigator !== 'undefined' && navigator.getGamepads) ? navigator.getGamepads() : null; } catch (e) { pads = null; }
  if (!pads) return null;
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p || p.connected === false) continue;
    let score = (p.mapping === 'standard' ? 2 : 0) + (i === _lastPadIndex ? 1 : 0);
    // prefer a pad with live input
    if (p.buttons) for (const b of p.buttons) if (b && (b.pressed || b.value > 0.5)) { score += 4; break; }
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (!best) return null;
  _lastPadIndex = best.index;
  return { buttons: best.buttons ? Array.from(best.buttons) : [], axes: best.axes ? Array.from(best.axes) : [], mapping: best.mapping };
}

export function createInput({ canvas, settings, onAction }) {
  const core = createInputCore({ settings, onAction });
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const target = typeof window !== 'undefined' ? window : null;
  let enabled = true;
  let lockRequested = false;
  let disposed = false;
  const listeners = [];
  const on = (el, ev, fn, opt) => { if (!el) return; el.addEventListener(ev, fn, opt); listeners.push([el, ev, fn, opt]); };

  const pointerLocked = () => typeof document !== 'undefined' && document.pointerLockElement === canvas;

  // ---------------------------------------------------------------- keyboard
  on(target, 'keydown', (e) => {
    if (isTextField(e.target) && !core.isRebinding()) return;
    const rebinding = core.isRebinding();
    const used = core.keyEvent(e.code, true, now());
    if (rebinding || e.code === 'F3' || (enabled && (used || GAME_KEYS_PREVENT.has(e.code)))) e.preventDefault();
  }, { capture: true });
  on(target, 'keyup', (e) => {
    core.keyEvent(e.code, false, now());
    if (enabled && GAME_KEYS_PREVENT.has(e.code) && !isTextField(e.target)) e.preventDefault();
  }, { capture: true });

  // ---------------------------------------------------------------- mouse
  on(target, 'mousedown', (e) => {
    const code = MOUSE_CODES[e.button];
    if (!code) return;
    if (core.isRebinding()) {
      if (core.rebindDevice() === 'kb') { core.keyEvent(code, true, now()); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    // only clicks that land on the game canvas (HUD is pointer-events:none) or while locked
    if (e.target !== canvas && !pointerLocked()) return;
    core.keyEvent(code, true, now());
    if (e.button === 1) e.preventDefault(); // middle button (free-look): no autoscroll
    if (enabled && settings.controls && settings.controls.mouseAirPitch && !pointerLocked() && canvas.requestPointerLock) {
      try { lockRequested = true; const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => { lockRequested = false; }); } catch (err) { lockRequested = false; }
    }
    if (canvas && canvas.focus) { try { canvas.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }
  }, { capture: true });
  on(target, 'mouseup', (e) => {
    const code = MOUSE_CODES[e.button];
    if (code) core.keyEvent(code, false, now());
  }, { capture: true });
  on(target, 'mousemove', (e) => {
    if (!enabled) return;
    if (core.isFreeLookHeld()) { core.mouseLook(e.movementX || 0); return; } // free-look owns the mouse while held
    if (!pointerLocked()) return;
    core.mouseMove(e.movementX || 0, e.movementY || 0);
  });
  on(canvas, 'contextmenu', (e) => e.preventDefault());
  on(target, 'contextmenu', (e) => { if (e.target === canvas || pointerLocked()) e.preventDefault(); });
  // mouse buttons 3/4 (back/forward) would navigate away when bound
  on(target, 'auxclick', (e) => { if (e.target === canvas) e.preventDefault(); });

  if (typeof document !== 'undefined') {
    on(document, 'pointerlockchange', () => {
      if (pointerLocked()) { lockRequested = false; return; }
      // lock lost while playing (Esc is swallowed by the browser) -> pause like a native game
      if (enabled && !disposed && settings.controls && settings.controls.mouseAirPitch && !lockRequested) {
        core.releaseAll(now());
        if (onAction) onAction('pause', true);
      }
      lockRequested = false;
    });
    on(document, 'pointerlockerror', () => { lockRequested = false; });
    on(document, 'visibilitychange', () => { if (document.hidden) core.releaseAll(now()); });
  }
  on(target, 'blur', () => core.releaseAll(now()));

  // ---------------------------------------------------------------- gamepad
  const pollPad = () => core.setPad(readGamepad());

  return {
    poll(t) {
      core.beginFrame(now());
      pollPad();
      void t;
    },
    sampleTick() {
      pollPad();
      return core.sampleTick();
    },
    getLook() { return core.getLook(); },
    isBallCam() { return core.isBallCam(); },
    resetBallCam() { return core.resetBallCam(); },
    setEnabled(b) {
      enabled = !!b;
      core.setEnabled(enabled);
      if (!enabled && pointerLocked() && document.exitPointerLock) { lockRequested = true; try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
    },
    startRebind(action, device, cb) { core.startRebind(action, device, cb); },
    cancelRebind() { core.cancelRebind(); },
    get lastDevice() { return core.lastDevice; },
    core,
    dispose() {
      disposed = true;
      for (const [el, ev, fn, opt] of listeners) el.removeEventListener(ev, fn, opt);
      listeners.length = 0;
      if (pointerLocked() && document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
    },
  };
}
