// Verifies that the rendered arena shell matches the collision SDF.
// Usage: node src/render/env/check-sdf.mjs
// Samples every vertex of every collision-surface render geometry, converts it
// back to sim units and asserts |arenaSDF| < 3 uu. Also reports the max error
// at triangle centroids (chord error of the tessellation) and checks that the
// triangle front faces point into free space.
import { arenaSDF } from '../../sim/arena.js';
import { buildArenaGeometries, surfaceList } from './arenaMesh.js';

const TOL = 3;
const geos = buildArenaGeometries();
let worstV = 0, worstC = 0, worstName = '', fails = 0, verts = 0, tris = 0, backfacing = 0;
const toSim = (p, i) => [p[i] / 0.01, p[i + 2] / 0.01, p[i + 1] / 0.01];

for (const [name, g] of surfaceList(geos)) {
  const p = g.attributes.position.array;
  const used = new Set(g.index.array);
  let mv = 0, bf = 0;
  for (const vi of used) {
    const i = vi * 3;
    const [x, y, z] = toSim(p, i);
    const d = Math.abs(arenaSDF(x, y, z));
    verts++;
    if (d > mv) mv = d;
    if (d >= TOL) { fails++; if (fails < 10) console.log(`  FAIL ${name} vertex (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) sdf=${d.toFixed(3)}`); }
  }
  const idx = g.index.array;
  let mc = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = toSim(p, idx[t] * 3), b = toSim(p, idx[t + 1] * 3), c = toSim(p, idx[t + 2] * 3);
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    tris++;
    // facing: sim-space triangle normal (note sim<-three swap is a mirror, so flip)
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = -(uy * vz - uz * vy), ny = -(uz * vx - ux * vz), nz = -(ux * vy - uy * vx);
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-6) {
      // surface error at the centroid, evaluated a hair on the free-space side
      // (the SDF is one-sided exactly on the goal-post cut planes)
      const h = 0.01;
      const d = Math.abs(arenaSDF(cx + nx / nl * h, cy + ny / nl * h, cz + nz / nl * h) - h);
      if (d > mc) mc = d;
      const e = 2;
      const off = arenaSDF(cx + nx / nl * e, cy + ny / nl * e, cz + nz / nl * e) - arenaSDF(cx - nx / nl * e, cy - ny / nl * e, cz - nz / nl * e);
      if (off < 0) { backfacing++; bf++; }
    }
  }
  console.log(`${name.padEnd(12)} verts ${String(p.length / 3).padStart(5)}  tris ${String(idx.length / 3).padStart(5)}  max|sdf| vertex ${mv.toFixed(4)} uu  centroid ${mc.toFixed(3)} uu  inverted ${bf}`);
  if (mv > worstV) { worstV = mv; worstName = name; }
  if (mc > worstC) worstC = mc;
}
console.log(`\n${verts} vertices, ${tris} triangles checked`);
console.log(`max |sdf| at surface vertices: ${worstV.toFixed(4)} uu (${worstName}); tolerance ${TOL} uu`);
console.log(`max |sdf| at triangle centroids (tessellation chord error): ${worstC.toFixed(3)} uu`);
console.log(`triangles facing into the solid: ${backfacing}`);
if (fails || backfacing) { console.log(`FAILED (${fails} vertices out of tolerance, ${backfacing} inverted triangles)`); process.exit(1); }
console.log('PASS');
