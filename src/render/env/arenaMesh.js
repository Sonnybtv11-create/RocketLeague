// Arena shell geometry generated from the SAME parameters as the collision SDF
// (src/sim/arena.js). Pure geometry (no materials / DOM) so that the node check
// script (check-sdf.mjs) can import it and verify every surface vertex against
// arenaSDF.
//
// Construction mirrors the SDF exactly:
//  * horizontal footprint = rounded octagon offset inward by u (ring(u)); corner
//    rounding radius max(RC - u, 0) — identical maths to arenaRing(), but with a
//    fixed vertex count per ring so rings can be swept into an indexed grid, and
//    with an extra vertex at x = ±GW on the back wall (the goal-post cut).
//  * vertical profile (u, z): floor fillet radius RF, straight wall, ceiling
//    fillet radius RCG (identical to arenaProfile()).
//  * goal mouth: the back wall and its floor ramp are removed for |x| < GW,
//    z < GH; the ramp ends in a flat cap face at x = ±GW; the goal interior is
//    the box |x| < GW, 0 < z < GH, Y < |y| < GD.
//
// All returned BufferGeometries are in Three.js space (metres, Y-up):
// three(x, y, z) = sim(x, z, y) * 0.01. Triangles are oriented so that their
// front faces point into free space (checked against the SDF gradient).
import * as THREE from 'three';
import { ARENA_PARAMS, arenaSDF } from '../../sim/arena.js';

const { X, Y, H, RF, RCG, RC, GW, GH, GD, DIAG } = ARENA_PARAMS;
const SQ2 = Math.SQRT2;
const S = 0.01;

export const ARC_SEGS = 12;     // segments per fillet quarter-circle (profile)
export const CORNER_SEGS = 8;   // segments per 45° of vertical corner rounding

// ---------------------------------------------------------------- footprint ring
// First-quadrant points (CCW from the +X axis) of the footprint ring at inside
// distance u. Fixed count = 2*CORNER_SEGS + 5. Last two points are on the back
// wall: (GW, Y-u) and (0, Y-u).
export function quadRing(u, segs = CORNER_SEGS) {
  const r = Math.max(RC - u, 0);
  const ex = X - u - r, ey = Y - u - r, ed = DIAG - (u + r) * SQ2;
  const A = [ex, ed - ex], B = [ed - ey, ey];
  const pts = [[ex + r, 0]];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * (Math.PI / 4);
    pts.push([A[0] + r * Math.cos(a), A[1] + r * Math.sin(a)]);
  }
  for (let i = 0; i <= segs; i++) {
    const a = Math.PI / 4 + (i / segs) * (Math.PI / 4);
    pts.push([B[0] + r * Math.cos(a), B[1] + r * Math.sin(a)]);
  }
  pts.push([GW, Y - u]);
  pts.push([0, Y - u]);
  return pts;
}

// Half ring for the +Y half (orange): from (+x, 0) CCW through (0, Y-u) to (-x, 0).
// sign = -1 mirrors it to the blue half (y negated, same order).
export function halfRing(u, sign = 1) {
  const q = quadRing(u);
  const out = q.map((p) => [p[0], p[1] * sign]);
  for (let i = q.length - 2; i >= 0; i--) out.push([-q[i][0], q[i][1] * sign]);
  return out;
}

// Vertical profile rows {u, z, v}: v = cumulative arc length along the profile.
export function profileRows() {
  const rows = [];
  for (let k = 0; k <= ARC_SEGS; k++) {
    const a = -Math.PI / 2 - (k / ARC_SEGS) * (Math.PI / 2);
    rows.push({ u: RF + RF * Math.cos(a), z: RF + RF * Math.sin(a) });
  }
  rows[ARC_SEGS].u = 0; rows[ARC_SEGS].z = RF;
  rows.push({ u: 0, z: GH, split: true });          // top of the solid lower wall / crossbar height
  for (let k = 0; k <= ARC_SEGS; k++) {
    const a = Math.PI + (k / ARC_SEGS) * (Math.PI / 2);
    rows.push({ u: RCG + RCG * Math.cos(a), z: H - RCG - RCG * Math.sin(a) });
  }
  rows[rows.length - 1].z = H;
  let v = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i) v += Math.hypot(rows[i].u - rows[i - 1].u, rows[i].z - rows[i - 1].z);
    rows[i].v = v;
  }
  return rows;
}

export const PROFILE = profileRows();
export const SPLIT_ROW = PROFILE.findIndex((r) => r.split);
export const V_LOWER = PROFILE[SPLIT_ROW].v;         // profile length of the solid lower wall
export const V_TOTAL = PROFILE[PROFILE.length - 1].v;

// arc length along the u = 0 ring of each half-ring vertex (used as texture s)
const BASE_RING = halfRing(0, 1);
export const RING_S = (() => {
  const s = [0];
  for (let i = 1; i < BASE_RING.length; i++) s.push(s[i - 1] + Math.hypot(BASE_RING[i][0] - BASE_RING[i - 1][0], BASE_RING[i][1] - BASE_RING[i - 1][1]));
  return s;
})();
export const HALF_RING_LENGTH = RING_S[RING_S.length - 1];

// ---------------------------------------------------------------- builder
class Builder {
  constructor() { this.pos = []; this.uv = []; this.idx = []; this.extra = {}; this.patches = [0]; }
  // start a new independently-oriented patch (each patch is flipped as a unit)
  patch() { if (this.patches[this.patches.length - 1] !== this.idx.length) this.patches.push(this.idx.length); }
  v(x, y, z, u, w) { // sim coords
    this.pos.push(x * S, z * S, y * S);
    this.uv.push(u, w);
    return this.pos.length / 3 - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  build(normalMode = 'smooth') {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const k in this.extra) g.setAttribute(k, new THREE.Float32BufferAttribute(this.extra[k].data, this.extra[k].size));
    g.setIndex(this.idx);
    const ends = [...this.patches.slice(1), this.idx.length];
    this.patches.forEach((start, k) => orientToSDF(g, start, ends[k]));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// Flip all triangles of g if most of them face into the solid (front face must
// point along the SDF gradient = towards free space).
function orientToSDF(g, t0, t1) {
  const p = g.attributes.position.array, idx = g.index ? g.index.array : null;
  if (!idx) return;
  let agree = 0, disagree = 0;
  const e = 1.0;
  for (let t = t0; t < t1; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) continue;
    // centroid in sim units
    const cx = (p[a] + p[b] + p[c]) / 3 / S, cyT = (p[a + 1] + p[b + 1] + p[c + 1]) / 3 / S, czT = (p[a + 2] + p[b + 2] + p[c + 2]) / 3 / S;
    const sx = cx, sy = czT, sz = cyT; // three (x,y,z) -> sim (x, z, y)
    const gx = arenaSDF(sx + e, sy, sz) - arenaSDF(sx - e, sy, sz);
    const gy = arenaSDF(sx, sy + e, sz) - arenaSDF(sx, sy - e, sz);
    const gz = arenaSDF(sx, sy, sz + e) - arenaSDF(sx, sy, sz - e);
    // sim gradient -> three dir (gx, gz, gy)
    const d = nx * gx + ny * gz + nz * gy;
    if (d > 0) agree++; else if (d < 0) disagree++;
  }
  if (disagree > agree) {
    for (let t = t0; t < t1; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
    g.index.needsUpdate = true;
  }
}

function isGoalGap(p, q) {
  // segment between two back-wall ring points that both lie inside the goal mouth
  return Math.abs(p[0]) <= GW + 1e-6 && Math.abs(q[0]) <= GW + 1e-6 && Math.abs(p[1]) > Y - RF - 1 && Math.abs(q[1]) > Y - RF - 1;
}

// Swept wall surface for one half, rows [r0, r1] of the profile.
function sweptWall(sign, r0, r1, cutGoal) {
  const b = new Builder();
  const rings = [];
  for (let j = r0; j <= r1; j++) rings.push(halfRing(PROFILE[j].u, sign));
  const n = rings[0].length;
  const ids = [];
  const zRow = [];
  for (let j = r0; j <= r1; j++) {
    const ring = rings[j - r0], row = PROFILE[j];
    const line = [];
    for (let i = 0; i < n; i++) line.push(b.v(ring[i][0], ring[i][1], row.z, RING_S[i], row.v));
    ids.push(line);
    zRow.push(row.z);
  }
  for (let j = 0; j < ids.length - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      if (cutGoal && isGoalGap(rings[j][i], rings[j][i + 1]) && zRow[j + 1] <= GH + 1e-6) continue;
      b.quad(ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]);
    }
  }
  return b.build();
}

// Flat polygon (sim xy points, CCW or CW) at height z, triangulated with earcut.
function flatPolygon(pts, z, uvFn) {
  const b = new Builder();
  const clean = [];
  for (const p of pts) {
    const q = clean[clean.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3) clean.push(p);
  }
  if (Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) < 1e-3) clean.pop();
  const contour = clean.map((p) => new THREE.Vector2(p[0], p[1]));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const ids = clean.map((p) => { const uv = uvFn(p[0], p[1]); return b.v(p[0], p[1], z, uv[0], uv[1]); });
  for (const t of tris) b.tri(ids[t[0]], ids[t[1]], ids[t[2]]);
  return b.build();
}

// Field floor: ring(RF) with the goal-mouth notches out to the goal line.
function floorOutline() {
  const q = quadRing(RF);
  // q ends with (GW, Y-RF), (0, Y-RF): insert notch (GW, Y) -> (0, Y)
  const quadPts = q.slice(0, q.length - 2);
  const out = [];
  const push = (x, y) => out.push([x, y]);
  // +Y half, from (+x,0) to (-x,0)
  for (const p of quadPts) push(p[0], p[1]);
  push(GW, Y - RF); push(GW, Y); push(-GW, Y); push(-GW, Y - RF);
  for (let i = quadPts.length - 1; i >= 0; i--) push(-quadPts[i][0], quadPts[i][1]);
  // -Y half, from (-x,0) to (+x,0)
  for (let i = 1; i < quadPts.length; i++) push(-quadPts[i][0], -quadPts[i][1]);
  push(-GW, -(Y - RF)); push(-GW, -Y); push(GW, -Y); push(GW, -(Y - RF));
  for (let i = quadPts.length - 1; i >= 1; i--) push(quadPts[i][0], -quadPts[i][1]);
  return out;
}

export const FIELD_UV = { x0: -X, x1: X, y0: -Y, y1: Y };
function fieldUV(x, y) { return [(x - FIELD_UV.x0) / (FIELD_UV.x1 - FIELD_UV.x0), (y - FIELD_UV.y0) / (FIELD_UV.y1 - FIELD_UV.y0)]; }

// Ceiling half polygon at z = H (ring(RCG) half, closed along y = 0)
function ceilingHalf(sign) {
  const ring = halfRing(RCG, sign);
  return flatPolygon(ring, H, (x, y) => [x / 1024, y / 1024]);
}

// Ramp end caps (x = ±GW) for one goal: fan from the wall/floor corner
function rampCaps(sign) {
  const b = new Builder();
  for (const sx of [1, -1]) {
    b.patch();
    const c = b.v(sx * GW, sign * Y, 0, 0, 0);
    const arc = [];
    for (let k = 0; k <= ARC_SEGS; k++) {
      const r = PROFILE[k];
      arc.push(b.v(sx * GW, sign * (Y - r.u), r.z, r.u / 256, r.z / 256));
    }
    for (let k = 0; k < ARC_SEGS; k++) b.tri(c, arc[k], arc[k + 1]);
  }
  return b.build();
}

// Goal interior box for one goal. Returns {floor, net} geometries.
// net = side walls + roof + back (the visual net / enclosure surfaces)
function goalBox(sign) {
  const fl = new Builder();
  {
    const a = fl.v(-GW, sign * Y, 0, 0, 0), b2 = fl.v(GW, sign * Y, 0, 1, 0);
    const c = fl.v(GW, sign * GD, 0, 1, 1), d = fl.v(-GW, sign * GD, 0, 0, 1);
    fl.quad(a, b2, c, d);
  }
  const net = new Builder();
  const NU = 8, NV = 4; // subdivide a little (nicer vertex shading / no huge tris)
  const grid = (fn) => {
    net.patch();
    const ids = [];
    for (let j = 0; j <= NV; j++) {
      const row = [];
      for (let i = 0; i <= NU; i++) { const r = fn(i / NU, j / NV); row.push(net.v(r[0], r[1], r[2], r[3], r[4])); }
      ids.push(row);
    }
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) net.quad(ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]);
  };
  const D = GD - Y;
  // side walls x = ±GW (u along depth, v up)
  for (const sx of [1, -1]) grid((s, t) => [sx * GW, sign * (Y + s * D), t * GH, s * D / 100, t * GH / 100]);
  // roof
  grid((s, t) => [-GW + 2 * GW * s, sign * (Y + t * D), GH, s * 2 * GW / 100, t * D / 100]);
  // back
  grid((s, t) => [-GW + 2 * GW * s, sign * GD, t * GH, s * 2 * GW / 100, t * GH / 100]);
  return { floor: fl.build(), net: net.build() };
}

// Build everything. Index 0 = blue (-Y) half, 1 = orange (+Y) half.
export function buildArenaGeometries() {
  const lastRow = PROFILE.length - 1;
  const out = { floor: flatPolygon(floorOutline(), 0, fieldUV), lower: [], glass: [], ceiling: [], caps: [], goalFloor: [], goalNet: [] };
  for (const team of [0, 1]) {
    const sign = team === 0 ? -1 : 1;
    out.lower.push(sweptWall(sign, 0, SPLIT_ROW, true));
    out.glass.push(sweptWall(sign, SPLIT_ROW, lastRow, false));
    out.ceiling.push(ceilingHalf(sign));
    out.caps.push(rampCaps(sign));
    const gb = goalBox(sign);
    out.goalFloor.push(gb.floor);
    out.goalNet.push(gb.net);
  }
  return out;
}

// All collision-surface geometries with names (for the SDF check)
export function surfaceList(geos) {
  const L = [['floor', geos.floor]];
  for (const t of [0, 1]) {
    L.push([`lower${t}`, geos.lower[t]], [`glass${t}`, geos.glass[t]], [`ceiling${t}`, geos.ceiling[t]],
      [`caps${t}`, geos.caps[t]], [`goalFloor${t}`, geos.goalFloor[t]], [`goalNet${t}`, geos.goalNet[t]]);
  }
  return L;
}
