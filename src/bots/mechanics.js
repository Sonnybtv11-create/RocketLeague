// TURBO PITCH bots — mechanics. Every maneuver only ever writes Controls.
//
// A maneuver is an object with
//   name, step(bot, car, c, world) -> true when finished
// It is ticked once per physics tick while active and fully owns the controls.
// `bot` exposes: traj (TrajView of the believed ball path), stats, rng, skill.
import { arenaSDF, arenaNormal } from '../sim/arena.js';
import {
  vec, vsub, vadd, vscale, vdot, vlen, vnorm, vnorm2D, dist, clamp, clamp1, sign,
  carFwd, carUp, toLocal, localTarget, orientTo, GRAVITY, BALL_R,
} from './util.js';
import { jumpHeight } from './tables.js';

const DT = 1 / 120;

// ---------------------------------------------------------------- recovery
// Land on the wheels: predict where the car meets the arena and align the
// wheels with that surface, nose along the velocity.
const _n = { x: 0, y: 0, z: 1 };
export function landingInfo(car) {
  const p = car.body.pos, v = car.body.vel;
  let x = p.x, y = p.y, z = p.z, vx = v.x, vy = v.y, vz = v.z;
  for (let i = 0; i < 40; i++) {
    const d = arenaSDF(x, y, z);
    if (d < 60) break;
    const h = clamp((d - 40) / 2600, 0.01, 0.1);
    vz -= GRAVITY * h;
    x += vx * h; y += vy * h; z += vz * h;
  }
  arenaNormal(x, y, z, _n);
  return { pos: { x, y, z }, normal: { x: _n.x, y: _n.y, z: _n.z } };
}

export function recover(car, c, faceDir) {
  const land = landingInfo(car);
  const n = land.normal;
  // forward: requested direction (or velocity) projected on the landing plane
  let f = faceDir || car.body.vel;
  f = vsub(f, vscale(n, vdot(f, n)));
  if (vlen(f) < 100 && !faceDir) {
    const cf = carFwd(car);
    f = vsub(cf, vscale(n, vdot(cf, n)));
  }
  if (vlen(f) < 1e-3) f = carFwd(car);
  orientTo(car, vnorm(f), n, c);
  c.throttle = 1;
  c.boost = false;
  return land;
}

// ---------------------------------------------------------------- flips
// Jump then dodge in a car-local ground direction (dx forward, dy right).
// jumpTicks: hold, gap: release before the dodge press.
export class Flip {
  constructor(dx, dy, opts = {}) {
    this.name = opts.name || 'flip';
    const m = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
    this.pitch = -dx / m; this.yaw = dy / m;
    this.jumpTicks = opts.jumpTicks ?? 5;
    this.gap = opts.gap ?? 2;
    this.boost = !!opts.boost;
    this.maxTicks = opts.maxTicks ?? 150;
    this.k = 0;
    this.onDodge = opts.onDodge || null;
  }
  step(bot, car, c) {
    const k = this.k++;
    c.throttle = 1;
    c.boost = this.boost && k < this.jumpTicks + this.gap;
    if (k < this.jumpTicks) { c.jump = true; return false; }
    if (k < this.jumpTicks + this.gap) { c.jump = false; return false; }
    if (k === this.jumpTicks + this.gap) {
      c.jump = true; c.pitch = this.pitch; c.yaw = this.yaw;
      if (this.onDodge) this.onDodge();
      if (bot && bot.stats) bot.stats.flips++;
      return false;
    }
    // during the dodge: keep the input (it never cancels a forward/side flip)
    const ft = k - this.jumpTicks - this.gap;
    if (ft < 60) { c.pitch = this.pitch; c.yaw = this.yaw; return false; }
    if (car.isOnGround && ft > 8) return true;
    recover(car, c, null);
    return k > this.maxTicks;
  }
}

// Speed-flip (diagonal dodge, cancelled, while boosting). Parameters tuned by a
// search in the real sim (see tests/mechanics.test.mjs). side = +1 dodges to the
// right, -1 to the left. faceTarget: point to face while recovering.
export const SPEEDFLIP_PARAMS = { h: 4, w: 1, ky: 0.35, cd: 0, cl: 33, r: 0.17, yy: -0.31 };
export class SpeedFlip {
  constructor(side, faceTarget, params = SPEEDFLIP_PARAMS) {
    this.name = 'speedflip';
    this.s = side; this.face = faceTarget; this.p = params; this.k = 0;
  }
  step(bot, car, c) {
    const k = this.k++, p = this.p, s = this.s;
    c.throttle = 1; c.boost = true;
    const tDodge = p.h + p.w;
    if (k < p.h) { c.jump = true; return false; }
    if (k < tDodge) { c.jump = false; return false; }
    if (k === tDodge) { c.jump = true; c.pitch = -1; c.yaw = s * p.ky; if (bot && bot.stats) bot.stats.flips++; return false; }
    if (k < tDodge + 1 + p.cd) { c.pitch = -1; c.yaw = s * p.ky; return false; }
    if (k < tDodge + 1 + p.cd + p.cl) { c.pitch = 1; c.roll = -s * p.r; c.yaw = -s * p.yy; return false; }
    if (car.isOnGround) return true;
    const face = this.face ? vsub(this.face, car.body.pos) : car.body.vel;
    face.z = 0;
    orientTo(car, vnorm(face), { x: 0, y: 0, z: 1 }, c);
    c.boost = vdot(carFwd(car), vnorm(face)) > 0.9;
    return k > 200;
  }
}

// Half-flip: back-flip, cancel with forward pitch, air-roll upright -> the car
// faces the other way. Start while reversing (or stationary).
export const HALFFLIP_PARAMS = { jump: 2, gap: 3, cancelAt: 20, rollDir: 1 };
export class HalfFlip {
  constructor(params = HALFFLIP_PARAMS, boostAfter = true) {
    this.name = 'halfflip'; this.p = params; this.k = 0; this.boostAfter = boostAfter;
  }
  step(bot, car, c) {
    const k = this.k++, p = this.p;
    c.throttle = -1;
    if (k < p.jump) { c.jump = true; return false; }
    if (k < p.jump + p.gap) { c.jump = false; return false; }
    if (k === p.jump + p.gap) { c.jump = true; c.pitch = 1; if (bot && bot.stats) { bot.stats.flips++; bot.stats.halfFlips++; } return false; }
    const ft = k - p.jump - p.gap;
    c.throttle = 1;
    if (ft < p.cancelAt) { c.pitch = 1; return false; }
    if (car.isOnGround) return ft > 20;
    // cancel + roll upright
    c.pitch = -1;
    const up = carUp(car);
    // roll the shorter way toward world up
    const r = toLocal(car, { x: 0, y: 0, z: 1 });
    c.roll = up.z > 0.7 ? clamp1(r.y * 3) : (r.y >= 0 ? 1 : -1) * p.rollDir;
    if (up.z > 0.6) {
      // nearly upright: normal landing recovery, boost if facing the motion
      const n = { x: 0, y: 0, z: 1 };
      const f = vnorm({ x: carFwd(car).x, y: carFwd(car).y, z: 0 });
      orientTo(car, f, n, c);
      c.boost = this.boostAfter && carFwd(car).z < 0.3;
    }
    return k > 160;
  }
}

// ---------------------------------------------------------------- jump shot
// Single (dbl=false) or double jump timed to meet the ball at targetTick; nose
// tracks the ball; optional dodge into the ball at the last moment.
export class JumpShot {
  constructor(targetTick, dbl, dodge, holdTicks = 24) {
    this.name = dbl ? 'doubleJumpShot' : 'jumpShot';
    this.targetTick = targetTick; this.dbl = dbl; this.dodge = dodge; this.hold = holdTicks; this.k = 0; this.dodged = false;
  }
  step(bot, car, c, world) {
    const k = this.k++;
    const T = (this.targetTick - world.tick) / 120;
    const ball = bot.ballAt(Math.max(0, T));
    c.throttle = 1;
    if (this.dbl) {
      c.jump = k < 24 || (k >= 26 && k < 30);
    } else c.jump = k < this.hold;
    const toBall = vsub(ball, car.body.pos);
    if (k >= 2 && !(this.dbl && k >= 25 && k <= 27)) {
      // aim the nose at the ball (a bit under it so we hit it up and forward)
      orientTo(car, vnorm(toBall), null, c, { gain: 1 });
    }
    if (this.dodge && !this.dbl && !this.dodged && k > this.hold && !car.hasFlipped && car.airTimeSinceJump < 1.2) {
      const d = vlen(toBall);
      if (T < 0.12 && d < BALL_R + 190) {
        const loc = toLocal(car, toBall);
        const dir = vnorm2D(loc);
        const m = Math.max(Math.abs(dir.x), Math.abs(dir.y));
        c.jump = true; c.pitch = -dir.x / m; c.yaw = dir.y / m; c.roll = 0;
        this.dodged = true; this.dp = c.pitch; this.dy = c.yaw;
        if (bot.stats) bot.stats.flips++;
        return false;
      }
    }
    if (this.dodged) { c.pitch = this.dp; c.yaw = this.dy; c.roll = 0; }
    if (k > 6 && car.isOnGround) return true;
    if (T < -0.35) {
      recover(car, c, null);
      return car.isOnGround || T < -2;
    }
    return false;
  }
}

// ---------------------------------------------------------------- aerial
// Aerial feasibility: can the car reach `target` (car-origin position) in T s?
// Returns {acc: required average boost acceleration (uu/s²), ...}.
const NO_AERIAL = { acc: Infinity, dir: null, dist: Infinity, Te: 0 };
export function aerialRequirement(car, target, T, dbl) {
  const p = car.body.pos, v = car.body.vel;
  let px = p.x, py = p.y, pz = p.z, vx = v.x, vy = v.y, vz = v.z, t1 = 0;
  if (car.isOnGround) {
    const up = carUp(car);
    // jump phase (0.2 s hold, measured table), optional double jump
    t1 = dbl ? 0.25 : 0.2;
    if (T <= t1 + 0.1) return NO_AERIAL;
    const h = jumpHeight(t1, dbl);
    const dvz = dbl ? 727 : 434; // vertical speed after the jump phase (table)
    px += vx * t1 + up.x * h; py += vy * t1 + up.y * h; pz += vz * t1 + up.z * h;
    vx += up.x * dvz; vy += up.y * dvz; vz += up.z * dvz;
  }
  const Tr = T - t1;
  const g = -GRAVITY;
  const X = { x: target.x - (px + vx * Tr), y: target.y - (py + vy * Tr), z: target.z - (pz + vz * Tr + 0.5 * g * Tr * Tr) };
  const d = vlen(X);
  // orientation time: angle between the nose and the required direction
  const f = car.isOnGround ? vnorm(vadd(carFwd(car), { x: 0, y: 0, z: 0.8 })) : carFwd(car);
  const ang = Math.acos(clamp(vdot(f, X) / (d || 1), -1, 1));
  const Te = Tr - ang * 0.35 - 0.05;
  if (Te <= 0.05) return NO_AERIAL;
  return { acc: 2 * d / (Te * Te), dir: X, dist: d, Te };
}

export class Aerial {
  // getTarget(T) -> car-origin target position at time-to-go T; ballAt for dodge
  constructor(targetTick, getTarget, opts = {}) {
    this.name = 'aerial';
    this.targetTick = targetTick; this.getTarget = getTarget;
    this.dbl = !!opts.dbl; this.dodge = !!opts.dodge; this.k = 0; this.jumped = false;
    this.startGround = null; this.dodged = false; this.maxBoostFrac = opts.maxBoostFrac ?? 1;
  }
  step(bot, car, c, world) {
    const k = this.k++;
    if (this.startGround === null) this.startGround = car.isOnGround;
    const T = (this.targetTick - world.tick) / 120;
    c.throttle = 1;
    if (this.startGround) {
      if (this.dbl) c.jump = k < 20 || (k >= 22 && k < 26);
      else c.jump = k < 22;
    }
    const target = this.getTarget(Math.max(T, 0));
    const p = car.body.pos, v = car.body.vel;
    const Tc = Math.max(T, 0.01);
    const X = {
      x: target.x - (p.x + v.x * Tc),
      y: target.y - (p.y + v.y * Tc),
      z: target.z - (p.z + v.z * Tc - 0.5 * GRAVITY * Tc * Tc),
    };
    const d = vlen(X);
    const dir = vnorm(X);
    const ball = bot.ballAt(Math.max(T, 0));
    const toBall = vsub(ball, p);
    const doubleTick = this.dbl && this.startGround && k >= 20 && k < 26;
    if (!doubleTick && k >= 1) {
      if (d > 40 && T > 0.05) orientTo(car, dir, null, c, { gain: 1.1 });
      else orientTo(car, vnorm(toBall), null, c, { gain: 1.1 });
    }
    const fw = carFwd(car);
    const align = vdot(fw, dir);
    const reqAcc = 2 * d / (Tc * Tc);
    c.boost = T > 0 && align > 0.85 && d > 30 && reqAcc > 120 * this.maxBoostFrac;
    // final dodge into the ball
    if (this.dodge && !this.dodged && !car.hasFlipped && car.hasFlipOrJump() && (!this.startGround || k > 30)) {
      const db = vlen(toBall);
      if (T < 0.1 && db < BALL_R + 170) {
        const loc = toLocal(car, toBall);
        const dd = vnorm2D(loc);
        const m = Math.max(Math.abs(dd.x), Math.abs(dd.y));
        c.jump = true; c.pitch = -dd.x / m; c.yaw = dd.y / m; c.roll = 0;
        this.dodged = true;
        if (bot.stats) bot.stats.flips++;
      }
    }
    if (k > 8 && car.isOnGround) return true;
    if (T < -0.1) {
      recover(car, c, null);
      return car.isOnGround || T < -3;
    }
    return false;
  }
}

// ---------------------------------------------------------------- utility
// Reverse with the wheels turned for a while (unstick from walls / posts)
export class Unstuck {
  constructor(steer, ticks = 80, throttle = -1) { this.name = 'unstuck'; this.steer = steer; this.ticks = ticks; this.k = 0; this.thr = throttle; }
  step(bot, car, c) {
    const k = this.k++;
    c.throttle = this.thr; c.steer = this.steer;
    if (!car.isOnGround && k > 5) { recover(car, c, null); }
    // upside down / on the side: jump to auto-flip / pop off
    const up = carUp(car);
    if (up.z < 0.2 && car.numWheelsInContact < 3) c.jump = (k % 20) < 3;
    return k >= this.ticks;
  }
}

// Wait-and-jump helper for being on the roof
export function autoFlipInput(car, c, tick) {
  const up = carUp(car);
  if (up.z < -0.3 || (Math.abs(up.z) < 0.4 && car.numWheelsInContact === 0)) {
    c.jump = (tick % 24) < 3; c.throttle = 1; c.roll = up.z > -0.3 ? sign(toLocal(car, { x: 0, y: 0, z: 1 }).y) : 0;
    return true;
  }
  return false;
}

export { DT };
