// TURBO PITCH — procedural geometry toolkit for the car bodies (car agent).
// Everything here works in UNREAL UNITS (1 uu = 1 cm) in car model axes
// (+X forward, +Y up, +Z right, origin = centre of mass). The body builder
// scales the finished, merged geometries to metres at the very end, so that
// toCreasedNormals' position quantisation (1e-2 units) is fine-grained enough.
//
// Main pieces:
//   * smooth(table)            — monotone cubic interpolation of [[x, v], ...]
//   * Loft                     — a lofted body surface: a closed cross-section
//                                ring (6 key points per side, cardinal spline)
//                                swept along X. Per-quad material classification
//                                gives clean paint/glass/trim boundaries along
//                                mesh edges.
//   * PartSet                  — collects triangles per material slot, merges.
//   * sweepArc / roundedBox / lathe / tube helpers for fenders, wings, nozzles…
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ----------------------------------------------------------------------------
// 1D monotone cubic (Fritsch–Carlson) interpolation through [[x, v], ...]
export function smooth(table) {
  const n = table.length;
  const xs = table.map((p) => p[0]), vs = table.map((p) => p[1]);
  const d = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (vs[i + 1] - vs[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return vs[0];
    if (x >= xs[n - 1]) return vs[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * vs[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * vs[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ----------------------------------------------------------------------------
// Material slots used by every body
export const SLOTS = ['paint', 'trim', 'accent', 'glass', 'light', 'chrome', 'glow'];

// Collects per-slot geometries (all non-indexed, position + normal [+ color]).
export class PartSet {
  constructor() { this.parts = {}; for (const s of SLOTS) this.parts[s] = []; }
  add(slot, geom, matrix) {
    let g = geom.index ? geom.toNonIndexed() : geom;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (matrix) g.applyMatrix4(matrix);
    this.parts[slot].push(g);
    return g;
  }
  // Mirror a part across the XY plane (z -> -z) and add both
  addMirrored(slot, geom, matrix) {
    const a = this.add(slot, geom, matrix);
    const b = a.clone();
    b.applyMatrix4(new THREE.Matrix4().makeScale(1, 1, -1));
    flipWinding(b);
    this.parts[slot].push(b);
  }
  // Merge every slot into one geometry, scaled to metres. Light/glow slots get vertex colours.
  build(scale = 0.01) {
    const out = {};
    for (const s of SLOTS) {
      const list = this.parts[s];
      if (!list.length) { out[s] = null; continue; }
      const needColor = list.some((g) => g.attributes.color);
      if (needColor) for (const g of list) if (!g.attributes.color) setColor(g, 1, 1, 1);
      if (!needColor) for (const g of list) if (g.attributes.color) g.deleteAttribute('color');
      const m = mergeGeometries(list, false);
      m.scale(scale, scale, scale);
      m.computeBoundingSphere(); m.computeBoundingBox();
      out[s] = m;
    }
    return out;
  }
}

export function flipWinding(g) {
  const p = g.attributes.position, n = g.attributes.normal, c = g.attributes.color;
  for (let i = 0; i < p.count; i += 3) {
    for (const a of [p, n, c]) {
      if (!a) continue;
      for (let k = 0; k < a.itemSize; k++) {
        const t = a.array[(i + 1) * a.itemSize + k];
        a.array[(i + 1) * a.itemSize + k] = a.array[(i + 2) * a.itemSize + k];
        a.array[(i + 2) * a.itemSize + k] = t;
      }
    }
  }
  p.needsUpdate = true;
}

export function setColor(g, r, gg, b) {
  const n = g.attributes.position.count, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = r; arr[i * 3 + 1] = gg; arr[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

// ----------------------------------------------------------------------------
// Lofted body surface.
//   def.section(x) -> array of 6 key points [z, y] for the RIGHT half, from the
//     bottom centre (P0, z = 0) round the side to the top centre (P5, z = 0):
//     P0 bottom centre, P1 bottom edge, P2 widest/sill, P3 beltline/shoulder,
//     P4 roof/greenhouse edge, P5 roof/hood centre.
//   def.tension: per-knot cardinal tension (0 = smooth Catmull-Rom, 1 = sharp corner)
//   def.sub: subdivisions of each of the 5 ring segments
//   def.xs: station x positions (sorted ascending, tail -> nose)
//   def.classify(x, seg) -> slot for the quad whose centre is at x on ring segment seg (0..4)
//   def.capSlot: slot for the end caps
// Ring index layout per station: right half from P0 to P5, then left half back.
const KN = 6;
export class Loft {
  constructor(def) {
    this.def = def;
    this.sub = def.sub || [2, 4, 4, 4, 4];
    this.tension = def.tension || [0, 0.2, 0, 0.2, 0.2, 0];
  }
  // point on the half ring: seg 0..4, t 0..1 -> [z, y]
  ringPoint(P, seg, t, out) {
    const T = this.tension;
    const get = (i) => {
      if (i < 0) { const q = P[-i]; return [-q[0], q[1]]; }         // mirror across centreline
      if (i >= KN) { const q = P[2 * (KN - 1) - i]; return [-q[0], q[1]]; }
      return P[i];
    };
    const p0 = get(seg - 1), p1 = get(seg), p2 = get(seg + 1), p3 = get(seg + 2);
    const c1 = 1 - T[seg], c2 = 1 - T[Math.min(seg + 1, KN - 1)];
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    for (let k = 0; k < 2; k++) {
      const m1 = c1 * (p2[k] - p0[k]) / 2, m2 = c2 * (p3[k] - p1[k]) / 2;
      out[k] = h00 * p1[k] + h10 * m1 + h01 * p2[k] + h11 * m2;
    }
    if (out[0] < 0) out[0] = 0;
    return out;
  }
  // Global ring parameter u in [0,1] (half ring) -> seg/t
  static segOf(u) { const f = clamp(u, 0, 1) * 5; const seg = Math.min(4, Math.floor(f)); return [seg, f - seg]; }
  // Surface point at (x, u) with u in [-1, 1] (negative = left side); fills THREE.Vector3
  // u is continuous round the ring: 0 bottom centre, +-1 top centre, (0,1) right side, (-1,0) left side,
  // (1,2) continues down the left side and (-2,-1) down the right side (so patches can straddle the top).
  point(x, u, out = new THREE.Vector3()) {
    const P = this.def.section(x);
    let side = 1, a = u;
    if (u > 1) { side = -1; a = 2 - u; } else if (u < -1) { side = 1; a = 2 + u; } else if (u < 0) { side = -1; a = -u; }
    const [seg, t] = Loft.segOf(a);
    const r = this.ringPoint(P, seg, t, [0, 0]);
    return out.set(x, r[1], side * r[0]);
  }
  // Outward surface normal at (x, u) by finite differences (derivative along increasing u is
  // always "round the ring" in the same rotational sense, so tx x tu points outward).
  normal(x, u, out = new THREE.Vector3()) {
    const e = 0.25, eu = 0.004;
    const a = this.point(x - e, u), b = this.point(x + e, u);
    const c = this.point(x, u - eu), d = this.point(x, u + eu);
    const tx = b.sub(a), tu = d.sub(c);
    return out.crossVectors(tx, tu).normalize();
  }

  // Build the body shell into PartSet `ps`
  build(ps, creaseDeg = 40) {
    const def = this.def, xs = def.xs, sub = this.sub;
    const half = []; // list of {seg, t} for the half ring, P0..P5 inclusive
    for (let s = 0; s < 5; s++) for (let i = 0; i < sub[s]; i++) half.push([s, i / sub[s]]);
    half.push([4, 1]);
    const H = half.length;              // vertices on half ring incl. both centre points
    const R = 2 * H - 2;                // full ring (centre points shared)
    const pos = [];
    const r = [0, 0];
    for (const x of xs) {
      const P = def.section(x);
      const ring = [];
      for (const [s, t] of half) { this.ringPoint(P, s, t, r); ring.push([r[0], r[1]]); }
      // right half: P0 .. P5 ; left half: P4' .. P1' (skip both centre points)
      for (let i = 0; i < H; i++) pos.push(x, ring[i][1], ring[i][0]);
      for (let i = H - 2; i >= 1; i--) pos.push(x, ring[i][1], -ring[i][0]);
    }
    // segment index of each ring edge (i -> i+1). Right side: vertex i has half index i.
    // Left side: vertex i (i >= H) has half index R - i, so edge i spans half indices R-i-1 .. R-i.
    const segOfEdge = [];
    for (let i = 0; i < R; i++) segOfEdge.push(i < H - 1 ? half[i][0] : half[R - i - 1][0]);
    const idx = [], triSlot = [];
    const N = xs.length;
    for (let k = 0; k < N - 1; k++) {
      const xm = (xs[k] + xs[k + 1]) / 2;
      for (let i = 0; i < R; i++) {
        const i2 = (i + 1) % R;
        const a = k * R + i, b = k * R + i2, c = (k + 1) * R + i, d = (k + 1) * R + i2;
        const slot = def.classify(xm, segOfEdge[i]);
        // winding: outward facing (x increases along k; ring goes bottom->right side->top->left)
        idx.push(a, c, b, b, c, d); triSlot.push(slot, slot);
      }
    }
    // end caps (fan to the ring centroid)
    const capSlot = def.capSlot || 'trim';
    for (const [k, dir] of [[0, -1], [N - 1, 1]]) {
      let cy = 0, cz = 0;
      for (let i = 0; i < R; i++) { cy += pos[(k * R + i) * 3 + 1]; cz += pos[(k * R + i) * 3 + 2]; }
      const ci = pos.length / 3;
      pos.push(xs[k] + dir * (def.capBulge || 0), cy / R, cz / R);
      for (let i = 0; i < R; i++) {
        const a = k * R + i, b = k * R + (i + 1) % R;
        if (dir < 0) idx.push(ci, a, b); else idx.push(ci, b, a);
        triSlot.push(typeof capSlot === 'function' ? capSlot(dir) : capSlot);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    // orientation check: make sure normals point outward (top surface normal +Y)
    const creased = toCreasedNormals(g, THREE.MathUtils.degToRad(creaseDeg));
    // split per slot
    const P = creased.attributes.position.array, Nn = creased.attributes.normal.array;
    const per = {};
    for (let t = 0; t < triSlot.length; t++) {
      const s = triSlot[t];
      (per[s] || (per[s] = [])).push(t);
    }
    for (const s of Object.keys(per)) {
      const tris = per[s];
      const pa = new Float32Array(tris.length * 9), na = new Float32Array(tris.length * 9);
      tris.forEach((t, j) => { pa.set(P.subarray(t * 9, t * 9 + 9), j * 9); na.set(Nn.subarray(t * 9, t * 9 + 9), j * 9); });
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(pa, 3));
      sg.setAttribute('normal', new THREE.BufferAttribute(na, 3));
      ps.add(s, sg);
    }
  }

  // A thin surface-following patch (stripe, decal, light lens), offset outward by `lift`.
  // x0..x1 along the body, u0..u1 ring parameter (0 bottom centre .. 1 top centre; negative = left side)
  patch(ps, slot, x0, x1, u0, u1, lift = 0.25, nx = 12, nu = 6, color = null) {
    const pos = [], idx = [];
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i <= nx; i++) {
      const x = lerp(x0, x1, i / nx);
      for (let j = 0; j <= nu; j++) {
        const u = lerp(u0, u1, j / nu);
        this.point(x, u, p); this.normal(x, u, n);
        pos.push(p.x + n.x * lift, p.y + n.y * lift, p.z + n.z * lift);
      }
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < nu; j++) {
      const a = i * (nu + 1) + j, b = a + 1, c = a + nu + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    // make the patch face outward
    const gi = g.toNonIndexed(); gi.computeVertexNormals();
    const nn = gi.attributes.normal, pp = gi.attributes.position;
    const tx = (x0 + x1) / 2, tu = (u0 + u1) / 2;
    this.normal(tx, tu, n);
    let dot = 0; for (let i = 0; i < nn.count; i++) dot += nn.getX(i) * n.x + nn.getY(i) * n.y + nn.getZ(i) * n.z;
    if (dot < 0) { flipWinding(gi); gi.computeVertexNormals(); }
    void pp;
    if (color) setColor(gi, color[0], color[1], color[2]);
    ps.add(slot, gi);
    return gi;
  }
}

// ----------------------------------------------------------------------------
// Primitive helpers (uu). All return non-indexed BufferGeometry with normals.

export function roundedBox(lx, ly, lz, r, seg = 2) {
  const g = new RoundedBoxGeometry(lx, ly, lz, seg, Math.min(r, Math.min(lx, ly, lz) / 2 - 0.01));
  return g.index ? g.toNonIndexed() : g;
}

// Matrix helper: translate (x,y,z), rotate by Euler (rx,ry,rz) in XYZ order
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz, 'XYZ'); _q.setFromEuler(_e); _v.set(x, y, z); _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_v, _q, _s);
}

// Sweep a closed 2D profile [[r, w], ...] (r radial distance from the axle, w along the axle)
// around the Z axis (axle) from angle a0 to a1 (radians, 0 = +X forward, PI/2 = up).
// Produces a curved shell like a fender/arch. Returns non-indexed geometry with creased normals.
export function sweepArc(profile, a0, a1, segs = 16, closeEnds = true, crease = 50) {
  const pos = [], idx = [];
  const P = profile.length;
  for (let i = 0; i <= segs; i++) {
    const a = lerp(a0, a1, i / segs), c = Math.cos(a), s = Math.sin(a);
    for (const [r, w] of profile) pos.push(c * r, s * r, w);
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < P; j++) {
    const j2 = (j + 1) % P;
    const a = i * P + j, b = i * P + j2, cc = (i + 1) * P + j, d = (i + 1) * P + j2;
    idx.push(a, b, cc, b, d, cc);
  }
  if (closeEnds) {
    for (const [i, dir] of [[0, 1], [segs, -1]]) {
      // fan around profile centroid
      let cr = 0, cw = 0; for (const [r, w] of profile) { cr += r; cw += w; } cr /= P; cw /= P;
      const a = lerp(a0, a1, i / segs);
      const ci = pos.length / 3; pos.push(Math.cos(a) * cr, Math.sin(a) * cr, cw);
      for (let j = 0; j < P; j++) {
        const p1 = i * P + j, p2 = i * P + (j + 1) % P;
        if (dir > 0) idx.push(ci, p2, p1); else idx.push(ci, p1, p2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return orientOutward(toCreasedNormals(g, THREE.MathUtils.degToRad(crease)));
}

// Ensure triangle winding agrees with "outward" = away from the geometry's centroid on average.
// (Profiles can be given in either direction; this keeps front-face culling correct.)
export function orientOutward(g) {
  const p = g.attributes.position;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < p.count; i++) { cx += p.getX(i); cy += p.getY(i); cz += p.getZ(i); }
  cx /= p.count; cy /= p.count; cz /= p.count;
  let score = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    n.subVectors(c, b).cross(a.clone().sub(b));
    const mx = (a.x + b.x + c.x) / 3 - cx, my = (a.y + b.y + c.y) / 3 - cy, mz = (a.z + b.z + c.z) / 3 - cz;
    score += n.x * mx + n.y * my + n.z * mz;
  }
  if (score < 0) { flipWinding(g); const nn = g.attributes.normal; for (let i = 0; i < nn.array.length; i++) nn.array[i] = -nn.array[i]; }
  return g;
}

// Lathe around the X axis (for nozzles, exhausts): profile [[x, r], ...]
export function latheX(profile, segs = 20, crease = 40) {
  const pts = profile.map(([x, r]) => new THREE.Vector2(Math.max(r, 0.001), x));
  const g = new THREE.LatheGeometry(pts, segs);
  // Lathe is around +Y: rotate so the axis is +X
  g.applyMatrix4(new THREE.Matrix4().makeRotationZ(-Math.PI / 2));
  g.deleteAttribute('uv');
  return orientOutward(toCreasedNormals(g, THREE.MathUtils.degToRad(crease)));
}

// Disc in the YZ plane facing +X (or -X) — for glowing nozzle cores, lenses
export function discX(r, segs = 20, facing = 1) {
  const g = new THREE.CircleGeometry(r, segs);
  g.deleteAttribute('uv');
  g.applyMatrix4(new THREE.Matrix4().makeRotationY(facing > 0 ? Math.PI / 2 : -Math.PI / 2));
  return g.index ? g.toNonIndexed() : g;
}

// Extrude a 2D shape (in the X/Y side-view plane) along Z with bevel; centred on z
export function extrudeSide(points2d, depth, bevel = 0.8, curveSegs = 2) {
  const sh = new THREE.Shape(points2d.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: curveSegs, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  g.deleteAttribute('uv');
  return toCreasedNormals(g, THREE.MathUtils.degToRad(35));
}

// Extrude a 2D shape in the top-view plane (X forward, Z right) along Y (thickness)
export function extrudeTop(points2d, thick, bevel = 0.6) {
  const sh = new THREE.Shape(points2d.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  // shape plane XY (y = -z) extruded along +Z -> rotate so extrusion goes +Y
  g.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  g.deleteAttribute('uv');
  return toCreasedNormals(g, THREE.MathUtils.degToRad(35));
}
