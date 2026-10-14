// OWNER: Match flow & replay agent.
// Goal replays: a preallocated typed-array ring buffer of per-tick world state
// (120 Hz) and a real-time playback that rebuilds frames in captureFrame()'s
// exact shape and interpolates them with interpolateFrames(), so cars and ball
// move exactly as they did live. Recording allocates nothing per tick (the
// captureFrame() object passed in is only read and becomes young-gen garbage).
//
// createReplayBuffer(seconds = 12) -> {
//   record(frame)               frame = captureFrame(world, match)
//   clear(), size, capacity, bytes (preallocated storage, 0 before the first frame),
//   bytesPerFrame,
//   latestTick() -> tick of the newest frame (or -1),
//   frameAt(i) -> captureFrame-shaped object for the i-th stored frame (0 = oldest), freshly allocated
//   range(fromTick, toTick) -> frames[] (freshly allocated; debug/tests)
//   startPlayback(opts) -> Playback | null
// }
//   opts: number (seconds back from the newest frame) or
//         { fromTick, toTick, goalTick, scorerId, goalTeam, freezeBallAfterTick }
//   Recording must pause while a playback runs (the match does this); a playback
//   whose frames get overwritten ends early.
//
// Playback: { update(frameDt) -> { view, cameraHint } | null when finished, skip(),
//             duration (s), frameCount, time (s), goalTime (s from start, or null) }
//   cameraHint = { mode: 'follow'|'wide'|'ball'|'goal', targetCarId, goalTeam, goalPos }
//   Auto-cut timeline relative to the goal: follow the scorer -> wide arena shot
//   (from 4.0 s before) -> ball chase (2.6 s before) -> goal view (0.7 s before).
import { interpolateFrames } from './view.js';
import { TICK_RATE } from '../sim/const.js';
import { Vec3, RotMat } from '../sim/math.js';

export const CUT_WIDE_BEFORE = 4.0;
export const CUT_BALL_BEFORE = 2.6;
export const CUT_GOAL_BEFORE = 0.7;

// ---- storage layout -----------------------------------------------------------
// Float64 per frame: tick, time, ball(pos3 vel3 angVel3 rot9), cars × CAR_F, pads × cooldown
// Uint32 per frame: one flag word per car. Uint8 per frame: pad isActive.
// Float64 keeps the reconstruction bit-identical to the live captureFrame().
const HDR_F = 2, BALL_F = 18;
const CAR_F = 38;
// car float offsets
const C_POS = 0, C_VEL = 3, C_ANG = 6, C_ROT = 9, C_BOOST = 18, C_HB = 19, C_FWD = 20, C_STEER = 21,
  C_AIRT = 22, C_DEMOT = 23, C_CTL = 24 /* throttle steer pitch yaw roll */, C_NWHEEL = 29, C_SUSP = 30, C_SPIN = 34;
const CTL_AXES = ['throttle', 'steer', 'pitch', 'yaw', 'roll'];
const CTL_BUTTONS = ['jump', 'boost', 'handbrake', 'ballCam'];
const CAR_FLAGS = ['isBoosting', 'isSupersonic', 'isDemoed', 'isOnGround', 'hasJumped', 'hasFlipped', 'isFlipping', 'isJumping'];
// flag bits: 0-7 CAR_FLAGS, 8-11 controls buttons, 12-15 wheel contact

function putV(f, o, v) { f[o] = v.x; f[o + 1] = v.y; f[o + 2] = v.z; }
function getV(f, o, out) { out.x = f[o]; out.y = f[o + 1]; out.z = f[o + 2]; return out; }

export function createReplayBuffer(seconds = 12) {
  const capacity = Math.max(2, Math.round(seconds * TICK_RATE));
  let layout = null;           // static data: { cars:[static], pads:[static], nCars, nPads, strideF }
  let F = null, U = null, P = null; // Float64Array, Uint32Array, Uint8Array
  let seq = 0;                 // total frames written since the last reset
  let count = 0;

  function makeLayout(frame) {
    const nCars = frame.cars.length, nPads = frame.pads.length;
    return {
      nCars, nPads,
      strideF: HDR_F + BALL_F + nCars * CAR_F + nPads,
      cars: frame.cars.map((c) => ({
        id: c.id, team: c.team, name: c.name, isBot: c.isBot, bodyId: c.bodyId, hitbox: c.hitbox, accent: c.accent,
        wheels: c.wheels.map((w) => ({ offset: w.offset, radius: w.radius, restLen: w.restLen, front: w.front, left: w.left })),
      })),
      pads: frame.pads.map((p) => ({ index: p.index, pos: p.pos, isBig: p.isBig })),
    };
  }
  function sameLayout(frame) {
    if (!layout || frame.cars.length !== layout.nCars || frame.pads.length !== layout.nPads) return false;
    for (let i = 0; i < layout.nCars; i++) {
      const c = frame.cars[i], s = layout.cars[i];
      if (c.id !== s.id || c.team !== s.team || c.bodyId !== s.bodyId || c.accent !== s.accent || c.name !== s.name || c.isBot !== s.isBot) return false;
    }
    return true;
  }
  function allocate(frame) {
    layout = makeLayout(frame);
    F = new Float64Array(capacity * layout.strideF);
    U = new Uint32Array(capacity * Math.max(1, layout.nCars));
    P = new Uint8Array(capacity * Math.max(1, layout.nPads));
    seq = 0; count = 0;
  }

  function slotOfSeq(s) { return s % capacity; }
  function tickOfSeq(s) { return F[slotOfSeq(s) * layout.strideF]; }

  function write(frame) {
    const slot = slotOfSeq(seq);
    const L = layout, f = F;
    let o = slot * L.strideF;
    f[o] = frame.tick; f[o + 1] = frame.time; o += HDR_F;
    const b = frame.ball;
    putV(f, o, b.pos); putV(f, o + 3, b.vel); putV(f, o + 6, b.angVel); f.set(b.rot.m, o + 9); o += BALL_F;
    for (let i = 0; i < L.nCars; i++, o += CAR_F) {
      const c = frame.cars[i];
      putV(f, o + C_POS, c.pos); putV(f, o + C_VEL, c.vel); putV(f, o + C_ANG, c.angVel); f.set(c.rot.m, o + C_ROT);
      f[o + C_BOOST] = c.boost; f[o + C_HB] = c.handbrakeVal; f[o + C_FWD] = c.forwardSpeed; f[o + C_STEER] = c.steer;
      f[o + C_AIRT] = c.airTimeSinceJump; f[o + C_DEMOT] = c.demoRespawnTimer;
      const ctl = c.controls;
      for (let k = 0; k < 5; k++) f[o + C_CTL + k] = ctl[CTL_AXES[k]] || 0;
      f[o + C_NWHEEL] = c.numWheelsInContact;
      let bits = 0;
      for (let k = 0; k < 8; k++) if (c[CAR_FLAGS[k]]) bits |= 1 << k;
      for (let k = 0; k < 4; k++) if (ctl[CTL_BUTTONS[k]]) bits |= 1 << (8 + k);
      for (let k = 0; k < 4; k++) {
        const w = c.wheels[k];
        f[o + C_SUSP + k] = w.suspLen; f[o + C_SPIN + k] = w.spin;
        if (w.contact) bits |= 1 << (12 + k);
      }
      U[slot * L.nCars + i] = bits;
    }
    for (let i = 0; i < L.nPads; i++) { const p = frame.pads[i]; f[o + i] = p.cooldown; P[slot * L.nPads + i] = p.isActive ? 1 : 0; }
    seq++;
    if (count < capacity) count++;
  }

  // ---- decoding into captureFrame()-shaped objects --------------------------
  function newFrameObject() {
    const L = layout;
    return {
      tick: 0, time: 0,
      ball: { pos: new Vec3(), vel: new Vec3(), angVel: new Vec3(), rot: new RotMat() },
      cars: L.cars.map((s) => ({
        id: s.id, team: s.team, name: s.name, isBot: s.isBot, bodyId: s.bodyId, hitbox: s.hitbox, accent: s.accent,
        pos: new Vec3(), vel: new Vec3(), angVel: new Vec3(), rot: new RotMat(),
        boost: 0, isBoosting: false, isSupersonic: false, isDemoed: false,
        isOnGround: false, numWheelsInContact: 0, handbrakeVal: 0,
        forwardSpeed: 0, steer: 0,
        controls: { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false, ballCam: false },
        hasJumped: false, hasFlipped: false, isFlipping: false, isJumping: false,
        airTimeSinceJump: 0, demoRespawnTimer: 0,
        wheels: s.wheels.map((w) => ({ offset: w.offset, radius: w.radius, restLen: w.restLen, front: w.front, left: w.left, suspLen: 0, spin: 0, contact: false })),
      })),
      pads: L.pads.map((p) => ({ index: p.index, pos: p.pos, isBig: p.isBig, isActive: true, cooldown: 0 })),
    };
  }
  // Fill `out` with the frame stored at sequence number s (ball taken from ballSeq if given).
  function decode(s, out, ballSeq = s) {
    const L = layout, f = F, slot = slotOfSeq(s);
    let o = slot * L.strideF;
    out.tick = f[o]; out.time = f[o + 1]; o += HDR_F;
    const ob = slotOfSeq(ballSeq) * L.strideF + HDR_F;
    const b = out.ball;
    getV(f, ob, b.pos); getV(f, ob + 3, b.vel); getV(f, ob + 6, b.angVel); b.rot.m.set(f.subarray(ob + 9, ob + 18));
    o += BALL_F;
    for (let i = 0; i < L.nCars; i++, o += CAR_F) {
      const c = out.cars[i];
      getV(f, o + C_POS, c.pos); getV(f, o + C_VEL, c.vel); getV(f, o + C_ANG, c.angVel); c.rot.m.set(f.subarray(o + C_ROT, o + C_ROT + 9));
      c.boost = f[o + C_BOOST]; c.handbrakeVal = f[o + C_HB]; c.forwardSpeed = f[o + C_FWD]; c.steer = f[o + C_STEER];
      c.airTimeSinceJump = f[o + C_AIRT]; c.demoRespawnTimer = f[o + C_DEMOT];
      c.numWheelsInContact = f[o + C_NWHEEL];
      const bits = U[slot * L.nCars + i];
      for (let k = 0; k < 8; k++) c[CAR_FLAGS[k]] = (bits & (1 << k)) !== 0;
      const ctl = c.controls;
      for (let k = 0; k < 5; k++) ctl[CTL_AXES[k]] = f[o + C_CTL + k];
      for (let k = 0; k < 4; k++) ctl[CTL_BUTTONS[k]] = (bits & (1 << (8 + k))) !== 0;
      for (let k = 0; k < 4; k++) {
        const w = c.wheels[k];
        w.suspLen = f[o + C_SUSP + k]; w.spin = f[o + C_SPIN + k]; w.contact = (bits & (1 << (12 + k))) !== 0;
      }
    }
    for (let i = 0; i < L.nPads; i++) { const p = out.pads[i]; p.cooldown = f[o + i]; p.isActive = P[slot * L.nPads + i] === 1; }
    return out;
  }
  const oldestSeq = () => seq - count;
  const available = (s) => count > 0 && s >= oldestSeq() && s < seq;

  // sequence numbers [first, last] of stored frames with fromTick <= tick <= toTick
  function seqRange(fromTick, toTick) {
    let first = -1, last = -1;
    for (let s = oldestSeq(); s < seq; s++) {
      const t = tickOfSeq(s);
      if (t >= fromTick && t <= toTick) { if (first < 0) first = s; last = s; }
    }
    return first < 0 ? null : [first, last];
  }
  function lastSeqAtOrBefore(first, last, tick) {
    let res = -1;
    for (let s = first; s <= last; s++) if (tickOfSeq(s) <= tick) res = s;
    return res;
  }

  const api = {
    capacity,
    get size() { return count; },
    get bytes() { return F ? F.byteLength + U.byteLength + P.byteLength : 0; },
    get bytesPerFrame() { return layout ? layout.strideF * 8 + Math.max(1, layout.nCars) * 4 + Math.max(1, layout.nPads) : 0; },
    record(frame) {
      if (!frame) return;
      if (!sameLayout(frame)) allocate(frame);
      // a frame older than / equal to the newest one means the timeline restarted
      else if (count && frame.tick <= tickOfSeq(seq - 1)) { seq = 0; count = 0; }
      write(frame);
    },
    clear() { seq = 0; count = 0; },
    latestTick() { return count ? tickOfSeq(seq - 1) : -1; },
    frameAt(i) { return i >= 0 && i < count ? decode(oldestSeq() + i, newFrameObject()) : null; },
    range(fromTick, toTick) {
      const r = count ? seqRange(fromTick, toTick) : null;
      const out = [];
      if (r) for (let s = r[0]; s <= r[1]; s++) out.push(decode(s, newFrameObject()));
      return out;
    },
    startPlayback(opts = 6) {
      if (!count) return null;
      let o = opts;
      if (typeof opts === 'number') {
        const last = api.latestTick();
        o = { fromTick: last - Math.round(opts * TICK_RATE), toTick: last };
      }
      const r = seqRange(o.fromTick ?? -Infinity, o.toTick ?? Infinity);
      if (!r || r[1] - r[0] < 1) return null;
      return createPlayback(r[0], r[1], o);
    },
  };

  function createPlayback(first, last, opts) {
    const n = last - first + 1;
    const duration = (n - 1) / TICK_RATE;
    const startTick = tickOfSeq(first);
    // Freeze the ball where it crossed the line once the goal has happened
    // (live, it explodes and is moved out of play).
    const freezeTick = opts.freezeBallAfterTick;
    const freezeSeq = freezeTick != null ? lastSeqAtOrBefore(first, last, freezeTick) : -1;
    const goalTime = opts.goalTick != null ? (opts.goalTick - startTick) / TICK_RATE : null;
    const goalSeq = opts.goalTick != null ? lastSeqAtOrBefore(first, last, opts.goalTick) : -1;
    const goalPos = getV(F, slotOfSeq(goalSeq >= 0 ? goalSeq : last) * layout.strideF + HDR_F, new Vec3());
    const hint = { mode: 'wide', targetCarId: opts.scorerId ?? -1, goalTeam: opts.goalTeam ?? -1, goalPos };
    // two scratch frames reused as interpolateFrames inputs
    const scratch = [{ seq: -1, frame: newFrameObject() }, { seq: -1, frame: newFrameObject() }];
    function frameFor(s, keep) {
      for (const sc of scratch) if (sc.seq === s) return sc.frame;
      const sc = scratch[0].seq === keep ? scratch[1] : scratch[0];
      sc.seq = s;
      return decode(s, sc.frame, freezeSeq >= 0 && tickOfSeq(s) > freezeTick ? freezeSeq : s);
    }
    let t = 0, done = false;
    const result = { view: null, cameraHint: hint };

    function hintAt(time) {
      const hasScorer = hint.targetCarId != null && hint.targetCarId >= 0;
      if (goalTime == null) return hasScorer ? 'follow' : 'ball';
      const before = goalTime - time;
      if (before <= CUT_GOAL_BEFORE) return 'goal';
      if (before <= CUT_BALL_BEFORE) return 'ball';
      if (before <= CUT_WIDE_BEFORE) return 'wide';
      return hasScorer ? 'follow' : 'wide';
    }

    return {
      duration, frameCount: n, goalTime,
      get time() { return t; },
      get done() { return done; },
      update(dt) {
        if (done) return null;
        t += Math.max(0, dt || 0);
        if (t > duration + 1e-6) { done = true; return null; }
        if (t > duration) t = duration;
        const fi = t * TICK_RATE;
        const i = Math.min(Math.floor(fi), n - 1);
        const sa = first + i, sb = first + Math.min(i + 1, n - 1);
        if (!available(sa) || !available(sb)) { done = true; return null; }
        const fa = frameFor(sa, sb);
        const fb = frameFor(sb, sa);
        const view = interpolateFrames(fa, fb, i + 1 < n ? fi - i : 1);
        detach(view);
        view.isReplay = true;
        hint.mode = hintAt(t);
        result.view = view;
        return result;
      },
      skip() { done = true; },
    };
  }

  return api;
}

// interpolateFrames() keeps a few references into its input frames (ball.angVel,
// pads, car angVel/controls). The scratch frames are rewritten on later updates,
// so give the view its own copies (same values, same shape as live).
function detach(view) {
  view.ball.angVel = view.ball.angVel.clone();
  view.pads = view.pads.map((p) => ({ index: p.index, pos: p.pos, isBig: p.isBig, isActive: p.isActive, cooldown: p.cooldown }));
  for (const c of view.cars) { c.angVel = c.angVel.clone(); c.controls = { ...c.controls }; }
}
