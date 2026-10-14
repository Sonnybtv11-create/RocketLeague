// TURBO PITCH bots — physics lookup tables, calibrated once (lazily) against the
// real car simulation with a private World, so the bots' time-to-reach and jump
// timing estimates always match the sim they drive.
//
//   driveDist(v0, t, boost)  distance (uu) covered driving straight for t s from
//                            forward speed v0 with `boost` units available
//   driveSpeed(v0, t, boost) forward speed after that
//   jumpHeight(t, dbl)       car-origin height gain t s after pressing jump
//                            (full 0.2 s hold; dbl: second jump right after)
//   jumpTimeTo(h, dbl)       earliest time the car origin has risen h uu (-1: never)
import { World } from '../sim/world.js';
import { makeControls } from '../contracts.js';

const DT = 1 / 120;
const BOOST_PER_S = 100 / 3;

let T = null;

function simulate(n, ctl, rec, setup) {
  const w = new World();
  w.unlimitedBoost = true;
  const car = w.addCar({ team: 0, isBot: false });
  car.setSpawn(0, -4900, 17, Math.PI / 2, 100);
  w.ball.reset(3500, 4000, 93.15);
  for (let i = 0; i < 40; i++) { car.controls = makeControls(); w.step(); }
  if (setup) setup(car);
  const y0 = car.body.pos.y, z0 = car.body.pos.z;
  for (let i = 0; i < n; i++) {
    const c = makeControls();
    ctl(c, i);
    car.controls = c;
    w.step();
    rec(i, car, y0, z0);
  }
}

function build() {
  // (beyond the end of a table the speed is constant: 2300 boosting, 1410 throttle)
  const NB = 260, NT = 380;
  const bv = new Float64Array(NB + 1), bx = new Float64Array(NB + 1);
  const tv = new Float64Array(NT + 1), tx = new Float64Array(NT + 1);
  simulate(NB, (c) => { c.throttle = 1; c.boost = true; }, (i, car, y0) => { bv[i + 1] = Math.min(2300, car.body.vel.y); bx[i + 1] = car.body.pos.y - y0; });
  simulate(NT, (c) => { c.throttle = 1; }, (i, car, y0) => { tv[i + 1] = Math.min(1410, car.body.vel.y); tx[i + 1] = car.body.pos.y - y0; });
  bv[NB] = 2300; tv[NT] = 1410;
  // make velocity tables monotonic (numerical noise)
  for (let i = 1; i <= NB; i++) if (bv[i] < bv[i - 1]) bv[i] = bv[i - 1];
  for (let i = 1; i <= NT; i++) if (tv[i] < tv[i - 1]) tv[i] = tv[i - 1];
  const JN = 200;
  const j1 = new Float64Array(JN + 1), j2 = new Float64Array(JN + 1);
  const j1v = new Float64Array(JN + 1), j2v = new Float64Array(JN + 1);
  simulate(JN, (c, i) => { c.jump = i < 24; }, (i, car, y0, z0) => { j1[i + 1] = car.body.pos.z - z0; j1v[i + 1] = car.body.vel.z; });
  simulate(JN, (c, i) => { c.jump = i < 24 || (i >= 26 && i < 30); }, (i, car, y0, z0) => { j2[i + 1] = car.body.pos.z - z0; j2v[i + 1] = car.body.vel.z; });
  T = { bv, bx, tv, tx, JN, j1, j2, j1v, j2v,
    j1max: Math.max(...j1), j2max: Math.max(...j2) };
}

export function tables() { if (!T) build(); return T; }

// index (fractional) in a monotonic velocity table where speed v is reached
function velIndex(tab, v) {
  let lo = 0, hi = tab.length - 1;
  if (v <= tab[0]) return 0;
  if (v >= tab[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tab[mid] < v) lo = mid; else hi = mid; }
  const a = tab[lo], b = tab[hi];
  return lo + (b > a ? (v - a) / (b - a) : 0);
}
function sampleX(xt, vt, idx) {
  const n = xt.length - 1;
  if (idx >= n) return xt[n] + vt[n] * (idx - n) * DT;
  const i = Math.floor(idx), f = idx - i;
  return xt[i] + (xt[i + 1] - xt[i]) * f;
}
function sampleV(vt, idx) {
  const n = vt.length - 1;
  if (idx >= n) return vt[n];
  const i = Math.floor(idx), f = idx - i;
  return vt[i] + (vt[i + 1] - vt[i]) * f;
}

// Phase helper: straight-line drive along one table from speed v0 for t s.
// Results in module scratch (_pd distance, _pv speed) -> no allocation.
let _pd = 0, _pv = 0;
function phase(xt, vt, v0, t) {
  const i0 = velIndex(vt, v0);
  const i1 = i0 + t / DT;
  _pd = sampleX(xt, vt, i1) - sampleX(xt, vt, i0); _pv = sampleV(vt, i1);
}

const _res = { d: 0, v: 0 };
export function drive(v0, t, boost) {
  const tb = tables();
  if (t <= 0) { _res.d = 0; _res.v = v0; return _res; }
  if (v0 < 0) { // braking from reverse: ~3500 uu/s² decel, no progress
    const tbk = -v0 / 3500;
    if (tbk >= t) { _res.d = 0; _res.v = 0; return _res; }
    t -= tbk; v0 = 0;
  }
  const boostTime = boost / BOOST_PER_S;
  if (v0 > 1410 && boostTime <= 0) { _res.d = v0 * t; _res.v = v0; return _res; }
  if (boostTime >= t) { phase(tb.bx, tb.bv, v0, t); _res.d = _pd; _res.v = _pv; return _res; }
  let d = 0, v = v0;
  if (boostTime > 0) { phase(tb.bx, tb.bv, v0, boostTime); d += _pd; v = _pv; t -= boostTime; }
  if (v >= 1410) { d += v * t; } else { phase(tb.tx, tb.tv, v, t); d += _pd; v = _pv; }
  _res.d = d; _res.v = v; return _res;
}
export const driveDist = (v0, t, boost) => drive(v0, t, boost).d;

// Time to drive `d` uu straight (binary search on drive()).
export function driveTime(d, v0, boost) {
  if (d <= 0) return 0;
  let lo = 0, hi = 0.5;
  while (driveDist(v0, hi, boost) < d && hi < 30) hi *= 2;
  for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (driveDist(v0, mid, boost) < d) lo = mid; else hi = mid; }
  return hi;
}

export function jumpHeight(t, dbl) {
  const tb = tables(); const tab = dbl ? tb.j2 : tb.j1;
  const idx = t / DT;
  if (idx <= 0) return 0;
  if (idx >= tb.JN) return tab[tb.JN];
  const i = Math.floor(idx), f = idx - i;
  return tab[i] + (tab[i + 1] - tab[i]) * f;
}
// earliest time (rising) the car origin rises by h; -1 if unreachable
export function jumpTimeTo(h, dbl) {
  const tb = tables(); const tab = dbl ? tb.j2 : tb.j1;
  if (h <= 0) return 0;
  for (let i = 1; i <= tb.JN; i++) {
    if (tab[i] >= h) { const a = tab[i - 1], b = tab[i]; return (i - 1 + (h - a) / (b - a)) * DT; }
    if (tab[i] < tab[i - 1]) return -1; // started falling
  }
  return -1;
}
export const maxJumpHeight = (dbl) => (dbl ? tables().j2max : tables().j1max);
