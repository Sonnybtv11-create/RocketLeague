// Arena collision as an analytic signed distance field (Unreal Units, Z-up).
// sdf(x,y,z) > 0 in free space, = distance to the nearest solid surface.
//
// Construction:
//  * Horizontal footprint: an octagon (rectangle 2X × 2Y with 45° corner cuts of
//    catheti C) whose vertical edges are rounded with radius R_CORNER. The
//    inside distance u(x,y) to that footprint is exact for convex shapes.
//  * Vertical profile: the (u, z) quarter-plane with a quarter-circle fillet of
//    radius R_FLOOR at the floor and R_CEIL at the ceiling (the curved
//    floor->wall and wall->ceiling transitions).
//  * Goals: the back wall term is replaced near the goal mouth by the exact
//    distance to a "plane with a rectangular hole" (the goal opening), and the
//    goal interior is a box |x|<GW, 0<z<GH, Y<|y|<GD.
// The render mesh is generated from the same functions (see arenaRing /
// arenaProfile below) so visuals and collision never disagree.

import { ARENA } from '../contracts.js';

const X = ARENA.EXTENT_X, Y = ARENA.EXTENT_Y, H = ARENA.HEIGHT, C = ARENA.CORNER_CATHETUS;
const RF = ARENA.FLOOR_FILLET, RCG = ARENA.CEIL_FILLET, RC = ARENA.CORNER_ROUND;
const GW = ARENA.GOAL_HALF_WIDTH, GH = ARENA.GOAL_HEIGHT, GD = ARENA.GOAL_DEPTH_Y;
const SQ2 = Math.SQRT2;
const DIAG = X + Y - C; // corner plane: |x| + |y| = DIAG

// --- 2D inside distance to the rounded octagon (first-quadrant coords) -------
// Planes (inward distance): side: X - ax ; back: Y - ay ; corner: (DIAG - ax - ay)/√2
// Eroded by RC, then distance-to-eroded-polygon gives the rounded result.
const EX = X - RC, EY = Y - RC, ED = DIAG - RC * SQ2;
// eroded vertices
const VA = [EX, ED - EX];      // side/corner vertex
const VB = [ED - EY, EY];      // corner/back vertex

function footprintDist(ax, ay, backTerm) {
  // backTerm: externally supplied distance for the back plane (hole aware) or null
  const dS = X - ax;
  const dB = backTerm === null ? (Y - ay) : backTerm;
  const dC = (DIAG - ax - ay) / SQ2;
  if (backTerm !== null) {
    // near the goal: rounding vertices are far away, plain min is exact
    return Math.min(dS, dB, dC);
  }
  if (dS >= RC && dB >= RC && dC >= RC) return Math.min(dS, dB, dC);
  // distance from (ax, ay) to the eroded polygon (x<=EX, y<=EY, x+y<=ED)
  const vS = ax - EX, vB = ay - EY, vC = (ax + ay - ED) / SQ2; // >0 = violated
  let best = Infinity;
  // try projecting on each violated plane
  if (vS > 0) { const py = ay; if (py <= EY && EX + py <= ED + 1e-9) best = Math.min(best, vS); }
  if (vB > 0) { const px = ax; if (px <= EX && px + EY <= ED + 1e-9) best = Math.min(best, vB); }
  if (vC > 0) {
    const px = ax - vC / SQ2, py = ay - vC / SQ2;
    if (px <= EX + 1e-9 && py <= EY + 1e-9) best = Math.min(best, vC);
  }
  if (best === Infinity) {
    const da = Math.hypot(ax - VA[0], ay - VA[1]);
    const db = Math.hypot(ax - VB[0], ay - VB[1]);
    best = Math.min(da, db);
  }
  return RC - best;
}

// Distance (from inside the arena, |y| <= Y) to the back wall with the goal hole
function backHoleDist(ax, ay, z) {
  const w = Y - ay;
  let h = 0;
  if (ax < GW && z < GH) h = Math.min(GW - ax, GH - z);
  return Math.sqrt(w * w + h * h);
}

// Vertical profile: u = horizontal inside distance, z = height
function profileDist(u, z) {
  if (u < RF && z < RF) return RF - Math.hypot(RF - u, RF - z);
  const zc = H - z;
  if (u < RCG && zc < RCG) return RCG - Math.hypot(RCG - u, RCG - zc);
  return Math.min(u, z, zc);
}

export function arenaSDF(x, y, z) {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ay <= Y) {
    if (ax < GW && z < GH) {
      // In front of the goal mouth: the back wall (and its floor ramp) has a
      // rectangular hole here. Distance to the cut solid = min of the end face
      // of the cut back-wall profile, the wall above the crossbar, the floor and
      // the remaining walls.
      const w = Y - ay;
      const pd = profileDist(w, z);
      const dx = GW - ax;
      const endFace = pd < 0 ? dx : Math.sqrt(dx * dx + pd * pd);
      const dz = GH - z;
      const above = Math.sqrt(w * w + dz * dz);
      const others = profileDist(Math.min(X - ax, (DIAG - ax - ay) / SQ2), z);
      return Math.min(z, endFace, above, others);
    }
    return profileDist(footprintDist(ax, ay, null), z);
  }
  // beyond the goal line
  if (ax < GW && z < GH) {
    // inside the goal prism
    return Math.min(GW - ax, GH - z, z, GD - ay);
  }
  // inside the solid back wall (around the goal): negative distance to free space
  const toArena = ay - Y;
  const dx = Math.max(ax - GW, 0), dz = Math.max(z - GH, 0);
  const toGoal = Math.hypot(dx, dz);
  return -Math.min(toArena, toGoal) - 1e-3;
}

const NEPS = 0.5;
export function arenaNormal(x, y, z, out) {
  const nx = arenaSDF(x + NEPS, y, z) - arenaSDF(x - NEPS, y, z);
  const ny = arenaSDF(x, y + NEPS, z) - arenaSDF(x, y - NEPS, z);
  const nz = arenaSDF(x, y, z + NEPS) - arenaSDF(x, y, z - NEPS);
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  out.x = nx / l; out.y = ny / l; out.z = nz / l;
  return out;
}

// Ray vs arena: sphere tracing. Returns hit distance t (or -1) and fills normal.
export function arenaRaycast(ox, oy, oz, dx, dy, dz, maxLen, outNormal) {
  let t = 0;
  let d = arenaSDF(ox, oy, oz);
  if (d <= 0) {
    // started inside solid: treat as immediate hit
    if (outNormal) arenaNormal(ox, oy, oz, outNormal);
    return 0;
  }
  for (let i = 0; i < 64; i++) {
    if (d < 0.02) break;
    t += Math.max(d * 0.95, 0.05);
    if (t > maxLen) return -1;
    d = arenaSDF(ox + dx * t, oy + dy * t, oz + dz * t);
    if (d < 0) {
      // overshoot: bisect back
      let lo = t - Math.max(d * 0.95, 0.05) - 2, hi = t;
      if (lo < 0) lo = 0;
      for (let k = 0; k < 16; k++) {
        const mid = (lo + hi) * 0.5;
        if (arenaSDF(ox + dx * mid, oy + dy * mid, oz + dz * mid) > 0) lo = mid; else hi = mid;
      }
      t = hi;
      break;
    }
  }
  if (t > maxLen) return -1;
  if (outNormal) arenaNormal(ox + dx * t, oy + dy * t, oz + dz * t, outNormal);
  return t;
}

// ---- Helpers for building a matching render mesh -----------------------------
// The wall surface is the set of points at horizontal inside-distance u from the
// footprint where profileDist(u, z) == 0. arenaProfile() returns that (u, z)
// curve from the floor up to the ceiling; arenaRing(u) returns the closed 2D
// ring (counter-clockwise, first point at +X axis) of points with footprint
// inside distance exactly u (ignoring the goal hole).
export function arenaProfile(stepsPerArc = 12) {
  const pts = [];
  // floor fillet: centre (RF, RF), from (RF,0) to (0,RF)
  for (let i = 0; i <= stepsPerArc; i++) {
    const a = -Math.PI / 2 - (i / stepsPerArc) * (Math.PI / 2);
    pts.push({ u: RF + RF * Math.cos(a), z: RF + RF * Math.sin(a) });
  }
  // ceiling fillet: centre (RCG, H-RCG), from (0, H-RCG) to (RCG, H)
  for (let i = 0; i <= stepsPerArc; i++) {
    const a = Math.PI + (i / stepsPerArc) * (Math.PI / 2);
    pts.push({ u: RCG + RCG * Math.cos(a), z: H - RCG - RCG * Math.sin(a) });
  }
  return pts; // u from RF down to 0 then back up to RCG; z from 0 to H
}

export function arenaRing(u, cornerSegs = 8) {
  // offset octagon by u, corner radius max(RC-u, 0)
  const r = Math.max(RC - u, 0);
  const ex = X - u - r, ey = Y - u - r, ed = DIAG - (u + r) * SQ2;
  // eroded (by u+r) vertices in first quadrant
  const A = [ex, ed - ex], B = [ed - ey, ey];
  const quad = [];
  // start on +X side wall at y=0 going CCW (towards +y)
  quad.push([ex + r, 0]);
  // arc around A from angle 0 to 45°
  for (let i = 0; i <= cornerSegs; i++) {
    const a = (i / cornerSegs) * (Math.PI / 4);
    quad.push([A[0] + r * Math.cos(a), A[1] + r * Math.sin(a)]);
  }
  // arc around B from 45° to 90°
  for (let i = 0; i <= cornerSegs; i++) {
    const a = Math.PI / 4 + (i / cornerSegs) * (Math.PI / 4);
    quad.push([B[0] + r * Math.cos(a), B[1] + r * Math.sin(a)]);
  }
  quad.push([0, ey + r]);
  // mirror into the other quadrants (CCW)
  const ring = [];
  for (const p of quad) ring.push([p[0], p[1]]);
  for (let i = quad.length - 2; i >= 1; i--) ring.push([-quad[i][0], quad[i][1]]);
  for (let i = 0; i < quad.length; i++) ring.push([-quad[i][0], -quad[i][1]]);
  for (let i = quad.length - 2; i >= 1; i--) ring.push([quad[i][0], -quad[i][1]]);
  // dedupe consecutive duplicates
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p);
  }
  return out;
}

export const ARENA_PARAMS = { X, Y, H, C, RF, RCG, RC, GW, GH, GD, DIAG };
