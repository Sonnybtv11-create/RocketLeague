// TURBO PITCH — input core (camera & input agent).
// Pure, DOM-free logic so it can be unit-tested in Node (see src/input/tests/core.test.mjs).
//
// Responsibilities:
//   * resolve keyboard/mouse codes and gamepad buttons/axes to actions via settings.bindings
//   * TICK-ACCURATE SAMPLING. Keyboard/mouse edges arrive asynchronously with timestamps.
//     The physics runs at 120 Hz in bursts inside each animation frame, so every
//     sampleTick() is mapped onto a *virtual tick time* (vt) that advances 1/120 s per
//     call and is clamped to the time of the last beginFrame(now). Only edges with
//     t <= vt are applied before a tick is sampled, so a key is held for (to tick
//     resolution) exactly the ticks it was physically held.
//     On top of that, every digital action keeps a short queue of the states it went
//     through since the last sample. Each tick consumes one queued state, so
//       (a) a tap that starts and ends between two ticks still yields `true` for one tick,
//       (b) a held key stays `true` on every tick,
//       (c) release + re-press between two ticks yields false then true on consecutive
//           ticks (double-jump / dodge taps always register).
//   * gamepad: radial / cross deadzone with rescale, steering / aerial sensitivity,
//     invert pitch, free air roll (powerslide held -> yaw becomes roll), right-stick look
//   * mouse air pitch/yaw: movement deltas feed a decaying virtual stick
//   * UI actions (pause, resetBall, scoreboard, ballCam, debug, skipReplay) fire immediately
//   * rebinding capture
//
// Controls produced match contracts.makeControls():
//   throttle, steer, pitch (+ = nose up), yaw (+ = right), roll (+ = roll right),
//   jump, boost, handbrake, ballCam.

export const TICK_MS = 1000 / 120;

// actions that feed the sim and are tick-buffered
export const CONTROL_ACTIONS = ['throttle', 'reverse', 'steerLeft', 'steerRight', 'pitchUp', 'pitchDown',
  'yawLeft', 'yawRight', 'jump', 'boost', 'powerslide', 'airRollLeft', 'airRollRight'];
// actions forwarded to onAction immediately
export const UI_ACTIONS = ['ballCam', 'resetBall', 'scoreboard', 'pause', 'debug', 'freeLook'];
// Mouse free-look: hold this binding (default middle mouse button) and move the mouse to swivel
// the car camera around the car (spec §7). Works without pointer lock and never touches the
// car controls, so it does not interfere with mouse air pitch being off (or on).
export const DEFAULT_FREELOOK_BINDING = ['Mouse1'];
// gamepad bindings that are axes rather than buttons
export const PAD_AXIS_ACTIONS = ['steerAxis', 'pitchAxis', 'lookX', 'lookY'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function neutralControls(ballCam) {
  return { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false, ballCam: !!ballCam };
}

// ---- deadzone helpers (exported for tests) ---------------------------------
export function deadzone1(v, dz) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * Math.min((a - dz) / (1 - dz), 1);
}
// 2D stick deadzone. shape 'cross' = per-axis (RL's default feel), 'radial' = circular.
export function deadzone2(x, y, dz, shape) {
  if (shape === 'radial' || shape === 'circle') { // UI writes 'circle'
    const m = Math.hypot(x, y);
    if (m <= dz) return [0, 0];
    const s = Math.min((m - dz) / (1 - dz), 1) / m;
    return [clamp(x * s, -1, 1), clamp(y * s, -1, 1)];
  }
  return [deadzone1(x, dz), deadzone1(y, dz)];
}

// ---- gamepad binding parsing -----------------------------------------------
// 'b7' -> button 7 (value 0..1); 'a2' -> axis 2 (-1..1); 'a2+' / 'a2-' -> half axis as 0..1
export function readPadBinding(pad, bind) {
  if (!pad || !bind || typeof bind !== 'string') return 0;
  const kind = bind[0];
  const m = /^[ab](\d+)([+-]?)$/.exec(bind);
  if (!m) return 0;
  const idx = Number(m[1]);
  if (kind === 'b') {
    const b = pad.buttons && pad.buttons[idx];
    if (b === undefined || b === null) return 0;
    if (typeof b === 'number') return b;
    const v = typeof b.value === 'number' ? b.value : 0;
    // some non-standard pads report pressed=true with value 0
    return b.pressed && v <= 0 ? 1 : v;
  }
  const a = pad.axes && pad.axes[idx];
  if (typeof a !== 'number' || !isFinite(a)) return 0;
  if (m[2] === '+') return Math.max(a, 0);
  if (m[2] === '-') return Math.max(-a, 0);
  return a;
}

// ---- the core ------------------------------------------------------------------
export function createInputCore({ settings, onAction } = {}) {
  const fire = (name, down = true) => { if (onAction) { try { onAction(name, down); } catch (e) { /* caller errors must not break input */ if (typeof console !== 'undefined') console.error(e); } } };

  let enabled = true;
  let ballCam = settings && settings.camera ? settings.camera.ballCamDefault !== false : true;
  let ballCamHeld = false;
  let lastDevice = 'kb';
  let frameNow = 0;          // time of the last beginFrame()
  let vt = 0;                // virtual time of the last sampled tick
  const queue = [];          // pending raw kb/mouse edges {t, code, down}
  const kbHeld = new Set();  // codes held as of vt
  const kbRaw = new Set();   // codes held right now (latest events), for UI repeat filtering

  // per control action: buffered state machine
  const act = {};
  for (const a of CONTROL_ACTIONS) act[a] = { kb: false, pad: 0, state: false, pending: [], out: false };

  // gamepad snapshot
  let pad = null;
  let padPrevUI = {};        // ui action -> bool (for edge detection)
  let padPrevJump = false;
  let padLook = { x: 0, y: 0 };
  let padAnalog = { steer: 0, pitch: 0, throttle: 0, reverse: 0 };

  // mouse virtual stick
  let mouseAccX = 0, mouseAccY = 0, mouseX = 0, mouseY = 0;
  // mouse free-look: held flag + accumulated swivel angle (rad, + = look right)
  let freeLookHeld = false, lookAngle = 0;

  // rebind capture
  let rebind = null; // {action, device, cb, padBaseline}

  const kbBind = () => (settings && settings.bindings && settings.bindings.kb) || {};
  const padBind = () => (settings && settings.bindings && settings.bindings.pad) || {};
  const ctl = () => (settings && settings.controls) || {};

  function actionsForCode(code) {
    const out = [];
    const kb = kbBind();
    for (const k of Object.keys(kb)) {
      const v = kb[k];
      if (Array.isArray(v) ? v.includes(code) : v === code) out.push(k);
    }
    if (kb.freeLook === undefined && DEFAULT_FREELOOK_BINDING.includes(code)) out.push('freeLook');
    return out;
  }

  // push a new combined state for a control action into its queue
  // Invariant: the last queued state (or `out` when the queue is empty) equals `state`,
  // so every real change is appended and taps / re-presses are never merged away.
  function setState(name, s) {
    const a = act[name];
    if (s === a.state) return;
    a.state = s;
    a.pending.push(s);
    // bound the queue (pathological mashing): drop complete press/release cycles from the front
    while (a.pending.length > 4) a.pending.splice(0, 2);
  }
  function recomputeAction(name) {
    const a = act[name];
    setState(name, a.kb || a.pad > 0.5);
  }

  function applyKbEdge(code, down) {
    if (down) kbHeld.add(code); else kbHeld.delete(code);
    for (const name of actionsForCode(code)) {
      if (!act[name]) continue;
      const codes = kbBind()[name] || [];
      act[name].kb = (Array.isArray(codes) ? codes : [codes]).some((c) => kbHeld.has(c));
      recomputeAction(name);
    }
  }

  // ---------------------------------------------------------------- events
  // Keyboard / mouse-button edge. code = KeyboardEvent.code or 'Mouse0..2'. Returns
  // true when the event was consumed by the game (caller may preventDefault).
  function keyEvent(code, down, t) {
    lastDevice = 'kb';
    if (rebind && rebind.device === 'kb') {
      if (!down) return true;
      if (code === 'Escape') { cancelRebind(); return true; }
      const r = rebind; rebind = null;
      const kb = settings.bindings.kb;
      kb[r.action] = [code];
      if (r.cb) r.cb(code);
      // the captured key must not act in-game until released
      kbRaw.add(code);
      return true;
    }
    if (rebind && rebind.device === 'pad' && down && code === 'Escape') { cancelRebind(); return true; }
    const wasDown = kbRaw.has(code);
    if (down) kbRaw.add(code); else kbRaw.delete(code);
    const repeat = down && wasDown;
    // UI actions fire immediately (not tick-synchronised)
    const names = actionsForCode(code);
    let used = names.length > 0;
    if (!repeat) {
      for (const n of names) uiEdge(n, down);
      if (code === 'F3' && !names.includes('debug') && down) { fire('debug', true); used = true; }
    }
    if (!repeat && names.some((n) => act[n])) {
      queue.push({ t, code, down });
      if (down && names.includes('jump')) fire('skipReplay', true);
    }
    return used;
  }

  function uiEdge(name, down) {
    switch (name) {
      case 'pause': if (down) fire('pause', true); break;
      case 'resetBall': if (down && enabled) fire('resetBall', true); break;
      case 'debug': if (down) fire('debug', true); break;
      case 'scoreboard': if (enabled || !down) fire('scoreboard', down); break;
      case 'ballCam': if (enabled || !down) ballCamInput(down); break;
      case 'freeLook':
        freeLookHeld = down && enabled;
        if (!down) lookAngle = 0; // released -> camera swings back behind the car
        break;
      default: break;
    }
  }

  function ballCamInput(down) {
    const mode = (settings && settings.camera && settings.camera.ballCamMode) || 'toggle';
    if (mode === 'hold') {
      if (ballCamHeld === down) return;
      ballCamHeld = down;
      ballCam = !ballCam;
      fire('ballCam', ballCam);
    } else if (down) {
      ballCam = !ballCam;
      fire('ballCam', ballCam);
    }
  }

  // mouse movement while the free-look binding is held
  function mouseLook(dx) {
    if (!freeLookHeld || !enabled) return;
    lastDevice = 'kb';
    const sens = ctl().mouseSensitivity ?? 1;
    lookAngle = clamp(lookAngle + dx * 0.006 * sens, -Math.PI, Math.PI);
  }

  function mouseMove(dx, dy) {
    if (!ctl().mouseAirPitch) return;
    lastDevice = 'kb';
    mouseAccX += dx; mouseAccY += dy;
  }

  // release everything (blur / visibilitychange)
  function releaseAll(t) {
    for (const code of [...kbRaw]) {
      const names = actionsForCode(code);
      for (const n of names) if (n === 'scoreboard') fire('scoreboard', false);
      if (ballCamHeld && names.includes('ballCam')) ballCamInput(false);
    }
    kbRaw.clear();
    queue.length = 0;
    for (const code of [...kbHeld]) applyKbEdge(code, false);
    kbHeld.clear();
    mouseAccX = mouseAccY = mouseX = mouseY = 0;
    freeLookHeld = false; lookAngle = 0;
    void t;
  }

  // ---------------------------------------------------------------- gamepad
  // snapshot = {buttons:[{pressed,value}|number], axes:[...], mapping} or null
  function setPad(snapshot) {
    pad = snapshot;
    const pb = padBind();
    const c = ctl();
    if (!pad) {
      for (const n of CONTROL_ACTIONS) if (act[n].pad) { act[n].pad = 0; recomputeAction(n); }
      padLook = { x: 0, y: 0 };
      padAnalog = { steer: 0, pitch: 0, throttle: 0, reverse: 0 };
      for (const k of Object.keys(padPrevUI)) if (padPrevUI[k] && k === 'scoreboard') fire('scoreboard', false);
      padPrevUI = {}; padPrevJump = false;
      return;
    }
    // rebind capture for pad
    if (rebind && rebind.device === 'pad') { captureRebindPad(); return; }

    const dz = c.deadzone ?? 0.2;
    const shape = c.deadzoneShape || 'cross';
    const [sx, sy] = deadzone2(readPadBinding(pad, pb.steerAxis), readPadBinding(pad, pb.pitchAxis), dz, shape);
    const [lx, ly] = deadzone2(readPadBinding(pad, pb.lookX), readPadBinding(pad, pb.lookY), dz, shape);
    const thr = readPadBinding(pad, pb.throttle), rev = readPadBinding(pad, pb.reverse);
    padAnalog = { steer: sx, pitch: sy, throttle: thr > 0.05 ? thr : 0, reverse: rev > 0.05 ? rev : 0 };
    padLook = { x: lx, y: ly };
    let active = Math.abs(sx) > 0 || Math.abs(sy) > 0 || Math.abs(lx) > 0 || Math.abs(ly) > 0 || thr > 0.2 || rev > 0.2;

    for (const n of ['jump', 'boost', 'powerslide', 'airRollLeft', 'airRollRight']) {
      const v = readPadBinding(pad, pb[n]);
      if (v > 0.5) active = true;
      if ((act[n].pad > 0.5) !== (v > 0.5)) { act[n].pad = v; recomputeAction(n); } else act[n].pad = v;
    }
    const jumpNow = act.jump.pad > 0.5;
    if (jumpNow && !padPrevJump) fire('skipReplay', true);
    padPrevJump = jumpNow;

    for (const n of ['pause', 'scoreboard', 'resetBall', 'ballCam']) {
      const v = readPadBinding(pad, pb[n]) > 0.5;
      const prev = !!padPrevUI[n];
      if (v) active = true;
      if (v !== prev) uiEdge(n, v);
      padPrevUI[n] = v;
    }
    if (active) lastDevice = 'pad';
  }

  function captureRebindPad() {
    const r = rebind;
    if (!r.padBaseline) {
      // first snapshot after startRebind: remember resting values so held buttons / triggers resting at -1 don't capture
      r.padBaseline = {
        buttons: (pad.buttons || []).map((b) => readPadBinding({ buttons: [b] }, 'b0')),
        axes: (pad.axes || []).slice(),
      };
      return;
    }
    const isAxisAction = PAD_AXIS_ACTIONS.includes(r.action);
    const btns = pad.buttons || [];
    for (let i = 0; i < btns.length; i++) {
      const v = readPadBinding(pad, 'b' + i);
      const base = r.padBaseline.buttons[i] || 0;
      if (v > 0.6 && base < 0.3) {
        if (isAxisAction) continue; // axes actions need a stick
        finishPadRebind('b' + i);
        return;
      }
      if (v < 0.3) r.padBaseline.buttons[i] = v;
    }
    const axes = pad.axes || [];
    for (let i = 0; i < axes.length; i++) {
      const a = axes[i], base = r.padBaseline.axes[i] ?? 0;
      if (typeof a !== 'number') continue;
      if (Math.abs(a - base) > 0.6 && Math.abs(a) > 0.6) {
        finishPadRebind(isAxisAction ? 'a' + i : 'a' + i + (a > 0 ? '+' : '-'));
        return;
      }
    }
  }
  function finishPadRebind(code) {
    const r = rebind; rebind = null;
    settings.bindings.pad[r.action] = code;
    // swallow the press that was used for binding
    padPrevUI = { pause: true, scoreboard: true, resetBall: true, ballCam: true };
    padPrevJump = true;
    if (r.cb) r.cb(code);
  }

  // ---------------------------------------------------------------- timing
  // The physics accumulator in main.js lags real time by < 1 tick. We mirror it so that
  // tick i of this frame is stamped with the real time it represents:
  //   vt_i = now - acc + (i+1) * TICK
  // and only edges that happened before vt_i are visible to tick i. The mirror is
  // re-synchronised every frame with the number of ticks main actually sampled.
  let acc = 0, prevNow = null, ticksThisFrame = 0;
  function beginFrame(now) {
    if (prevNow === null) { prevNow = now; acc = 0; }
    acc -= ticksThisFrame * TICK_MS;
    if (ticksThisFrame >= 8) acc = 0; // main drops the accumulator when it hits the 8-tick clamp
    ticksThisFrame = 0;
    let dt = now - prevNow;
    if (!(dt >= 0)) dt = 0;
    if (dt > 250) dt = 250;
    acc += dt;
    if (acc < 0) acc = 0;
    if (acc > 9 * TICK_MS) acc = TICK_MS; // main clamps to 8 ticks per frame -> resync
    prevNow = now;
    frameNow = now;
    // stale edges (no ticks ran for a while: menus, pause) are applied immediately
    let i = 0;
    while (i < queue.length && queue[i].t < now - 250) { applyKbEdge(queue[i].code, queue[i].down); i++; }
    if (i) queue.splice(0, i);
  }

  // Sample one physics tick. t (optional) overrides the virtual tick time.
  function sampleTick(t) {
    if (t === undefined) {
      vt = Math.min(frameNow - acc + (ticksThisFrame + 1) * TICK_MS, frameNow);
      ticksThisFrame++;
    } else vt = t;
    // apply raw edges up to vt in timestamp order
    let i = 0;
    while (i < queue.length && queue[i].t <= vt) { applyKbEdge(queue[i].code, queue[i].down); i++; }
    if (i) queue.splice(0, i);

    // consume one buffered state per action
    for (const n of CONTROL_ACTIONS) {
      const a = act[n];
      a.out = a.pending.length ? a.pending.shift() : a.state;
    }
    // mouse virtual stick (decays to 0 within ~0.1 s after the mouse stops)
    const sens = ctl().mouseSensitivity ?? 1;
    const k = 0.012 * sens;
    mouseX = clamp(mouseX * 0.86 + mouseAccX * k, -1, 1);
    mouseY = clamp(mouseY * 0.86 + mouseAccY * k, -1, 1);
    if (Math.abs(mouseX) < 1e-3) mouseX = 0;
    if (Math.abs(mouseY) < 1e-3) mouseY = 0;
    mouseAccX = mouseAccY = 0;

    if (!enabled) {
      // drop buffered presses so nothing fires on resume; keep held state
      for (const n of CONTROL_ACTIONS) { act[n].pending.length = 0; act[n].out = act[n].state; }
      return neutralControls(ballCam);
    }
    return buildControls();
  }

  function buildControls() {
    const c = ctl();
    const o = (n) => (act[n].out ? 1 : 0);
    const sSens = c.steeringSensitivity ?? 1;
    const aSens = c.aerialSensitivity ?? 1;
    const inv = c.invertPitch ? -1 : 1;
    const airRollHeld = act.powerslide.out;

    // keyboard (digital)
    const kbThrottle = o('throttle') - o('reverse');
    const kbSteer = o('steerRight') - o('steerLeft');
    const kbYawExtra = o('yawRight') - o('yawLeft');
    // RL KB default: W/S also pitch the car in the air (W = nose down). Opt-out via controls.kbThrottlePitch=false.
    const kbPitch = o('pitchUp') - o('pitchDown') + (c.kbThrottlePitch === false ? 0 : -kbThrottle);
    const kbRollDir = o('airRollRight') - o('airRollLeft');

    // gamepad (analog)
    const padThrottle = padAnalog.throttle - padAnalog.reverse;
    const padSteer = padAnalog.steer;
    const padPitch = padAnalog.pitch; // axis +1 = stick pulled back = nose up

    // mouse virtual stick (mouse up = nose up)
    const mPitch = -mouseY, mYaw = mouseX;

    const ctrls = neutralControls(ballCam);
    ctrls.throttle = clamp(kbThrottle + padThrottle, -1, 1);
    ctrls.steer = clamp(kbSteer + padSteer * sSens, -1, 1);
    ctrls.pitch = clamp((clamp(kbPitch, -1, 1) + padPitch * aSens + mPitch) * inv, -1, 1);
    const lateral = clamp(kbSteer + padSteer * aSens + mYaw, -1, 1);
    const rollMode = c.kbAirRollMode === 'roll';
    if (airRollHeld || rollMode) {
      // free air roll: left stick X / A,D (and mouse X) roll the car instead of yawing
      ctrls.yaw = clamp(kbYawExtra, -1, 1);
      ctrls.roll = clamp(lateral + kbRollDir, -1, 1);
    } else {
      ctrls.yaw = clamp(lateral + kbYawExtra, -1, 1);
      ctrls.roll = clamp(kbRollDir, -1, 1);
    }
    ctrls.jump = act.jump.out;
    ctrls.boost = act.boost.out;
    ctrls.handbrake = act.powerslide.out;
    return ctrls;
  }

  // ---------------------------------------------------------------- rebinding
  function startRebind(action, device, cb) {
    rebind = { action, device: device === 'pad' ? 'pad' : 'kb', cb, padBaseline: null };
  }
  function cancelRebind() {
    if (!rebind) return;
    const r = rebind; rebind = null;
    if (r.cb) { try { r.cb(null); } catch (e) { /* ignore */ } }
  }

  return {
    keyEvent, mouseMove, mouseLook, releaseAll, setPad, beginFrame, sampleTick, startRebind, cancelRebind,
    setEnabled(b) {
      enabled = !!b;
      if (!enabled) {
        mouseX = mouseY = mouseAccX = mouseAccY = 0; freeLookHeld = false; lookAngle = 0;
        for (const n of CONTROL_ACTIONS) act[n].pending.length = 0;
      }
    },
    isEnabled: () => enabled,
    isBallCam: () => ballCam,
    setBallCam(v) { ballCam = !!v; },
    // re-apply settings.camera.ballCamDefault (called by main at each session start)
    resetBallCam() {
      ballCam = settings && settings.camera ? settings.camera.ballCamDefault !== false : true;
      ballCamHeld = false;
      return ballCam;
    },
    isFreeLookHeld: () => freeLookHeld,
    // {x, y} in right-stick convention: x + = look right, y + = stick pulled back (look behind)
    getLook() {
      if (!enabled) return { x: 0, y: 0 };
      const invX = settings && settings.camera && settings.camera.invertSwivel ? -1 : 1;
      if (padLook.x || padLook.y) return { x: padLook.x * invX, y: padLook.y };
      if (freeLookHeld || lookAngle) return { x: Math.sin(lookAngle) * invX, y: -Math.cos(lookAngle) };
      return { x: 0, y: 0 };
    },
    get lastDevice() { return lastDevice; },
    isRebinding: () => !!rebind,
    rebindDevice: () => (rebind ? rebind.device : null),
    // test / debug helpers
    _state: () => ({ vt, frameNow, queue: queue.slice(), held: [...kbHeld] }),
  };
}
