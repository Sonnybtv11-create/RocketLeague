// OWNER: Camera & input agent. STUB.
// createInput({ canvas, settings, onAction }) -> {
//   poll(), sampleTick() -> Controls, getLook() -> {x,y}, isBallCam(), setEnabled(bool),
//   startRebind(action, device, cb), lastDevice, dispose() }
import { makeControls } from '../contracts.js';
export function createInput({ canvas, settings, onAction }) {
  const keys = new Set(); let jumpQueued = false; let enabled = true; let ballCam = true;
  addEventListener('keydown', (e) => { if (!keys.has(e.code) && e.code === 'Space') { ballCam = !ballCam; } keys.add(e.code); if (e.code === 'Escape') onAction && onAction('pause'); if (e.code === 'KeyJ' || e.code === 'KeyK') jumpQueued = true; });
  addEventListener('keyup', (e) => keys.delete(e.code));
  return {
    poll() {},
    sampleTick() {
      const c = makeControls();
      if (!enabled) return c;
      c.throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      c.steer = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      c.yaw = c.steer; c.pitch = (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0);
      c.jump = keys.has('KeyJ') || keys.has('KeyK') || jumpQueued; jumpQueued = false;
      c.boost = keys.has('KeyL'); c.handbrake = keys.has('ShiftLeft');
      return c;
    },
    getLook() { return { x: 0, y: 0 }; },
    isBallCam() { return ballCam; },
    setEnabled(v) { enabled = v; },
    startRebind() {}, lastDevice: 'kb', dispose() {},
  };
}
