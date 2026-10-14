// Node unit tests for the DOM-free input core (tick-accurate sampling, bindings, gamepad).
// Run: node --test src/input/tests/core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputCore, deadzone1, deadzone2, readPadBinding, TICK_MS } from '../core.js';
import { DEFAULT_SETTINGS } from '../../game/settings.js';

const fresh = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
function mk(over = {}) {
  const settings = fresh();
  Object.assign(settings.controls, over.controls || {});
  Object.assign(settings.camera, over.camera || {});
  const actions = [];
  const core = createInputCore({ settings, onAction: (n, d) => actions.push([n, d]) });
  return { core, settings, actions };
}
// Simulate a frame at time `now` that runs `n` physics ticks; returns the sampled controls.
function frame(core, now, n) {
  core.beginFrame(now);
  const out = [];
  for (let i = 0; i < n; i++) out.push(core.sampleTick());
  return out;
}
const pad = (o = {}) => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  for (const [i, v] of Object.entries(o.buttons || {})) buttons[i] = { pressed: v > 0.5, value: v };
  const axes = [0, 0, 0, 0];
  for (const [i, v] of Object.entries(o.axes || {})) axes[i] = v;
  return { buttons, axes, mapping: 'standard' };
};

test('(a) tap shorter than a tick is never lost', () => {
  const { core } = mk();
  frame(core, 1000, 2);
  // press + release (5 ms apart) between two ticks
  core.keyEvent('Mouse2', true, 1001);
  core.keyEvent('Mouse2', false, 1003);
  const [t1, t2] = frame(core, 1016.6, 2);
  assert.equal(t1.jump, true, 'first tick after the press sees jump');
  assert.equal(t2.jump, false, 'released afterwards');
  const [t3] = frame(core, 1025, 1);
  assert.equal(t3.jump, false);
});

test('(a2) tap within one frame that spans several ticks lands on the right tick', () => {
  const { core } = mk();
  frame(core, 1000, 0); // sim in sync with real time at t=1000
  // frame covers ticks at vt=1008.3, 1016.7, 1025; tap happens at 1010..1012 -> tick 2
  core.keyEvent('Mouse2', true, 1010);
  core.keyEvent('Mouse2', false, 1012);
  const r = frame(core, 1025, 3);
  assert.deepEqual(r.map((c) => c.jump), [false, true, false]);
});

test('(b) held jump stays true across ticks (variable jump height)', () => {
  const { core } = mk();
  frame(core, 1000, 1);
  core.keyEvent('Mouse2', true, 1001);
  const seq = [];
  let now = 1001;
  for (let f = 0; f < 15; f++) { now += 16.667; seq.push(...frame(core, now, 2).map((c) => c.jump)); }
  assert.ok(seq.every(Boolean), 'all ticks true while held');
  core.keyEvent('Mouse2', false, now + 1);
  const after = frame(core, now + 17, 2).map((c) => c.jump);
  assert.deepEqual(after, [false, false]);
});

test('(b2) hold duration maps onto exactly the ticks it was held', () => {
  const { core } = mk();
  frame(core, 1000, 0); // sim in sync at t=1000
  core.keyEvent('Mouse2', true, 1001);   // before tick @1008.3
  core.keyEvent('Mouse2', false, 1030);  // after tick @1025, before @1033.3
  const r = frame(core, 1050, 6).map((c) => c.jump); // vt: 1008.3 1016.7 1025 1033.3 1041.7 1050
  assert.deepEqual(r, [true, true, true, false, false, false]);
});

test('(c) release + re-press between ticks gives false then true (double jump / dodge)', () => {
  const { core } = mk();
  frame(core, 1000, 1);
  core.keyEvent('Mouse2', true, 1001);
  assert.deepEqual(frame(core, 1008.4, 1).map((c) => c.jump), [true]);
  // release and press again before the next tick
  core.keyEvent('Mouse2', false, 1009);
  core.keyEvent('Mouse2', true, 1011);
  const r = frame(core, 1016.8, 1).concat(frame(core, 1025.2, 1)).map((c) => c.jump);
  assert.deepEqual(r, [false, true]);
});

test('(c2) two complete taps inside one tick window both register', () => {
  const { core } = mk();
  frame(core, 1000, 1);
  core.keyEvent('Mouse2', true, 1001); core.keyEvent('Mouse2', false, 1002);
  core.keyEvent('Mouse2', true, 1003); core.keyEvent('Mouse2', false, 1004);
  const r = [];
  let now = 1008.4;
  for (let i = 0; i < 5; i++) { r.push(frame(core, now, 1)[0].jump); now += TICK_MS; }
  assert.deepEqual(r, [true, false, true, false, false]);
});

test('boost taps are buffered the same way', () => {
  const { core } = mk();
  frame(core, 1000, 1);
  core.keyEvent('Mouse0', true, 1001); core.keyEvent('Mouse0', false, 1002);
  const r = frame(core, 1020, 2).map((c) => c.boost);
  assert.deepEqual(r, [true, false]);
});

test('zero ticks in a frame: input waits for the next tick', () => {
  const { core } = mk();
  frame(core, 1000, 1);
  core.keyEvent('Mouse2', true, 1001); core.keyEvent('Mouse2', false, 1002);
  frame(core, 1004, 0); // 240 Hz display, no tick this frame
  const r = frame(core, 1009, 1).map((c) => c.jump);
  assert.deepEqual(r, [true]);
});

test('keyboard driving, free air roll, directional roll', () => {
  const { core } = mk();
  frame(core, 1000, 1);
  core.keyEvent('KeyW', true, 1001);
  core.keyEvent('KeyD', true, 1001);
  let c = frame(core, 1010, 1)[0];
  assert.equal(c.throttle, 1); assert.equal(c.steer, 1); assert.equal(c.yaw, 1); assert.equal(c.roll, 0);
  assert.equal(c.pitch, -1, 'W pitches the nose down in the air (RL KB default)');
  core.keyEvent('ShiftLeft', true, 1011);
  c = frame(core, 1020, 1)[0];
  assert.equal(c.handbrake, true); assert.equal(c.yaw, 0); assert.equal(c.roll, 1, 'air roll held: D rolls right');
  core.keyEvent('ShiftLeft', false, 1021); core.keyEvent('KeyD', false, 1021);
  core.keyEvent('KeyQ', true, 1022);
  c = frame(core, 1030, 1)[0];
  assert.equal(c.roll, -1); assert.equal(c.yaw, 0);
  core.keyEvent('ArrowDown', true, 1031);
  core.keyEvent('KeyW', false, 1031);
  c = frame(core, 1040, 1)[0];
  assert.equal(c.pitch, 1, 'ArrowDown = nose up');
});

test('setEnabled(false): neutral controls, pause still fires, no buffered press leaks on resume', () => {
  const { core, actions } = mk();
  frame(core, 1000, 1);
  core.setEnabled(false);
  core.keyEvent('Mouse2', true, 1001); core.keyEvent('Mouse2', false, 1002);
  core.keyEvent('KeyW', true, 1003);
  core.keyEvent('Escape', true, 1004);
  const c = frame(core, 1010, 1)[0];
  assert.equal(c.jump, false); assert.equal(c.throttle, 0);
  assert.ok(actions.some(([n]) => n === 'pause'));
  core.setEnabled(true);
  const c2 = frame(core, 1020, 1)[0];
  assert.equal(c2.jump, false, 'tap during menu does not fire after resume');
  assert.equal(c2.throttle, 1, 'still-held key works after resume');
});

test('UI actions: ball cam toggle/hold, reset, scoreboard, F3, key repeat ignored', () => {
  const { core, actions, settings } = mk();
  assert.equal(core.isBallCam(), true);
  core.keyEvent('Space', true, 1); core.keyEvent('Space', true, 2); core.keyEvent('Space', false, 3);
  assert.equal(core.isBallCam(), false, 'toggle once (repeat ignored)');
  settings.camera.ballCamMode = 'hold';
  core.keyEvent('Space', true, 4); assert.equal(core.isBallCam(), true);
  core.keyEvent('Space', false, 5); assert.equal(core.isBallCam(), false);
  core.keyEvent('KeyR', true, 6); core.keyEvent('Tab', true, 7); core.keyEvent('Tab', false, 8); core.keyEvent('F3', true, 9);
  const names = actions.map((a) => a.join(':'));
  assert.ok(names.includes('resetBall:true'));
  assert.ok(names.includes('scoreboard:true') && names.includes('scoreboard:false'));
  assert.ok(names.includes('debug:true'));
});

test('jump press emits skipReplay', () => {
  const { core, actions } = mk();
  core.keyEvent('Mouse2', true, 1);
  core.setPad(pad({ buttons: { 0: 1 } }));
  assert.equal(actions.filter(([n]) => n === 'skipReplay').length, 2);
});

test('rebinding kb: next key is captured, Esc cancels without pausing', () => {
  const { core, settings, actions } = mk();
  let got;
  core.startRebind('jump', 'kb', (c) => { got = c; });
  core.keyEvent('KeyK', true, 1);
  assert.equal(got, 'KeyK');
  assert.deepEqual(settings.bindings.kb.jump, ['KeyK']);
  core.keyEvent('KeyK', false, 2);
  core.startRebind('boost', 'kb', (c) => { got = c; });
  core.keyEvent('Escape', true, 3);
  assert.equal(got, null);
  assert.ok(!actions.some(([n]) => n === 'pause'), 'Esc during capture does not pause');
  frame(core, 10, 1);
  core.keyEvent('KeyK', true, 11);
  assert.equal(frame(core, 20, 1)[0].jump, true, 'new binding works');
});

test('rebinding pad: button and axis capture', () => {
  const { core, settings } = mk();
  let got;
  core.startRebind('boost', 'pad', (c) => { got = c; });
  core.setPad(pad({ buttons: { 0: 1 } })); // baseline: A already held -> ignored
  core.setPad(pad({ buttons: { 0: 1 } }));
  assert.equal(got, undefined);
  core.setPad(pad({ buttons: { 0: 1, 5: 1 } }));
  assert.equal(got, 'b5'); assert.equal(settings.bindings.pad.boost, 'b5');
  core.startRebind('lookX', 'pad', (c) => { got = c; });
  core.setPad(pad());
  core.setPad(pad({ buttons: { 3: 1 } })); // buttons don't bind axis actions
  core.setPad(pad({ axes: { 2: -0.9 } }));
  assert.equal(got, 'a2');
});

test('gamepad: triggers, stick deadzone + sensitivity, X = air roll, pitch sign, invert', () => {
  const { core, settings } = mk();
  frame(core, 1000, 1);
  core.setPad(pad({ buttons: { 7: 0.6 }, axes: { 0: 0.6, 1: 0.1 } }));
  let c = frame(core, 1010, 1)[0];
  assert.ok(Math.abs(c.throttle - 0.6) < 1e-9);
  assert.ok(Math.abs(c.steer - 0.5) < 1e-9, 'cross deadzone 0.2 rescales 0.6 -> 0.5');
  assert.equal(c.pitch, 0, 'inside deadzone');
  core.setPad(pad({ axes: { 1: 1 } }));
  c = frame(core, 1020, 1)[0];
  assert.equal(c.pitch, 1, 'stick pulled back = nose up');
  settings.controls.invertPitch = true;
  c = frame(core, 1030, 1)[0];
  assert.equal(c.pitch, -1);
  settings.controls.invertPitch = false;
  settings.controls.aerialSensitivity = 1.5;
  settings.controls.steeringSensitivity = 1.5;
  core.setPad(pad({ buttons: { 2: 1 }, axes: { 0: 0.8 } }));
  c = frame(core, 1040, 1)[0];
  assert.equal(c.handbrake, true); assert.equal(c.yaw, 0); assert.equal(c.roll, 1, 'clamped to 1');
  assert.equal(c.steer, 1);
  core.setPad(pad({ buttons: { 6: 1 } }));
  c = frame(core, 1050, 1)[0];
  assert.equal(c.throttle, -1, 'LT reverse');
  assert.equal(core.lastDevice, 'pad');
  core.keyEvent('KeyW', true, 1051);
  assert.equal(core.lastDevice, 'kb');
});

test('gamepad press+release between two polls still works via pending queue', () => {
  const { core } = mk();
  frame(core, 1000, 1);
  core.setPad(pad({ buttons: { 0: 1 } }));
  core.setPad(pad());
  const r = frame(core, 1017, 2).map((c) => c.jump);
  assert.deepEqual(r, [true, false]);
});

test('look stick and invert swivel', () => {
  const { core, settings } = mk();
  core.setPad(pad({ axes: { 2: 1, 3: -1 } }));
  assert.deepEqual(core.getLook(), { x: 1, y: -1 });
  settings.camera.invertSwivel = true;
  assert.deepEqual(core.getLook(), { x: -1, y: -1 });
});

test('deadzone helpers', () => {
  assert.equal(deadzone1(0.1, 0.2), 0);
  assert.equal(deadzone1(1, 0.2), 1);
  assert.ok(Math.abs(deadzone1(-0.6, 0.2) + 0.5) < 1e-12);
  const [x, y] = deadzone2(0.15, 0.15, 0.2, 'radial'); // |v| = 0.212 > 0.2
  assert.ok(x > 0 && y > 0 && x < 0.05);
  assert.deepEqual(deadzone2(0.15, 0.15, 0.2, 'cross'), [0, 0]);
  assert.equal(readPadBinding(pad({ axes: { 2: -0.7 } }), 'a2-'), 0.7);
  assert.equal(readPadBinding(pad({ axes: { 2: -0.7 } }), 'a2+'), 0);
  assert.equal(readPadBinding({ buttons: [] }, 'b7'), 0, 'missing button -> 0 (Safari non-standard pads)');
  assert.equal(readPadBinding(null, 'b0'), 0);
});

test('mouse air pitch: deltas map to pitch/yaw and decay to 0', () => {
  const { core, settings } = mk();
  settings.controls.mouseAirPitch = true;
  frame(core, 1000, 1);
  core.mouseMove(40, -40);
  let c = frame(core, 1009, 1)[0];
  assert.ok(c.pitch > 0.3 && c.yaw > 0.3, 'mouse up = nose up, right = yaw right');
  let now = 1009;
  for (let i = 0; i < 60; i++) { now += TICK_MS; c = frame(core, now, 1)[0]; }
  assert.equal(c.pitch, 0); assert.equal(c.yaw, 0);
});

test('releaseAll (blur) releases held keys and scoreboard', () => {
  const { core, actions } = mk();
  frame(core, 1000, 1);
  core.keyEvent('KeyW', true, 1001); core.keyEvent('Tab', true, 1001);
  assert.equal(frame(core, 1010, 1)[0].throttle, 1);
  core.releaseAll(1011);
  assert.equal(frame(core, 1020, 1)[0].throttle, 0);
  assert.ok(actions.some(([n, d]) => n === 'scoreboard' && d === false));
});

test('mouse free-look: hold middle mouse + move swivels, release recentres, no effect on controls', () => {
  const { core, settings } = mk();
  frame(core, 1000, 1);
  core.mouseLook(300); // not held: ignored
  assert.deepEqual(core.getLook(), { x: 0, y: 0 });
  core.keyEvent('Mouse1', true, 1001);
  core.mouseLook(262); // 262 px * 0.006 = ~90 deg right
  let l = core.getLook();
  assert.ok(l.x > 0.99 && Math.abs(l.y) < 0.05, `look right ${JSON.stringify(l)}`);
  core.mouseLook(1000); // clamps at looking straight back
  l = core.getLook();
  assert.ok(Math.abs(l.x) < 1e-9 && l.y > 0.99, 'clamped to behind');
  const c = frame(core, 1010, 1)[0];
  assert.equal(c.yaw, 0); assert.equal(c.pitch, 0); assert.equal(c.boost, false); assert.equal(c.jump, false);
  core.keyEvent('Mouse1', false, 1011);
  assert.deepEqual(core.getLook(), { x: 0, y: 0 }, 'released -> recentred');
  settings.bindings.kb.freeLook = ['KeyF']; // rebindable
  core.keyEvent('Mouse1', true, 1012); core.mouseLook(100);
  assert.deepEqual(core.getLook(), { x: 0, y: 0 });
  core.keyEvent('Mouse1', false, 1013);
  core.keyEvent('KeyF', true, 1014); core.mouseLook(-100);
  assert.ok(core.getLook().x < 0, 'KeyF free-look, mouse left = look left');
});

test('resetBallCam re-applies settings.camera.ballCamDefault', () => {
  const { core, settings } = mk();
  core.keyEvent('Space', true, 1); core.keyEvent('Space', false, 2);
  assert.equal(core.isBallCam(), false);
  assert.equal(core.resetBallCam(), true);
  assert.equal(core.isBallCam(), true);
  settings.camera.ballCamDefault = false;
  core.resetBallCam();
  assert.equal(core.isBallCam(), false);
});

test("deadzone shape 'circle' is an alias of 'radial'", () => {
  assert.deepEqual(deadzone2(0.15, 0.15, 0.2, 'circle'), deadzone2(0.15, 0.15, 0.2, 'radial'));
  assert.notDeepEqual(deadzone2(0.15, 0.15, 0.2, 'circle'), [0, 0]);
});
