// Small vector / matrix library for the simulation (Unreal Units, Z-up).
// Vec3 methods return new vectors unless suffixed with "Self"/"In".

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static from(o) { return new Vec3(o.x, o.y, o.z); }
  clone() { return new Vec3(this.x, this.y, this.z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; }
  add(o) { return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z); }
  sub(o) { return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z); }
  mul(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
  mulV(o) { return new Vec3(this.x * o.x, this.y * o.y, this.z * o.z); }
  neg() { return new Vec3(-this.x, -this.y, -this.z); }
  dot(o) { return this.x * o.x + this.y * o.y + this.z * o.z; }
  cross(o) {
    return new Vec3(
      this.y * o.z - this.z * o.y,
      this.z * o.x - this.x * o.z,
      this.x * o.y - this.y * o.x);
  }
  len() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  len2() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  len2D() { return Math.sqrt(this.x * this.x + this.y * this.y); }
  normalized() {
    const l = this.len();
    return l > 1e-12 ? new Vec3(this.x / l, this.y / l, this.z / l) : new Vec3();
  }
  dist(o) { const dx = this.x - o.x, dy = this.y - o.y, dz = this.z - o.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  dist2D(o) { const dx = this.x - o.x, dy = this.y - o.y; return Math.sqrt(dx * dx + dy * dy); }
  isZero() { return this.x === 0 && this.y === 0 && this.z === 0; }
  addSelf(o) { this.x += o.x; this.y += o.y; this.z += o.z; return this; }
  subSelf(o) { this.x -= o.x; this.y -= o.y; this.z -= o.z; return this; }
  addScaledSelf(o, s) { this.x += o.x * s; this.y += o.y * s; this.z += o.z * s; return this; }
  mulSelf(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  to2D() { return new Vec3(this.x, this.y, 0); }
}

export const v3 = (x, y, z) => new Vec3(x, y, z);

// Rotation matrix, row-major. Columns are the body axes in world space:
// column 0 = forward, column 1 = right, column 2 = up (RocketSim convention).
export class RotMat {
  constructor(m) { this.m = m ? Float64Array.from(m) : new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); }
  clone() { return new RotMat(this.m); }
  copy(o) { this.m.set(o.m); return this; }
  get forward() { const m = this.m; return new Vec3(m[0], m[3], m[6]); }
  get right() { const m = this.m; return new Vec3(m[1], m[4], m[7]); }
  get up() { const m = this.m; return new Vec3(m[2], m[5], m[8]); }
  col(i) { const m = this.m; return new Vec3(m[i], m[3 + i], m[6 + i]); }
  // world = R * local
  mulVec(v) {
    const m = this.m;
    return new Vec3(
      m[0] * v.x + m[1] * v.y + m[2] * v.z,
      m[3] * v.x + m[4] * v.y + m[5] * v.z,
      m[6] * v.x + m[7] * v.y + m[8] * v.z);
  }
  // local = R^T * world
  mulVecT(v) {
    const m = this.m;
    return new Vec3(
      m[0] * v.x + m[3] * v.y + m[6] * v.z,
      m[1] * v.x + m[4] * v.y + m[7] * v.z,
      m[2] * v.x + m[5] * v.y + m[8] * v.z);
  }
  mul(o) {
    const a = this.m, b = o.m, r = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return new RotMat(r);
  }
  transpose() {
    const m = this.m;
    return new RotMat([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
  }
  static fromAxes(fwd, right, up) {
    return new RotMat([fwd.x, right.x, up.x, fwd.y, right.y, up.y, fwd.z, right.z, up.z]);
  }
  // Re-orthonormalize (Gram-Schmidt on forward/right, up = f x r)
  orthonormalize() {
    let f = this.forward.normalized();
    let r = this.right;
    r = r.sub(f.mul(f.dot(r))).normalized();
    const u = f.cross(r);
    this.m.set([f.x, r.x, u.x, f.y, r.y, u.y, f.z, r.z, u.z]);
    return this;
  }
}

// Bullet btMatrix3x3::setEulerYPR(yaw, pitch, roll) as used by RocketSim:
// Angle(yaw, pitch, roll).ToRotMat() == setEulerYPR(yaw, -pitch, -roll)
export function rotMatFromYPR(yaw, pitch = 0, roll = 0) {
  // setEulerYPR(yaw=Z, pitch=Y, roll=X) -> setEulerZYX(roll, pitch, yaw)
  const eulerX = -roll, eulerY = -pitch, eulerZ = yaw;
  const ci = Math.cos(eulerX), cj = Math.cos(eulerY), ch = Math.cos(eulerZ);
  const si = Math.sin(eulerX), sj = Math.sin(eulerY), sh = Math.sin(eulerZ);
  const cc = ci * ch, cs = ci * sh, sc = si * ch, ss = si * sh;
  return new RotMat([
    cj * ch, sj * sc - cs, sj * cc + ss,
    cj * sh, sj * ss + cc, sj * cs - sc,
    -sj, cj * si, cj * ci,
  ]);
}

// Inverse of the above: returns {yaw, pitch, roll} in RocketSim convention
export function yprFromRotMat(rm) {
  const m = rm.m;
  // btMatrix3x3::getEulerYPR, then RocketSim negates pitch & roll
  const yaw = Math.atan2(m[3], m[0]);
  const pitch = Math.asin(clamp(-m[6], -1, 1));
  const roll = Math.atan2(m[7], m[8]);
  return { yaw, pitch: -pitch, roll: -roll };
}

// Rotate matrix by angular velocity w (world space) over dt (exact axis-angle)
export function integrateRotation(rm, w, dt) {
  const ang = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
  if (ang < 1e-12) return rm;
  const ax = w.x / ang, ay = w.y / ang, az = w.z / ang;
  const th = ang * dt;
  const c = Math.cos(th), s = Math.sin(th), t = 1 - c;
  const r = new RotMat([
    t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay,
    t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax,
    t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c,
  ]);
  const out = r.mul(rm);
  out.orthonormalize();
  return out;
}

// RocketSim LinearPieceCurve
export class Curve {
  constructor(points) { this.p = points; }
  get(x) {
    const p = this.p;
    if (p.length === 0) return 1;
    if (x <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (x < p[i][0]) {
        const [x0, y0] = p[i - 1], [x1, y1] = p[i];
        return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
      }
    }
    return p[p.length - 1][1];
  }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const lerp = (a, b, t) => a + (b - a) * t;

// Seeded RNG (mulberry32) so sims/replays can be deterministic if desired
export function makeRng(seed = 1234567) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
