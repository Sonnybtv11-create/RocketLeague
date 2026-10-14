// TURBO PITCH bots — strategy: shared team coordinator (roles, ETAs, kickoff
// taker), shot-direction choice and the intercept search.
import { arenaSDF } from '../sim/arena.js';
import { getTrajectory, TrajView } from './predict.js';
import { driveDist, maxJumpHeight } from './tables.js';
import { aerialRequirement } from './mechanics.js';
import {
  clamp, sign, PI, carFwd, angle2D, FIELD_Y, GOAL_HW,
} from './util.js';

export const BOOST_ACC_AIR = 1058.33;
// approach turning-circle scale (radius = turnRadius(speed) * APPROACH_R)
export const APPROACH_R = 1.7;

// turning curvature of a car vs speed (RL table) -> turn radius
const CURV = [[0, 0.0069], [500, 0.00398], [1000, 0.00235], [1500, 0.001375], [1750, 0.0011], [2300, 0.00088]];
export function turnRadius(v) {
  v = Math.abs(v);
  for (let i = 1; i < CURV.length; i++) {
    if (v < CURV[i][0]) {
      const [x0, y0] = CURV[i - 1], [x1, y1] = CURV[i];
      return 1 / (y0 + (y1 - y0) * (v - x0) / (x1 - x0));
    }
  }
  return 1 / 0.00088;
}

// Highest speed at which the car can still follow a circle of radius R
export function speedForRadius(R) {
  const k = 1 / Math.max(R, 1);
  if (k >= CURV[0][1]) return 0;
  for (let i = 1; i < CURV.length; i++) {
    if (k >= CURV[i][1]) {
      const [x0, y0] = CURV[i - 1], [x1, y1] = CURV[i];
      return x0 + (x1 - x0) * (y0 - k) / (y0 - y1);
    }
  }
  return 2300;
}

// Arrive at C=(cx,cy) heading along (sdx,sdy): straight line to the tangent
// point of a turning circle of radius r that ends at C with that heading
// (Dubins-like "line + arc"). Returns {tx, ty} steering target and the path
// length (out object reused).
const _ap = { tx: 0, ty: 0, len: 0, arc: 0 };
export function approachPath(px, py, cx, cy, sdx, sdy, r) {
  const rx = px - cx, ry = py - cy;
  // side of the final line the car is on (math orientation: left = +)
  const side = sdx * ry - sdy * rx >= 0 ? 1 : -1;
  // circle centre
  const ox = cx - sdy * r * side, oy = cy + sdx * r * side;
  const dx = px - ox, dy = py - oy;
  const d = Math.hypot(dx, dy);
  const direct = Math.hypot(rx, ry);
  // ahead of C along the shot line and nearly aligned: go straight
  if (d <= r * 1.02) {
    _ap.tx = cx; _ap.ty = cy; _ap.len = direct * 1.15; _ap.arc = 0; return _ap;
  }
  const phi = Math.atan2(dy, dx), alpha = Math.acos(r / d);
  const ta = phi + side * alpha;
  const tx = ox + r * Math.cos(ta), ty = oy + r * Math.sin(ta);
  // arc from T to C in the travel direction (side=+1: CCW)
  const ca = Math.atan2(cy - oy, cx - ox);
  let arc = (ca - ta) * side;
  while (arc < 0) arc += 2 * Math.PI;
  while (arc > 2 * Math.PI) arc -= 2 * Math.PI;
  const straight = Math.hypot(tx - px, ty - py);
  _ap.len = straight + arc * r;
  _ap.arc = arc;
  if (straight > r * 0.35) { _ap.tx = tx; _ap.ty = ty; } else {
    // on the circle: aim a little further along it (or at C)
    const ang = Math.atan2(py - oy, px - ox);
    let rem = (ca - ang) * side; while (rem < 0) rem += 2 * Math.PI; while (rem > 2 * Math.PI) rem -= 2 * Math.PI;
    if (rem < 0.7 || rem > 2 * Math.PI - 0.3) { _ap.tx = cx; _ap.ty = cy; } else {
      const a2 = ang + side * 0.7;
      _ap.tx = ox + r * Math.cos(a2); _ap.ty = oy + r * Math.sin(a2);
    }
  }
  return _ap;
}

// --------------------------------------------------------------------- shot
// Direction (2D unit) in which to hit a ball at b, for a car at (cx, cy) on team
// with attack sign s (+1 attacks +y). Returns {x, y, kind} kind: 'shot'|'clear'|'cut'|'centre'
const _shot = { x: 0, y: 1, kind: 'shot' };
export function shotDirection(bx, by, cx, cy, s, maxCut = 1.25, hx = 0, hy = 0, budget = 10) {
  const oppY = FIELD_Y * s;
  // aim point inside the opponent goal (posts inset by 200)
  const tx = clamp(bx, -GOAL_HW + 220, GOAL_HW - 220) * 0.7;
  let ax = tx - bx, ay = (oppY + s * 150) - by;
  let kind = 'shot';
  // deep in the opponent corner: centre the ball in front of goal instead
  if (Math.abs(bx) > 2300 && by * s > FIELD_Y - 1400) { ax = -bx * 0.9; ay = (oppY - s * 1500) - by; kind = 'centre'; }
  let al = Math.hypot(ax, ay); ax /= al; ay /= al;
  // approach direction (car -> ball)
  let px = bx - cx, py = by - cy;
  const pl = Math.hypot(px, py) || 1; px /= pl; py /= pl;
  const hasH = hx !== 0 || hy !== 0;
  // a direction is playable if it is within maxCut of the approach line and we
  // can still turn our heading onto it in the distance left (budget, rad)
  const ang = (x1, y1, x2, y2) => Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2);
  const ok = (dx, dy) => Math.abs(ang(px, py, dx, dy)) <= maxCut && (!hasH || Math.abs(ang(hx, hy, dx, dy)) <= budget);
  if (!ok(ax, ay)) {
    // in our half prefer a clear away from our goal
    const ownY = -FIELD_Y * s;
    let clx = bx * 0.6, cly = by - ownY;
    const cll = Math.hypot(clx, cly) || 1; clx /= cll; cly /= cll;
    if (by * s < 0 && ok(clx, cly)) { ax = clx; ay = cly; kind = 'clear'; } else {
      // best reachable: approach line rotated toward the wanted direction
      const cut = ang(px, py, ax, ay);
      let a = sign(cut) * Math.min(Math.abs(cut), maxCut);
      let dx = px * Math.cos(a) - py * Math.sin(a), dy = px * Math.sin(a) + py * Math.cos(a);
      if (hasH) {
        const hc = ang(hx, hy, dx, dy);
        if (Math.abs(hc) > budget) {
          const b2 = sign(hc) * budget;
          dx = hx * Math.cos(b2) - hy * Math.sin(b2); dy = hx * Math.sin(b2) + hy * Math.cos(b2);
        }
      }
      ax = dx; ay = dy; kind = 'cut';
    }
  }
  // never aim at our own goal when near it: deflect toward the nearest side wall
  if (ay * s < -0.55 && by * s < -1500) {
    const sx = bx !== 0 ? Math.sign(bx) : (px >= 0 ? 1 : -1);
    ax = sx * 0.94; ay = s * 0.34; kind = 'clear';
  }
  _shot.x = ax; _shot.y = ay; _shot.kind = kind;
  return _shot;
}

// ------------------------------------------------------------- reachability
// Rough feasibility of a ground car reaching (x, y) within t s, arriving
// roughly along (dx, dy). Returns slack distance (>= 0 feasible).
export function groundSlack(car, x, y, dx, dy, t, boost, extraTime = 0) {
  const p = car.body.pos, v = car.body.vel;
  const m = car.body.rot.m;
  let fx = m[0], fy = m[3];
  const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
  const rx = x - p.x, ry = y - p.y;
  const d = Math.hypot(rx, ry);
  if (d < 1) return 1e4;
  const ux = rx / d, uy = ry / d;
  const vf = v.x * fx + v.y * fy;           // forward speed
  const cosT = clamp(fx * ux + fy * uy, -1, 1);
  const turn = Math.acos(cosT);              // heading change needed
  const cosM = clamp(ux * dx + uy * dy, -1, 1); // arrival misalignment
  const misal = Math.acos(cosM);
  const r = turnRadius(Math.max(vf, 500));
  const pathLen = d + r * turn * 0.55 + Math.min(d, 1600) * 0.45 * misal * misal / 2.5;
  const vstart = vf * Math.max(cosT, -0.2);
  const tt = t - extraTime - turn * 0.18 - (vf < 0 ? 0.15 : 0);
  if (tt <= 0) return -pathLen;
  return driveDist(Math.max(vstart, 0), tt, boost) - pathLen;
}

// -------------------------------------------------------------- coordinator
// Shared per World, recomputed every 4 ticks: per car "challenge ETA", roles per
// team and kickoff takers. Humans are included (bots coordinate around them).
const coords = new WeakMap();
const _tv = new TrajView();

function quickEta(car, traj, s) {
  if (car.isDemoed) return 99;
  const n = traj.n;
  const p = car.body.pos;
  for (let i = 0; i < n; i += 3) {
    const bz = traj.pz(i);
    if (bz > 400) continue;
    const bx = traj.px(i), by = traj.py(i), t = traj.t(i);
    if (Math.abs(by) > FIELD_Y + 120) break;
    // contact point behind the ball as seen from the car
    let dx = bx - p.x, dy = by - p.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    if (groundSlack(car, bx - dx * 140, by - dy * 140, dx, dy, t, car.boost, car.isOnGround ? 0 : 0.35) >= 0) return t;
  }
  return 6;
}

export function coordinator(world) {
  let co = coords.get(world);
  if (!co) {
    co = { tick: -1, eta: new Map(), score: new Map(), role: new Map(), first: [-1, -1], oppEta: [6, 6], oppFirst: [-1, -1],
      kickTick: -1, kickTaker: [-1, -1], chat: { last: new Map() }, lastThreat: [false, false] };
    coords.set(world, co);
  }
  if (co.tick >= 0 && world.tick - co.tick < 4 && world.tick >= co.tick) return co;
  co.tick = world.tick;
  getTrajectory(world, _tv, 0, 2);
  const ball = world.ball.body.pos;
  for (const car of world.cars) {
    const s = car.team === 0 ? 1 : -1;
    const eta = quickEta(car, _tv, s);
    co.eta.set(car.id, eta);
    // challenge score: ETA + penalty for not being goal-side / facing away
    const p = car.body.pos;
    const goalSide = (ball.y - p.y) * s > -200;
    let score = eta + (goalSide ? 0 : 0.9);
    if (car.isDemoed) score = 99;
    const f = carFwd(car);
    const toB = Math.hypot(ball.x - p.x, ball.y - p.y) || 1;
    const facing = (f.x * (ball.x - p.x) + f.y * (ball.y - p.y)) / toB;
    score += (1 - facing) * 0.15;
    co.score.set(car.id, score);
  }
  for (let team = 0; team < 2; team++) {
    const mates = world.cars.filter((c) => c.team === team);
    const opps = world.cars.filter((c) => c.team !== team);
    let best = -1, bestScore = 1e9;
    for (const c of mates) { const sc = co.score.get(c.id); if (sc < bestScore) { bestScore = sc; best = c.id; } }
    const prev = co.first[team];
    if (prev >= 0 && prev !== best && co.score.has(prev) && co.score.get(prev) < bestScore + 0.3 && !world.getCar(prev)?.isDemoed) best = prev;
    co.first[team] = best;
    // rest: sorted by distance to own goal (closest = last man)
    const s = team === 0 ? 1 : -1;
    const rest = mates.filter((c) => c.id !== best && !c.isDemoed)
      .sort((a, b) => (a.body.pos.y * s) - (b.body.pos.y * s));
    co.role.set(best, 1);
    if (rest.length === 1) co.role.set(rest[0].id, 2);
    else if (rest.length >= 2) {
      co.role.set(rest[0].id, 3);
      for (let i = 1; i < rest.length; i++) co.role.set(rest[i].id, 2);
    }
    for (const c of mates) if (c.isDemoed) co.role.set(c.id, 2);
    let oe = 6, of = -1;
    for (const c of opps) { const e = co.eta.get(c.id); if (e < oe) { oe = e; of = c.id; } }
    co.oppEta[team] = oe; co.oppFirst[team] = of;
  }
  return co;
}

// Kickoff taker per team: closest to the ball, ties -> the "left" car
export function kickoffTakers(world, co) {
  if (co.kickTick === world.tick) return co.kickTaker;
  co.kickTick = world.tick;
  for (let team = 0; team < 2; team++) {
    const s = team === 0 ? 1 : -1;
    let best = null, bestD = 1e9;
    for (const c of world.cars) {
      if (c.team !== team || c.isDemoed) continue;
      const d = Math.hypot(c.body.pos.x, c.body.pos.y);
      // left from the team's view: blue (facing +y) left is -x; orange left is +x
      const leftKey = c.body.pos.x * s;
      if (d < bestD - 10 || (Math.abs(d - bestD) <= 10 && best && leftKey < best.body.pos.x * s)) { best = c; bestD = Math.min(d, bestD); }
    }
    co.kickTaker[team] = best ? best.id : -1;
  }
  return co.kickTaker;
}

// --------------------------------------------------------------- intercept
// Search the believed trajectory for the earliest ball state this car can play.
// Returns a plain object (reused) or null.
export function findIntercept(bot, car, traj, out) {
  const sk = bot.skill;
  const s = bot.s;
  const p = car.body.pos;
  const boost = car.boost;
  const reach1 = sk.jumpShots ? maxJumpHeight(false) + 17 + 70 : 0;
  const reach2 = sk.doubleJumps ? maxJumpHeight(true) + 17 + 60 : 0;
  const onGround = car.isOnGround && car.body.rot.m[8] > 0.8;
  const airPenalty = car.isOnGround ? 0 : 0.4;
  let aerialCand = null;
  out.found = false;
  const m = car.body.rot.m;
  const rTurn = turnRadius(Math.max(600, car.body.vel.x * m[0] + car.body.vel.y * m[3] + car.body.vel.z * m[6]));
  // current heading: velocity direction when moving, else the nose
  const vh = Math.hypot(car.body.vel.x, car.body.vel.y);
  let hx = vh > 400 ? car.body.vel.x / vh : m[0], hy = vh > 400 ? car.body.vel.y / vh : m[3];
  const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
  const vfwd = car.body.vel.x * m[0] + car.body.vel.y * m[3] + car.body.vel.z * m[6];
  const rAppr = turnRadius(clamp(Math.max(vfwd, 1000), 900, 1700)) * APPROACH_R;
  const noWait = bot.threat >= 0;
  let cutCand = null, cutWait = 0;
  const aerialSlack = bot.aerialSlack();
  const n = traj.n;
  const stride = 2; // slices are 2 ticks apart -> every 4 ticks
  for (let i = 1; i < n; i += stride) {
    const t = traj.t(i);
    const bx = traj.px(i), by = traj.py(i), bz = traj.pz(i);
    if (Math.abs(by) > FIELD_Y + 60 && Math.abs(bx) < GOAL_HW + 50) break; // goal
    let kind;
    if (bz < 160) kind = 'ground';
    else if (bz < reach1) kind = 'jump';
    else if (bz < reach2) kind = 'dbl';
    else kind = 'high';
    if (kind === 'high' && sk.wall && bz < 1700 && arenaSDF(bx, by, bz) < 230 && Math.abs(by) < FIELD_Y - 300) kind = 'wall';
    // how far we can redirect the ball depends on the room we have to curve in
    const dB = Math.hypot(bx - p.x, by - p.y);
    const sd = shotDirection(bx, by, p.x, p.y, s, sk.maxCut, hx, hy, (dB - 150) / rTurn + 0.4);
    const sdx = sd.x, sdy = sd.y;
    if (kind === 'ground' || kind === 'jump' || kind === 'dbl') {
      const off = kind === 'ground' ? 150 : 110;
      const cx = bx - sdx * off, cy = by - sdy * off;
      const extra = airPenalty + (kind === 'jump' ? 0.05 : kind === 'dbl' ? 0.12 : 0);
      if (cutCand && t > cutCand.t + cutWait) break;
      const slack = groundSlack(car, cx, cy, sdx, sdy, t, boost * sk.boostUse, extra);
      if (slack >= -20) {
        if (aerialCand && aerialCand.t + aerialSlack < t) break;
        if (sd.kind !== 'cut' || noWait) {
          if (!cutCand) return setOut(out, i, t, bx, by, bz, kind, sdx, sdy, sd.kind, traj);
        } else if (!cutCand) {
          // only a deflection is possible this early: look for a proper shot a bit later
          cutCand = { i, t, bx, by, bz, kind, sdx, sdy, sk: sd.kind };
          const oe = bot.co ? bot.co.oppEta[bot.team] : 6;
          cutWait = (by * s < -1000 || oe < t + 0.6) ? 0.15 : 0.9;
        }
      }
      if (cutCand) {
        // a full shot (attack direction) via a curved line+arc approach
        const att = shotDirection(bx, by, p.x, p.y, s, 10, 0, 0, 10);
        const ax = bx - att.x * off, ay = by - att.y * off;
        const ap = approachPath(p.x, p.y, ax, ay, att.x, att.y, rAppr);
        const tt = t - extra - 0.25;
        if (tt > 0 && driveDist(Math.max(vfwd, 0), tt, boost * sk.boostUse) >= ap.len) {
          return setOut(out, i, t, bx, by, bz, kind, att.x, att.y, att.kind, traj);
        }
      }
    } else if (kind === 'wall') {
      // drive along the wall surface: path = floor distance to the wall foot + climb
      const climb = bz - 100;
      const slack = groundSlack(car, bx, by, sdx, sdy, t, boost * sk.boostUse, airPenalty + 0.25) - climb;
      if (slack >= 0) {
        if (aerialCand && aerialCand.t + aerialSlack < t) break;
        return setOut(out, i, t, bx, by, bz, 'wall', sdx, sdy, sd.kind, traj);
      }
    }
    if (!aerialCand && sk.aerials && bz > 250 && bz < sk.aerialMaxZ && (onGround || !car.isOnGround) && t > 0.35 && t < 4) {
      // aerial: car origin a little behind the ball along the shot direction
      const tz = bz - 25;
      const tgt = { x: bx - sdx * 70, y: by - sdy * 70, z: tz };
      const dbl = sk.aerialDouble && bz > 700 && car.isOnGround;
      const req = aerialRequirement(car, tgt, t, dbl);
      if (req.acc < sk.aerialAcc && boost >= (req.acc / BOOST_ACC_AIR) * req.Te * 33.3 * 1.1 + 8) {
        aerialCand = { i, t, bx, by, bz, sdx, sdy, sk: sd.kind, dbl };
        if (bot.stats) bot.stats.aerialOptions = (bot.stats.aerialOptions || 0) + 1;
      }
    }
  }
  if (cutCand && !(aerialCand && aerialCand.t + aerialSlack < cutCand.t)) {
    const a = cutCand;
    return setOut(out, a.i, a.t, a.bx, a.by, a.bz, a.kind, a.sdx, a.sdy, a.sk, traj);
  }
  if (aerialCand) {
    const a = aerialCand;
    setOut(out, a.i, a.t, a.bx, a.by, a.bz, 'aerial', a.sdx, a.sdy, a.sk, traj);
    out.dbl = a.dbl;
    return out;
  }
  return null;
}

function setOut(out, i, t, bx, by, bz, kind, sdx, sdy, sk, traj) {
  out.found = true; out.i = i; out.t = t; out.tick = traj.tick0 + i * traj.step;
  out.x = bx; out.y = by; out.z = bz; out.kind = kind; out.sdx = sdx; out.sdy = sdy; out.shotKind = sk;
  out.trajId = traj.id; out.dbl = false;
  return out;
}

// Does the believed trajectory enter our goal? -> time (s) or -1
export function goalThreat(traj, s) {
  const ownY = -FIELD_Y * s;
  for (let i = 0; i < traj.n; i += 2) {
    const by = traj.py(i);
    if (by * s < -(FIELD_Y + 60) && Math.abs(traj.px(i)) < GOAL_HW + 60) return traj.t(i);
  }
  return -1;
}

export { PI, angle2D };
