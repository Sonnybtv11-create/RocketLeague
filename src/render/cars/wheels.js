// TURBO PITCH — tyre & rim geometry (car agent). Original "turbine" rim design.
// Built at radius 100 (build units) then scaled to radius 1, so an instance scale of
// `radius in metres` gives the right size. Axle = +Z; the rim face looks towards +Z
// (outer side of a right-hand wheel). Left wheels are rotated PI about Y by the car model.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { orientOutward, setColor } from './geo.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const cache = new Map();

// width = tyre width / radius (e.g. 0.8)
export function getWheelGeometries(width = 0.8, spokes = 5) {
  const key = width.toFixed(3) + '|' + spokes;
  if (cache.has(key)) return cache.get(key);
  const res = { tyre: buildTyre(width), rim: buildRim(width, spokes) };
  cache.set(key, res);
  return res;
}

function buildTyre(width) {
  const W = width * 100, hw = W / 2, R = 100, ri = 64, c = 15; // shoulder radius
  // closed cross-section, (r, w) pairs; tread points flagged
  const prof = [];
  prof.push([ri, -hw * 0.82, 0]);
  prof.push([ri + 10, -hw * 0.98, 0]);
  prof.push([R - c - 6, -hw * 1.02, 0]);   // sidewall bulge
  for (let k = 0; k <= 3; k++) { const a = Math.PI - (k / 3) * (Math.PI / 2); prof.push([R - c + Math.sin(a) * c, -hw + c + Math.cos(a) * c, k >= 2 ? 1 : 0]); }
  const NT = 6;
  for (let k = 1; k < NT; k++) prof.push([R, lerp(-hw + c, hw - c, k / NT), 1]);
  for (let k = 0; k <= 3; k++) { const a = Math.PI / 2 - (k / 3) * (Math.PI / 2); prof.push([R - c + Math.sin(a) * c, hw - c + Math.cos(a) * c, k <= 1 ? 1 : 0]); }
  prof.push([R - c - 6, hw * 1.02, 0]);
  prof.push([ri + 10, hw * 0.98, 0]);
  prof.push([ri, hw * 0.82, 0]);
  const P = prof.length;
  const SEG = 96, BLOCKS = 24, depth = 4.2;
  const pos = [], idx = [];
  for (let i = 0; i < SEG; i++) {
    const th = (i / SEG) * Math.PI * 2, ct = Math.cos(th), st = Math.sin(th);
    for (const [r, w, tread] of prof) {
      let rr = r;
      if (tread) {
        // chevron tread: grooves alternate, offset by |w| for a V pattern
        const ph = (i / SEG) * BLOCKS + Math.abs(w) / W * 1.3;
        const f = ph - Math.floor(ph);
        const groove = f > 0.7 ? 1 : 0;
        const centreGroove = Math.abs(w) < W * 0.06 ? 1 : 0;
        rr -= depth * Math.max(groove, centreGroove);
      }
      pos.push(ct * rr, st * rr, w);
    }
  }
  for (let i = 0; i < SEG; i++) {
    const i2 = (i + 1) % SEG;
    for (let j = 0; j < P; j++) {
      const j2 = (j + 1) % P;
      const a = i * P + j, b = i * P + j2, c2 = i2 * P + j, d = i2 * P + j2;
      idx.push(a, b, c2, b, d, c2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const out = orientOutward(toCreasedNormals(g, THREE.MathUtils.degToRad(50)));
  out.scale(0.01, 0.01, 0.01);
  out.computeBoundingSphere();
  return out;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function lathe(profile, segs) { // profile [[r, w]] around Z axis
  const pts = profile.map(([r, w]) => new THREE.Vector2(Math.max(0.01, r), w));
  const g = new THREE.LatheGeometry(pts, segs);
  // lathe axis is +Y; rotate so it becomes +Z
  g.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  g.deleteAttribute('uv');
  return toCreasedNormals(g, THREE.MathUtils.degToRad(40));
}

function buildRim(width, spokes) {
  const hw = width * 50;
  const face = hw * 0.78;          // outer face plane of the spokes
  const SILVER = [0.78, 0.8, 0.84], GRAPH = [0.1, 0.11, 0.13], LIP = [0.92, 0.93, 0.95], DARK = [0.05, 0.05, 0.06];
  const parts = [];
  // barrel (inner, dark) — sits inside the tyre bead
  parts.push(setColor(orientOutward(lathe([[63, -hw * 0.8], [65, -hw * 0.75], [65, hw * 0.6], [63, hw * 0.66]], 32)), ...GRAPH));
  // outer lip ring (polished)
  parts.push(setColor(orientOutward(lathe([[58, face - 6], [66, face - 3], [67.5, face + 1.5], [65.5, face + 3], [59, face + 1], [57, face - 3]], 40)), ...LIP));
  // recessed dish (dark) behind the spokes
  parts.push(setColor(orientOutward(lathe([[0.5, face - 14], [40, face - 14], [58, face - 8], [58.5, face - 6]], 32)), ...DARK));
  // spokes: twisted turbine blades, each a tapered box from hub to lip
  for (let s = 0; s < spokes; s++) {
    const a = (s / spokes) * Math.PI * 2;
    const blade = new THREE.BoxGeometry(46, 13, 7, 4, 1, 1);
    const bp = blade.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i) + 23 + 12; // 12..58 radial
      const t = (x - 12) / 46;
      const y = bp.getY(i) * (1 - 0.45 * t) + (t * t) * 9; // taper + sweep (turbine curve)
      const z = bp.getZ(i) - t * 2.5;                     // dish slightly inward towards the lip
      bp.setXYZ(i, x, y, z);
    }
    blade.deleteAttribute('uv');
    const g = toCreasedNormals(blade, THREE.MathUtils.degToRad(30));
    g.applyMatrix4(new THREE.Matrix4().makeRotationZ(a));
    g.translate(0, 0, face - 3.5);
    parts.push(setColor(g, ...SILVER));
  }
  // hub + cap
  parts.push(setColor(orientOutward(lathe([[0.5, face + 3], [10, face + 3], [14, face + 1], [16, face - 6], [16, face - 9]], 24)), ...SILVER));
  parts.push(setColor(orientOutward(lathe([[0.5, face + 3.6], [6, face + 3.6], [7, face + 3.1]], 20)), ...GRAPH));
  // lug nuts
  for (let s = 0; s < spokes; s++) {
    const a = (s / spokes) * Math.PI * 2 + Math.PI / spokes;
    const n = new THREE.CylinderGeometry(2, 2, 3, 6); n.deleteAttribute('uv');
    n.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    n.translate(Math.cos(a) * 11, Math.sin(a) * 11, face + 3);
    parts.push(setColor(n.toNonIndexed(), ...GRAPH));
  }
  const m = mergeGeometries(parts.map((g) => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k); return g.index ? g.toNonIndexed() : g; }), false);
  m.scale(0.01, 0.01, 0.01);
  m.computeBoundingSphere();
  return m;
}
