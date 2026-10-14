// TURBO PITCH bots — shared, incremental ball prediction.
//
// One cache per World (WeakMap). Each tick the first bot that asks:
//   * compares the real ball with the current trajectory's slot for this tick;
//     if it matches (nobody touched the ball) the trajectory is only extended by
//     a few ticks to keep a HORIZON-second look-ahead (almost free);
//   * otherwise a new trajectory "version" is started from the real state and
//     filled lazily (FIRST_FILL ticks immediately, FILL_PER_TICK more per tick).
// Old versions are kept for a short while so bots with a reaction delay can act
// on the trajectory they would have known `delay` ticks ago (stale observation).
//
// Trajectory data are stored per absolute world tick in ring buffers:
//   version.get(tick) -> index into version.buf (pos x,y,z, vel x,y,z) or -1
import { Ball, stepBallAlone } from '../sim/ball.js';

const HORIZON = 5 * 120;       // ticks of look-ahead
const CAP = 768;               // ring capacity (> HORIZON + max delay)
const FIRST_FILL = 48;         // ticks predicted immediately after a touch (0.4 s)
const FILL_PER_TICK = 48;      // extra ticks filled per tick until HORIZON (full 5 s after ~0.1 s)
const POOL = 24;               // versions kept (for delayed bots)

class Version {
  constructor() { this.buf = new Float64Array(CAP * 6); this.ball = new Ball(); this.start = 0; this.end = 0; this.created = 0; this.id = 0; this.live = false; this.extTick = -1; }
  has(tick) { return tick >= this.start && tick < this.end && tick >= this.end - CAP; }
  idx(tick) { return (tick % CAP) * 6; }
}

class Cache {
  constructor() {
    this.versions = [];
    for (let i = 0; i < POOL; i++) this.versions.push(new Version());
    this.cur = null;
    this.lastTick = -1;
    this.nextId = 1;
  }
  _newVersion(tick, bb) {
    // reuse the oldest version
    let v = this.versions[0];
    for (const x of this.versions) {
      if (x === this.cur) continue;
      if (!x.live) { v = x; break; }
      if (v === this.cur || x.created < v.created) v = x;
    }
    if (this.cur) this.cur.superseded = tick;
    v.live = true; v.superseded = Infinity; v.start = tick; v.end = tick; v.created = tick; v.id = this.nextId++;
    const b = v.ball.body;
    b.pos.copy(bb.pos); b.vel.copy(bb.vel); b.angVel.copy(bb.angVel);
    b.velCache.set(0, 0, 0); b.force.set(0, 0, 0);
    this._write(v, tick);
    v.end = tick + 1;
    this.cur = v;
    return v;
  }
  _write(v, tick) {
    const b = v.ball.body, i = v.idx(tick), buf = v.buf;
    buf[i] = b.pos.x; buf[i + 1] = b.pos.y; buf[i + 2] = b.pos.z;
    buf[i + 3] = b.vel.x; buf[i + 4] = b.vel.y; buf[i + 5] = b.vel.z;
  }
  _extend(v, upTo) {
    const dt = 1 / 120;
    while (v.end < upTo) {
      stepBallAlone(v.ball, dt);
      this._write(v, v.end);
      v.end++;
    }
  }
  update(world) {
    const tick = world.tick;
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    const bb = world.ball.body;
    let v = this.cur;
    let ok = false;
    if (v && v.has(tick)) {
      const i = v.idx(tick), buf = v.buf;
      const dp = Math.abs(buf[i] - bb.pos.x) + Math.abs(buf[i + 1] - bb.pos.y) + Math.abs(buf[i + 2] - bb.pos.z);
      const dv = Math.abs(buf[i + 3] - bb.vel.x) + Math.abs(buf[i + 4] - bb.vel.y) + Math.abs(buf[i + 5] - bb.vel.z);
      ok = dp < 2 && dv < 6;
    }
    if (!ok) {
      v = this._newVersion(tick, bb);
      this._extend(v, tick + FIRST_FILL);
    } else {
      this._extend(v, Math.min(tick + HORIZON, Math.max(v.end + FILL_PER_TICK, tick + FIRST_FILL)));
    }
    // retire versions that no delayed bot can need any more
    for (const x of this.versions) if (x.live && x !== this.cur && x.superseded < tick - 120) x.live = false;
  }
  // newest version created at or before `tick`
  versionAt(tick) {
    let best = null;
    for (const x of this.versions) {
      if (!x.live || x.created > tick) continue;
      if (!best || x.created > best.created || (x.created === best.created && x.id > best.id)) best = x;
    }
    if (!best) { // pool exhausted: oldest live
      for (const x of this.versions) if (x.live && (!best || x.created < best.created)) best = x;
    }
    return best;
  }
}

const caches = new WeakMap();
function cacheFor(world) {
  let c = caches.get(world);
  if (!c) { c = new Cache(); caches.set(world, c); }
  return c;
}

// A read-only view of one trajectory as seen by a bot at world.tick:
//   view.n               number of usable slices (from the current tick on)
//   view.t(i)            time (s) from now of slice i
//   view.pos(i, out)     ball position of slice i, view.vel(i, out)
// Slices are every `step` ticks starting at the current tick.
export class TrajView {
  constructor() { this.v = null; this.tick0 = 0; this.n = 0; this.step = 1; this.id = 0; this.created = 0; }
  _set(v, tick0, step) {
    this.v = v; this.tick0 = tick0; this.step = step; this.id = v.id; this.created = v.created;
    const avail = v.end - tick0;
    this.n = avail > 0 ? Math.floor((avail - 1) / step) + 1 : 0;
  }
  t(i) { return i * this.step / 120; }
  px(i) { return this.v.buf[this.v.idx(this.tick0 + i * this.step)]; }
  py(i) { return this.v.buf[this.v.idx(this.tick0 + i * this.step) + 1]; }
  pz(i) { return this.v.buf[this.v.idx(this.tick0 + i * this.step) + 2]; }
  pos(i, out) {
    const b = this.v.buf, k = this.v.idx(this.tick0 + i * this.step);
    out.x = b[k]; out.y = b[k + 1]; out.z = b[k + 2]; return out;
  }
  vel(i, out) {
    const b = this.v.buf, k = this.v.idx(this.tick0 + i * this.step);
    out.x = b[k + 3]; out.y = b[k + 4]; out.z = b[k + 5]; return out;
  }
  // index of the slice nearest to time t (s)
  at(t) { return Math.max(0, Math.min(this.n - 1, Math.round(t * 120 / this.step))); }
}

// Fill `view` with the trajectory known `delayTicks` ago, sliced from now.
export function getTrajectory(world, view, delayTicks = 0, step = 2) {
  const c = cacheFor(world);
  c.update(world);
  const v = delayTicks > 0 ? c.versionAt(world.tick - delayTicks) : c.cur;
  if (v !== c.cur && v.extTick !== world.tick && v.end < world.tick + HORIZON) {
    // a superseded version a delayed bot still believes in: keep extending it lazily
    v.extTick = world.tick;
    c._extend(v, Math.min(world.tick + HORIZON, v.end + FILL_PER_TICK));
  }
  view._set(v, world.tick, step);
  if (view.n === 0) view._set(c.cur, world.tick, step);
  return view;
}

// True when the real trajectory changed in the last `ticks` ticks (ball touched)
export function trajectoryAge(world) {
  const c = cacheFor(world); c.update(world);
  return world.tick - c.cur.created;
}
