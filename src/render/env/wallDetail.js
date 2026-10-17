// TURBO PITCH — physical detail on the arena walls, built from the same profile / footprint as the
// collision walls (arenaMesh.js), so it hugs the curved ramps exactly:
//   * panel ribs running up the floor ramp and the solid lower wall (a few cm proud of the surface),
//   * a rim beam along the top of the solid wall with a recessed team-colour LED strip,
//   * the glass frame: metal mullions and a mid-height transom set just behind the glass, each with
//     a glowing strip on the face towards the arena.
// detail stays within a few cm of the playable surface (or behind the glass), so it never reads as
// something a car should hit.
import * as THREE from 'three';
import { ARENA_PARAMS, arenaNormal } from '../../sim/arena.js';
import { halfRing, PROFILE, SPLIT_ROW, RING_S } from './arenaMesh.js';
import { TEAM_COLORS } from '../../contracts.js';

const { Y, H, GW, GH, RCG } = ARENA_PARAMS;
const S = 0.01;

// point + horizontal tangent on the half ring at inset u, at arc length s (of the u = 0 ring)
function ringAt(u, sign, s) {
  const ring = halfRing(u, sign);
  let i = 0;
  while (i < RING_S.length - 2 && RING_S[i + 1] < s) i++;
  const f = (s - RING_S[i]) / Math.max(1e-6, RING_S[i + 1] - RING_S[i]);
  const ax = ring[i][0], ay = ring[i][1], bx = ring[i + 1][0], by = ring[i + 1][1];
  const tl = Math.hypot(bx - ax, by - ay) || 1;
  return { x: ax + (bx - ax) * f, y: ay + (by - ay) * f, tx: (bx - ax) / tl, ty: (by - ay) / tl };
}

// Sweep a closed cross-section along a list of frames. frames: [{ p, a, b }] (sim units, THREE.Vector3
// in sim axes); profile: [[ca, cb, slot]] around the section, the edge from point k to k+1 taking
// slot k. Each profile edge gets its own vertices (sharp across the section, smooth along the path)
// and faces point away from the section's centre. Output is appended to out[slot] = { pos, nrm, col, idx }.
function sweep(out, frames, profile, colours) {
  const m = profile.length;
  let ca = 0, cb = 0;
  for (const [a, b] of profile) { ca += a / m; cb += b / m; }
  const P = new THREE.Vector3(), Q = new THREE.Vector3(), N = new THREE.Vector3();
  for (let k = 0; k < m; k++) {
    const [a0, b0, slot] = profile[k], [a1, b1] = profile[(k + 1) % m];
    const o = out[slot] || (out[slot] = { pos: [], nrm: [], col: [], idx: [] });
    // outward normal of this edge in the section plane
    let ea = b1 - b0, eb = -(a1 - a0);
    if (ea * ((a0 + a1) / 2 - ca) + eb * ((b0 + b1) / 2 - cb) < 0) { ea = -ea; eb = -eb; }
    const base = o.pos.length / 3;
    const col = colours[slot];
    for (const fr of frames) {
      for (const [a, b] of [[a0, b0], [a1, b1]]) {
        P.copy(fr.p).addScaledVector(fr.a, a).addScaledVector(fr.b, b);
        N.copy(fr.a).multiplyScalar(ea).addScaledVector(fr.b, eb).normalize();
        o.pos.push(P.x * S, P.z * S, P.y * S);     // sim -> three
        o.nrm.push(N.x, N.z, N.y);
        o.col.push(col.r, col.g, col.b);
      }
    }
    for (let i = 0; i < frames.length - 1; i++) {
      const v0 = base + i * 2, v1 = v0 + 1, v2 = v0 + 3, v3 = v0 + 2;
      // wind so the face normal agrees with the outward normal
      P.set(o.pos[v1 * 3] - o.pos[v0 * 3], o.pos[v1 * 3 + 1] - o.pos[v0 * 3 + 1], o.pos[v1 * 3 + 2] - o.pos[v0 * 3 + 2]);
      Q.set(o.pos[v3 * 3] - o.pos[v0 * 3], o.pos[v3 * 3 + 1] - o.pos[v0 * 3 + 1], o.pos[v3 * 3 + 2] - o.pos[v0 * 3 + 2]);
      const d = P.cross(Q).dot(N.set(o.nrm[v0 * 3], o.nrm[v0 * 3 + 1], o.nrm[v0 * 3 + 2]));
      if (d > 0) o.idx.push(v0, v1, v2, v0, v2, v3); else o.idx.push(v0, v2, v1, v0, v3, v2);
    }
  }
}

const inGoalMouth = (x, y, margin) => Math.abs(x) < GW + margin && Math.abs(y) > Y - 300;

// frames along the wall profile (floor -> top of the solid wall) at arc length s
function riseFrames(sign, s, r0, r1) {
  const frames = [];
  const n = new THREE.Vector3();
  for (let j = r0; j <= r1; j++) {
    const row = PROFILE[j];
    const r = ringAt(row.u, sign, s);
    arenaNormal(r.x, r.y, Math.max(1, Math.min(row.z, H - 1)), n);
    const t = new THREE.Vector3(r.tx, r.ty, 0);
    frames.push({ p: new THREE.Vector3(r.x, r.y, row.z), a: t, b: n.clone() });
  }
  return { frames, x: ringAt(0, sign, s).x, y: ringAt(0, sign, s).y };
}

// frames running round the ring (at the u = 0 wall, height z), split where the goal mouth interrupts
function ringRuns(sign, z, skipGoal) {
  const runs = [];
  let cur = [];
  const total = RING_S[RING_S.length - 1];
  const stops = new Set(RING_S.map((s) => Math.round(s)));
  for (let s = 0; s <= total; s += 120) stops.add(Math.round(s));
  const list = [...stops].sort((p, q) => p - q);
  const n = new THREE.Vector3();
  for (const s of list) {
    const r = ringAt(0, sign, Math.min(s, total - 1e-3));
    if (skipGoal && inGoalMouth(r.x, r.y, 160)) { if (cur.length > 1) runs.push(cur); cur = []; continue; }
    arenaNormal(r.x, r.y, z, n);
    cur.push({ p: new THREE.Vector3(r.x, r.y, z), a: n.clone().setZ(0).normalize(), b: new THREE.Vector3(0, 0, 1) });
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

export function buildWallDetail() {
  const out = {};
  for (const team of [0, 1]) {
    const sign = team === 0 ? -1 : 1;
    const tc = TEAM_COLORS[team];
    const colours = {
      metal: new THREE.Color(0.62, 0.65, 0.7),
      dark: new THREE.Color(0.08, 0.09, 0.11),
      glow: new THREE.Color(tc.glow).multiplyScalar(team ? 1.6 : 2.4),
    };
    const total = RING_S[RING_S.length - 1];

    // panel ribs up the ramp + lower wall: a flat-topped ridge, 3.5 cm proud, with dark seams either side
    const RIB = [[-14, -2, 'dark'], [-14, 1, 'dark'], [-10, 1.2, 'metal'], [-7, 3.5, 'metal'], [7, 3.5, 'metal'], [10, 1.2, 'dark'], [14, 1, 'dark'], [14, -2, 'dark']];
    for (let s = 300; s < total - 150; s += 575) {
      const { frames, x, y } = riseFrames(sign, s, 0, SPLIT_ROW);
      if (inGoalMouth(x, y, 120)) continue;
      sweep(out, frames, RIB, colours);
    }

    // rim beam along the top of the solid wall (z = GH), 6 cm proud, LED strip in a groove
    const RIM = [[-2, -30, 'metal'], [4, -30, 'metal'], [6, -26, 'metal'], [6, -16, 'dark'], [3.5, -15, 'glow'], [3.5, -9, 'dark'], [6, -8, 'metal'], [6, 2, 'metal'], [4, 5, 'metal'], [-2, 5, 'metal']];
    for (const run of ringRuns(sign, GH, true)) sweep(out, run, RIM, colours);

    // glass frame behind the glass: mullions (vertical) + a transom (horizontal), glowing face inward
    const BEAM = [[-11, -24, 'metal'], [11, -24, 'metal'], [11, -4, 'metal'], [9, -1.5, 'metal'], [4, -1.5, 'glow'], [-4, -1.5, 'metal'], [-9, -1.5, 'metal'], [-11, -4, 'metal']];
    const top = SPLIT_ROW + 1; // straight glass wall: crossbar height up to where the ceiling fillet starts
    for (let s = 600; s < total - 300; s += 1150) {
      const { frames } = riseFrames(sign, s, SPLIT_ROW, top);
      sweep(out, frames, BEAM, colours);
    }
    const zt = (GH + (H - RCG)) / 2;
    const TRANSOM = [[-24, -9, 'metal'], [-2, -9, 'metal'], [-1.5, -3, 'glow'], [-1.5, 3, 'metal'], [-2, 9, 'metal'], [-24, 9, 'metal']];
    for (const run of ringRuns(sign, zt, false)) sweep(out, run, TRANSOM, colours);
  }
  const geos = {};
  for (const [slot, o] of Object.entries(out)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(o.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(o.col, 3));
    g.setIndex(o.idx);
    g.computeBoundingSphere();
    geos[slot] = g;
  }
  return geos;
}
