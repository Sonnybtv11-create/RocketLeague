// TURBO PITCH bots — small allocation-light math helpers on plain {x,y,z}
// objects and the low-level car controllers shared by every bot behaviour
// (ground steering PD, air orientation PD).  Pure JS: runs in Node and browser.
//
// Sim conventions (see src/contracts.js): Z up, car rotation matrix is
// row-major with COLUMNS forward / right / up.  Inputs:
//   pitch +  -> nose up      (angular accel about -right)
//   yaw   +  -> nose right   (angular accel about +up)
//   roll  +  -> roll right   (angular accel about -forward)
//   steer +  -> turn right

export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const GRAVITY = 650;
export const BALL_R = 91.25;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
export const sign = (v) => (v >= 0 ? 1 : -1);
export const lerp = (a, b, t) => a + (b - a) * t;

export const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const vcopy = (o, a) => { o.x = a.x; o.y = a.y; o.z = a.z; return o; };
export const vset = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vscale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const vlen = (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const vlen2D = (a) => Math.sqrt(a.x * a.x + a.y * a.y);
export const dist = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); };
export const dist2D = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); };
export function vnorm(a) {
  const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}
export function vnorm2D(a) {
  const l = Math.sqrt(a.x * a.x + a.y * a.y);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: 0 } : { x: 1, y: 0, z: 0 };
}
export const flat = (a) => ({ x: a.x, y: a.y, z: 0 });
export function angleBetween(a, b) {
  const la = vlen(a), lb = vlen(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(clamp(vdot(a, b) / (la * lb), -1, 1));
}
// signed 2D angle from a to b (positive = b is "to the right" of a in sim coords,
// i.e. rotating +x toward +y)
export function angle2D(a, b) {
  return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
}
export function rotate2D(v, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}
export const wrapAngle = (a) => { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; };

// --- car frame helpers -------------------------------------------------------
// Car axes from the row-major rotation matrix (columns fwd/right/up).
export const carFwd = (car) => { const m = car.body.rot.m; return { x: m[0], y: m[3], z: m[6] }; };
export const carRight = (car) => { const m = car.body.rot.m; return { x: m[1], y: m[4], z: m[7] }; };
export const carUp = (car) => { const m = car.body.rot.m; return { x: m[2], y: m[5], z: m[8] }; };
// world vector -> car local (R^T v)
export function toLocal(car, v) {
  const m = car.body.rot.m;
  return {
    x: m[0] * v.x + m[3] * v.y + m[6] * v.z,
    y: m[1] * v.x + m[4] * v.y + m[7] * v.z,
    z: m[2] * v.x + m[5] * v.y + m[8] * v.z,
  };
}
export function localTarget(car, p) {
  const b = car.body.pos;
  return toLocal(car, { x: p.x - b.x, y: p.y - b.y, z: p.z - b.z });
}

// --- air orientation controller ----------------------------------------------
// Drive the car's orientation toward (targetFwd, targetUp). targetUp may be null
// (then the current up, made orthogonal to targetFwd, is kept: minimum roll).
// Writes c.pitch, c.yaw, c.roll. Returns the remaining rotation angle (rad).
// Uses the relative rotation's axis-angle in the car frame and a per-axis
// "bang-bang with braking curve" law (time-optimal for a double integrator).
const ACC_PITCH = 12.46, ACC_YAW = 9.11, ACC_ROLL = 38.35;
export function orientTo(car, tf, tu, c, opts) {
  const m = car.body.rot.m;
  // target basis
  let f = vnorm(tf);
  let u;
  if (tu) u = tu; else u = { x: m[2], y: m[5], z: m[8] };
  // r = u x f, then re-orthogonalise u = f x r
  let r = vcross(u, f);
  let rl = vlen(r);
  if (rl < 1e-6) {
    // up parallel to forward: pick current right
    r = { x: m[1], y: m[4], z: m[7] };
    r = vsub(r, vscale(f, vdot(r, f)));
    rl = vlen(r);
  }
  r = vscale(r, 1 / rl);
  u = vcross(f, r);
  // Q = R^T * Rt (Rt columns f, r, u). Q[i][j] = col_i(R) . col_j(Rt)
  const cf = { x: m[0], y: m[3], z: m[6] }, cr = { x: m[1], y: m[4], z: m[7] }, cu = { x: m[2], y: m[5], z: m[8] };
  const q00 = vdot(cf, f), q01 = vdot(cf, r), q02 = vdot(cf, u);
  const q10 = vdot(cr, f), q11 = vdot(cr, r), q12 = vdot(cr, u);
  const q20 = vdot(cu, f), q21 = vdot(cu, r), q22 = vdot(cu, u);
  const tr = q00 + q11 + q22;
  const ang = Math.acos(clamp((tr - 1) / 2, -1, 1));
  let ex, ey, ez;
  if (ang < 1e-4) { ex = 0; ey = 0; ez = 0; } else if (ang > PI - 1e-3) {
    // 180°: axis from the diagonal
    const xx = Math.sqrt(Math.max(0, (q00 + 1) / 2)), yy = Math.sqrt(Math.max(0, (q11 + 1) / 2)), zz = Math.sqrt(Math.max(0, (q22 + 1) / 2));
    ex = xx * ang; ey = (q01 >= 0 ? yy : -yy) * ang; ez = (q02 >= 0 ? zz : -zz) * ang;
  } else {
    const s = ang / (2 * Math.sin(ang));
    ex = (q21 - q12) * s; ey = (q02 - q20) * s; ez = (q10 - q01) * s;
  }
  // local angular velocity
  const w = car.body.angVel;
  const wx = m[0] * w.x + m[3] * w.y + m[6] * w.z;
  const wy = m[1] * w.x + m[4] * w.y + m[7] * w.z;
  const wz = m[2] * w.x + m[5] * w.y + m[8] * w.z;
  const k = (opts && opts.gain) || 1;
  const sharp = (opts && opts.sharp) || 0.75;
  // desired local angular velocity: braking curve sqrt(2 a |e|)
  const wdx = sign(ex) * Math.sqrt(2 * ACC_ROLL * sharp * Math.abs(ex));
  const wdy = sign(ey) * Math.sqrt(2 * ACC_PITCH * sharp * Math.abs(ey));
  const wdz = sign(ez) * Math.sqrt(2 * ACC_YAW * sharp * Math.abs(ez));
  // pitch accelerates wl.y negatively, roll accelerates wl.x negatively
  c.roll = clamp1(-(wdx - wx) * 0.35 * k);
  c.pitch = clamp1(-(wdy - wy) * 0.9 * k);
  c.yaw = clamp1((wdz - wz) * 0.9 * k);
  return ang;
}

// --- ground steering -----------------------------------------------------------
// PD on the heading error; returns steer in [-1, 1]. `angle` = signed angle to
// target in the car's ground plane (positive = right).
export function steerPD(car, angle) {
  const m = car.body.rot.m, w = car.body.angVel;
  const yawRate = m[2] * w.x + m[5] * w.y + m[8] * w.z; // local z angular velocity (+ = turning right)
  return clamp1(angle * 3.2 - yawRate * 0.28);
}

// --- arena helpers --------------------------------------------------------------
export const FIELD_X = 4096, FIELD_Y = 5120, GOAL_HW = 892.755, GOAL_H = 642.775;
// clamp a ground target so it stays drivable (inside the octagon, off the walls)
export function clampToField(p, margin = 150) {
  const X = FIELD_X - margin, Y = FIELD_Y - margin;
  let x = clamp(p.x, -X, X);
  let y = p.y;
  // allow going into the goal mouth
  if (Math.abs(x) < GOAL_HW - 100) y = clamp(y, -(FIELD_Y + 800), FIELD_Y + 800);
  else y = clamp(y, -Y, Y);
  // corner cut |x| + |y| <= X + Y - C
  const D = FIELD_X + FIELD_Y - 1152 - margin * 1.414;
  const s = Math.abs(x) + Math.abs(y);
  if (s > D && Math.abs(y) <= FIELD_Y) {
    const k = (s - D) / 2;
    x -= Math.sign(x) * k; y -= Math.sign(y) * k;
  }
  return { x, y, z: p.z };
}
