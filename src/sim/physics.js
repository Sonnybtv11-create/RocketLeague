// Rigid bodies, contact generation and a Bullet-style sequential impulse solver.
// Mirrors btSequentialImpulseConstraintSolver as configured by RocketSim:
// 10 iterations, split impulse for penetration (erp2 = 0.8), restitution
// threshold 10 uu/s, friction solved after normals each iteration.

import { Vec3, RotMat, integrateRotation } from './math.js';
import { arenaSDF, arenaNormal } from './arena.js';
import { SOLVER_ITERATIONS, SOLVER_ERP2, RESTITUTION_VEL_THRESHOLD } from './const.js';

export class RigidBody {
  constructor(mass, inertiaDiag) {
    this.pos = new Vec3();
    this.vel = new Vec3();
    this.angVel = new Vec3();
    this.rot = new RotMat();
    this.mass = mass;
    this.invMass = mass > 0 ? 1 / mass : 0;
    this.inertia = inertiaDiag; // local diagonal
    this.invInertia = new Vec3(
      inertiaDiag.x > 0 ? 1 / inertiaDiag.x : 0,
      inertiaDiag.y > 0 ? 1 / inertiaDiag.y : 0,
      inertiaDiag.z > 0 ? 1 / inertiaDiag.z : 0);
    // accumulated per-tick force (kg uu/s^2) and angular acceleration (rad/s^2)
    this.force = new Vec3();
    this.angAccel = new Vec3();
    // split-impulse pseudo velocities
    this.pushVel = new Vec3();
    this.turnVel = new Vec3();
    // velocity added at the end of the tick (RocketSim _velocityImpulseCache)
    this.velCache = new Vec3();
    this.active = true;
  }
  // I_world^-1 * v
  invInertiaMul(v) {
    const l = this.rot.mulVecT(v);
    l.x *= this.invInertia.x; l.y *= this.invInertia.y; l.z *= this.invInertia.z;
    return this.rot.mulVec(l);
  }
  // I_world * v
  inertiaMul(v) {
    const l = this.rot.mulVecT(v);
    l.x *= this.inertia.x; l.y *= this.inertia.y; l.z *= this.inertia.z;
    return this.rot.mulVec(l);
  }
  velAt(rel) { return this.vel.add(this.angVel.cross(rel)); }
  applyImpulse(imp, rel) {
    if (!this.invMass) return;
    this.vel.addScaledSelf(imp, this.invMass);
    this.angVel.addSelf(this.invInertiaMul(rel.cross(imp)));
  }
  applyCentralImpulse(imp) { this.vel.addScaledSelf(imp, this.invMass); }
  applyCentralForce(f) { this.force.addSelf(f); }
  // impulse denominator along n at rel (btRigidBody::computeImpulseDenominator)
  impulseDenom(rel, n) {
    if (!this.invMass) return 0;
    const c = rel.cross(n);
    const vec = this.invInertiaMul(c).cross(rel);
    return this.invMass + n.dot(vec);
  }
}

// ---- contact generation ------------------------------------------------------
// Contact normal n points from B to A (direction A must move to separate).
// depth: signed distance (negative = penetration).
export function makeContact(a, b, pA, pB, n, depth, friction, restitution) {
  return { a, b, pA, pB, n, depth, friction, restitution, kind: null };
}

const _n = new Vec3();

// Sphere (ball) vs arena
export function ballWorldContact(ball, radius, worldRadius, margin) {
  const p = ball.pos;
  const d = arenaSDF(p.x, p.y, p.z);
  const depth = d - worldRadius;
  if (depth > margin) return null;
  arenaNormal(p.x, p.y, p.z, _n);
  const n = new Vec3(_n.x, _n.y, _n.z);
  const pA = p.sub(n.mul(radius));
  return { n, depth, pA };
}

// Car hitbox sample points (local, relative to hitbox centre, unit cube corners/edges/faces)
const BOX_SAMPLES = [];
for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
  if (i === 0 && j === 0 && k === 0) continue;
  BOX_SAMPLES.push([i, j, k]);
}

export function carWorldContacts(car, margin, out) {
  const b = car.body, hs = car.halfSize, off = car.config.hitboxOffset;
  const R = b.rot;
  let count = 0;
  // quick reject: distance from hitbox centre
  const cLocal = new Vec3(off.x, off.y, off.z);
  const c = b.pos.add(R.mulVec(cLocal));
  const bound = Math.sqrt(hs.x * hs.x + hs.y * hs.y + hs.z * hs.z);
  const dc = arenaSDF(c.x, c.y, c.z);
  if (dc > bound + margin) return 0;
  const cand = [];
  for (const s of BOX_SAMPLES) {
    const local = new Vec3(off.x + s[0] * hs.x, off.y + s[1] * hs.y, off.z + s[2] * hs.z);
    const p = b.pos.add(R.mulVec(local));
    const d = arenaSDF(p.x, p.y, p.z);
    if (d < margin) cand.push({ p, d, w: (s[0] !== 0) + (s[1] !== 0) + (s[2] !== 0) });
  }
  if (!cand.length) return 0;
  // keep corners first, then deepest, at most 8
  cand.sort((u, v) => (u.d - v.d) || (v.w - u.w));
  for (const c2 of cand.slice(0, 8)) {
    arenaNormal(c2.p.x, c2.p.y, c2.p.z, _n);
    out.push({ n: new Vec3(_n.x, _n.y, _n.z), depth: c2.d, pA: c2.p });
    count++;
  }
  return count;
}

// OBB (car hitbox) vs sphere. Returns {n (from car to ball), depth, pCar, pBall} or null
export function carBallContact(car, ball, radius, margin) {
  const b = car.body, hs = car.halfSize, off = car.config.hitboxOffset;
  const R = b.rot;
  const rel = R.mulVecT(ball.pos.sub(b.pos));
  const lx = rel.x - off.x, ly = rel.y - off.y, lz = rel.z - off.z;
  const cx = Math.max(-hs.x, Math.min(hs.x, lx));
  const cy = Math.max(-hs.y, Math.min(hs.y, ly));
  const cz = Math.max(-hs.z, Math.min(hs.z, lz));
  let dx = lx - cx, dy = ly - cy, dz = lz - cz;
  let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let nLocal, depth;
  if (dist > 1e-6) {
    depth = dist - radius;
    if (depth > margin) return null;
    nLocal = new Vec3(dx / dist, dy / dist, dz / dist);
  } else {
    // centre inside box: push out along the axis of least penetration
    const px = hs.x - Math.abs(lx), py = hs.y - Math.abs(ly), pz = hs.z - Math.abs(lz);
    if (px <= py && px <= pz) { nLocal = new Vec3(Math.sign(lx) || 1, 0, 0); depth = -px - radius; }
    else if (py <= pz) { nLocal = new Vec3(0, Math.sign(ly) || 1, 0); depth = -py - radius; }
    else { nLocal = new Vec3(0, 0, Math.sign(lz) || 1); depth = -pz - radius; }
  }
  const pCarLocal = new Vec3(cx + off.x, cy + off.y, cz + off.z);
  const pCar = b.pos.add(R.mulVec(pCarLocal));
  const n = R.mulVec(nLocal); // from car towards ball
  const pBall = ball.pos.sub(n.mul(radius));
  return { n, depth, pCar, pBall, pCarLocal };
}

// ---- OBB vs OBB (SAT + clipping) --------------------------------------------
function boxOf(car) {
  const b = car.body, off = car.config.hitboxOffset;
  const R = b.rot;
  return {
    c: b.pos.add(R.mulVec(new Vec3(off.x, off.y, off.z))),
    ax: [R.forward, R.right, R.up],
    h: [car.halfSize.x, car.halfSize.y, car.halfSize.z],
  };
}

function boxVerticesOfFace(box, axis, sign) {
  // face perpendicular to box.ax[axis] on side sign; returns 4 vertices CCW-ish
  const i = axis, j = (axis + 1) % 3, k = (axis + 2) % 3;
  const fc = box.c.add(box.ax[i].mul(box.h[i] * sign));
  const uj = box.ax[j].mul(box.h[j]), uk = box.ax[k].mul(box.h[k]);
  return [fc.add(uj).add(uk), fc.sub(uj).add(uk), fc.sub(uj).sub(uk), fc.add(uj).sub(uk)];
}

function clipPolygon(poly, n, d) {
  // keep points with p·n <= d
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = p.dot(n) - d, dq = q.dot(n) - d;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push(p.add(q.sub(p).mul(t)));
    }
  }
  return out;
}

function closestSegSeg(p1, q1, p2, q2) {
  const d1 = q1.sub(p1), d2 = q2.sub(p2), r = p1.sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  const c = d1.dot(r), b = d1.dot(d2), den = a * e - b * b;
  s = den > 1e-9 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
  t = (b * s + f) / e;
  if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
  else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
  return [p1.add(d1.mul(s)), p2.add(d2.mul(t))];
}

// Returns array of {n (B->A), depth, pA, pB}
export function carCarContacts(carA, carB, margin) {
  const A = boxOf(carA), B = boxOf(carB);
  const d = A.c.sub(B.c);
  // broad phase
  const ra = Math.hypot(A.h[0], A.h[1], A.h[2]), rb = Math.hypot(B.h[0], B.h[1], B.h[2]);
  if (d.len() > ra + rb + margin) return [];
  let best = null;
  const test = (L, type, i, j) => {
    const l = L.len();
    if (l < 1e-6) return true;
    const n = L.mul(1 / l);
    const projA = A.h[0] * Math.abs(A.ax[0].dot(n)) + A.h[1] * Math.abs(A.ax[1].dot(n)) + A.h[2] * Math.abs(A.ax[2].dot(n));
    const projB = B.h[0] * Math.abs(B.ax[0].dot(n)) + B.h[1] * Math.abs(B.ax[1].dot(n)) + B.h[2] * Math.abs(B.ax[2].dot(n));
    const dist = d.dot(n);
    const overlap = projA + projB - Math.abs(dist);
    if (overlap < -margin) return false;
    // bias towards face axes
    const score = type === 2 ? overlap * 1.05 + 0.5 : overlap;
    if (!best || score < best.score) {
      best = { score, overlap, n: dist < 0 ? n.neg() : n, type, i, j };
    }
    return true;
  };
  for (let i = 0; i < 3; i++) if (!test(A.ax[i], 0, i, -1)) return [];
  for (let i = 0; i < 3; i++) if (!test(B.ax[i], 1, i, -1)) return [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!test(A.ax[i].cross(B.ax[j]), 2, i, j)) return [];
  const n = best.n; // from B to A
  const contacts = [];
  if (best.type === 2) {
    // edge-edge
    const i = best.i, j = best.j;
    let pa = A.c.clone();
    for (let k = 0; k < 3; k++) if (k !== i) pa = pa.add(A.ax[k].mul(A.h[k] * (A.ax[k].dot(n) > 0 ? -1 : 1)));
    let pb = B.c.clone();
    for (let k = 0; k < 3; k++) if (k !== j) pb = pb.add(B.ax[k].mul(B.h[k] * (B.ax[k].dot(n) > 0 ? 1 : -1)));
    const [ca, cb] = closestSegSeg(pa.sub(A.ax[i].mul(A.h[i])), pa.add(A.ax[i].mul(A.h[i])),
      pb.sub(B.ax[j].mul(B.h[j])), pb.add(B.ax[j].mul(B.h[j])));
    contacts.push({ n, depth: -best.overlap, pA: ca, pB: cb });
    return contacts;
  }
  // face contact
  const refIsA = best.type === 0;
  const ref = refIsA ? A : B, inc = refIsA ? B : A;
  const ri = best.i;
  // reference face normal points towards the other box
  const towards = refIsA ? n.neg() : n;
  const rs = ref.ax[ri].dot(towards) > 0 ? 1 : -1;
  const refN = ref.ax[ri].mul(rs);
  // incident face: most anti-parallel to refN
  let ii = 0, idot = Infinity, isgn = 1;
  for (let k = 0; k < 3; k++) {
    const dd = inc.ax[k].dot(refN);
    if (-Math.abs(dd) < idot) { idot = -Math.abs(dd); ii = k; isgn = dd > 0 ? -1 : 1; }
  }
  let poly = boxVerticesOfFace(inc, ii, isgn);
  const refC = ref.c.add(refN.mul(ref.h[ri]));
  const j = (ri + 1) % 3, k = (ri + 2) % 3;
  const sides = [[ref.ax[j], ref.h[j]], [ref.ax[j].neg(), ref.h[j]], [ref.ax[k], ref.h[k]], [ref.ax[k].neg(), ref.h[k]]];
  for (const [sn, sh] of sides) {
    poly = clipPolygon(poly, sn, sn.dot(ref.c) + sh);
    if (!poly.length) break;
  }
  for (const p of poly) {
    const sep = p.sub(refC).dot(refN);
    if (sep <= margin) {
      const onRef = p.sub(refN.mul(sep));
      if (refIsA) contacts.push({ n, depth: sep, pA: onRef, pB: p });
      else contacts.push({ n, depth: sep, pA: p, pB: onRef });
    }
  }
  if (contacts.length > 4) {
    contacts.sort((u, v) => u.depth - v.depth);
    contacts.length = 4;
  }
  return contacts;
}

// Ray vs sphere: returns t or -1
export function raySphere(o, dir, c, r, maxLen) {
  const oc = o.sub(c);
  const b = oc.dot(dir);
  const cc = oc.dot(oc) - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 0) t = -b + s < 0 ? -1 : 0;
  if (t < 0 || t > maxLen) return -1;
  return t;
}

// Ray vs car hitbox (OBB). Returns {t, n} or null
export function rayCarBox(o, dir, car, maxLen) {
  const b = car.body, hs = car.halfSize, off = car.config.hitboxOffset;
  const R = b.rot;
  const lo = R.mulVecT(o.sub(b.pos)); lo.x -= off.x; lo.y -= off.y; lo.z -= off.z;
  const ld = R.mulVecT(dir);
  let tmin = -Infinity, tmax = Infinity, axis = -1, sgn = 1;
  const O = [lo.x, lo.y, lo.z], D = [ld.x, ld.y, ld.z], Hh = [hs.x, hs.y, hs.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(D[i]) < 1e-9) {
      if (O[i] < -Hh[i] || O[i] > Hh[i]) return null;
    } else {
      let t1 = (-Hh[i] - O[i]) / D[i], t2 = (Hh[i] - O[i]) / D[i];
      let s = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = i; sgn = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (tmin < 0 || tmin > maxLen || axis < 0) return null;
  const nl = [0, 0, 0]; nl[axis] = sgn;
  return { t: tmin, n: R.mulVec(new Vec3(nl[0], nl[1], nl[2])) };
}

// ---- solver --------------------------------------------------------------------
export function solveContacts(contacts, dt) {
  const n = contacts.length;
  if (!n) return;
  const invDt = 1 / dt;
  for (const c of contacts) {
    const A = c.a, B = c.b;
    c.rA = c.pA.sub(A.pos);
    c.rB = B ? c.pB.sub(B.pos) : null;
    const denA = A.impulseDenom(c.rA, c.n);
    const denB = B ? B.impulseDenom(c.rB, c.n) : 0;
    c.kN = 1 / (denA + denB);
    const vrel = A.velAt(c.rA).sub(B ? B.velAt(c.rB) : new Vec3());
    const vn = vrel.dot(c.n);
    let rest = Math.abs(vn) < RESTITUTION_VEL_THRESHOLD ? 0 : c.restitution * -vn;
    if (rest <= 0) rest = 0;
    c.target = rest;
    c.push = c.depth > 0 ? 0 : -c.depth * SOLVER_ERP2 * invDt;
    c.lambda = 0; c.pushLambda = 0;
    // tangent basis
    let t1 = vrel.sub(c.n.mul(vn));
    if (t1.len2() > 1e-6) t1 = t1.normalized();
    else {
      const a = Math.abs(c.n.x) < 0.7 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
      t1 = a.sub(c.n.mul(a.dot(c.n))).normalized();
    }
    const t2 = c.n.cross(t1);
    c.t1 = t1; c.t2 = t2;
    c.kT1 = 1 / (A.impulseDenom(c.rA, t1) + (B ? B.impulseDenom(c.rB, t1) : 0));
    c.kT2 = 1 / (A.impulseDenom(c.rA, t2) + (B ? B.impulseDenom(c.rB, t2) : 0));
    c.lt1 = 0; c.lt2 = 0;
  }
  for (let it = 0; it < SOLVER_ITERATIONS; it++) {
    for (const c of contacts) {
      const A = c.a, B = c.b;
      const vrel = A.velAt(c.rA).sub(B ? B.velAt(c.rB) : new Vec3());
      const vn = vrel.dot(c.n);
      let dl = c.kN * (c.target - vn);
      const old = c.lambda;
      c.lambda = Math.max(0, old + dl);
      dl = c.lambda - old;
      if (dl !== 0) {
        const imp = c.n.mul(dl);
        A.applyImpulse(imp, c.rA);
        if (B) B.applyImpulse(imp.neg(), c.rB);
      }
    }
    for (const c of contacts) {
      if (c.lambda <= 0 || c.friction <= 0) continue;
      const A = c.a, B = c.b;
      const vrel = A.velAt(c.rA).sub(B ? B.velAt(c.rB) : new Vec3());
      const maxF = c.friction * c.lambda;
      let n1 = c.lt1 - c.kT1 * vrel.dot(c.t1);
      let n2 = c.lt2 - c.kT2 * vrel.dot(c.t2);
      const m = Math.hypot(n1, n2);
      if (m > maxF) { n1 *= maxF / m; n2 *= maxF / m; }
      const d1 = n1 - c.lt1, d2 = n2 - c.lt2;
      c.lt1 = n1; c.lt2 = n2;
      const imp = c.t1.mul(d1).add(c.t2.mul(d2));
      A.applyImpulse(imp, c.rA);
      if (B) B.applyImpulse(imp.neg(), c.rB);
    }
  }
  // split impulse (position correction without adding real velocity)
  for (let it = 0; it < SOLVER_ITERATIONS; it++) {
    for (const c of contacts) {
      if (c.push <= 0 && c.pushLambda <= 0) continue;
      const A = c.a, B = c.b;
      const va = A.invMass ? A.pushVel.add(A.turnVel.cross(c.rA)) : new Vec3();
      const vb = B && B.invMass ? B.pushVel.add(B.turnVel.cross(c.rB)) : new Vec3();
      const vn = va.sub(vb).dot(c.n);
      let dl = c.kN * (c.push - vn);
      const old = c.pushLambda;
      c.pushLambda = Math.max(0, old + dl);
      dl = c.pushLambda - old;
      if (dl !== 0) {
        if (A.invMass) {
          A.pushVel.addScaledSelf(c.n, dl * A.invMass);
          A.turnVel.addSelf(A.invInertiaMul(c.rA.cross(c.n.mul(dl))));
        }
        if (B && B.invMass) {
          B.pushVel.addScaledSelf(c.n, -dl * B.invMass);
          B.turnVel.addSelf(B.invInertiaMul(c.rB.cross(c.n.mul(-dl))));
        }
      }
    }
  }
}

export function integrateBody(b, dt) {
  b.pos.x += (b.vel.x + b.pushVel.x) * dt;
  b.pos.y += (b.vel.y + b.pushVel.y) * dt;
  b.pos.z += (b.vel.z + b.pushVel.z) * dt;
  const w = b.angVel.add(b.turnVel);
  b.rot = integrateRotation(b.rot, w, dt);
  b.pushVel.set(0, 0, 0);
  b.turnVel.set(0, 0, 0);
}
