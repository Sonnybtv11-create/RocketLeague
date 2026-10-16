// TURBO PITCH — the six original car bodies (car agent).
// Every body is built procedurally in Unreal Units in car model axes (+X fwd, +Y up, +Z right,
// origin = centre of mass) around its hitbox class, then scaled to metres.
//
//   vector    (OCTANE)   — tall, rounded rally hatch with separate front pods and rear haunches
//   lancer    (DOMINUS)  — long, low, wide muscle coupe; long hood, fastback, ducktail
//   stingray  (PLANK)    — very flat manta wedge; narrow fuselage, bubble canopy, sponsons, fins
//   arrowhead (BREAKOUT) — knife-nosed wedge, straight hood line, short cabin, square tail
//   nomad     (HYBRID)   — mid-height sport coupe, cab-rearward, front wheel pods
//   bulwark   (MERC)     — boxy armoured van, tall roof, bull bar, roof rack, spare wheel
//
// buildBody(bodyId) -> { geoms: {slot: BufferGeometry|null}, nozzles: [Vector3 m], tyre: {...}, hitbox }
import * as THREE from 'three';
import { CAR_CONFIGS, wheelLayout } from '../../sim/carconfig.js';
import { CAR_BODIES } from '../../contracts.js';
import { smooth, PartSet, Loft, sweepArc, roundedBox, latheX, discX, extrudeSide, M, setColor, clamp } from './geo.js';
import { getWheelGeometries } from './wheels.js';
import { VECTOR_MESH_META, VECTOR_MESH_B64 } from './vectorMesh.js';

// HDR vertex colours for emissive parts (bloom picks these up)
const HEAD = [2.1, 2.2, 2.5];   // bright but not a glare blob in daylight
const DRL = [2.2, 2.9, 4.2];
const TAIL = [2.8, 0.06, 0.05];
const AMBER = [3.2, 1.3, 0.1];

// Rest pose of the wheels (sim local, uu) — what the suspension settles to at idle.
function restWheels(hitbox, extraF, extraB) {
  const cfg = CAR_CONFIGS[hitbox];
  return wheelLayout(cfg).filter((w) => !w.left).map((w) => ({
    front: w.front, x: w.offset.x, y: w.offset.z - (w.restLen - 2), r: w.radius,
    z: w.offset.y + (w.front ? extraF : extraB),
  }));
}

// Height of the wheel-arch opening at x (or -Infinity if not over a wheel)
function archAt(x, wheels, clr, stretch = 1.0) {
  let h = -Infinity;
  for (const w of wheels) {
    const R = w.r + clr, dx = (x - w.x) / stretch;
    if (Math.abs(dx) < R) h = Math.max(h, w.y + Math.sqrt(R * R - dx * dx));
  }
  return h;
}

// Generic section from smooth tables.
// t: {p0, p1w?, p1y?, p2w, p2y, p3w, p3y, p4w, p4y, p5}
function sectionFn(t, wheels, clr, archStretch) {
  const f = {};
  for (const k of Object.keys(t)) f[k] = smooth(t[k]);
  return (x) => {
    const p0 = f.p0(x);
    const p2w = f.p2w(x);
    let p2y = f.p2y(x);
    let p1w = f.p1w ? f.p1w(x) : p2w * 0.86, p1y = f.p1y ? f.p1y(x) : p0 + 1.2;
    let p3w = f.p3w(x), p3y = f.p3y(x);
    let p4w = f.p4w(x), p4y = f.p4y(x);
    let p5 = f.p5(x);
    const a = wheels ? archAt(x, wheels, clr, archStretch) : -Infinity;
    if (a > p1y) { p1y = a; }
    if (a + 0.8 > p2y) p2y = a + 0.8;
    if (p3y < p2y + 1.2) p3y = p2y + 1.2;
    if (p4y < p3y + 0.4) p4y = p3y + 0.4;
    if (p5 < p4y + 0.2) p5 = p4y + 0.2;
    p4w = Math.min(p4w, p3w - 0.3);
    p1w = Math.min(p1w, p2w - 0.3);
    return [[0, p0], [p1w, p1y], [p2w, p2y], [p3w, p3y], [p4w, p4y], [0, p5]];
  };
}

function stations(x0, x1, step, extra = []) {
  const s = new Set();
  const n = Math.ceil((x1 - x0) / step);
  for (let i = 0; i <= n; i++) s.add(+(x0 + (x1 - x0) * i / n).toFixed(3));
  for (const e of extra) if (e > x0 && e < x1) s.add(+e.toFixed(3));
  return [...s].sort((a, b) => a - b);
}

// classification rules: [{seg (number|array), x0, x1, slot}], later rules win
// two-tone: the lower band of every body is dark trim (bumpers, sills), paint above it
function classifier(rules, base = ['trim', 'trim', 'paint', 'paint', 'paint']) {
  return (x, seg) => {
    let s = base[seg];
    for (const r of rules) {
      const segOk = Array.isArray(r.seg) ? r.seg.includes(seg) : r.seg === seg;
      if (segOk && x >= r.x0 && x <= r.x1) s = r.slot;
    }
    return s;
  };
}

// Fender / arch shell around a wheel (right side; mirrored by caller)
function fender(ps, slot, w, { rin, rout, z0, z1, a0 = -0.25, a1 = Math.PI + 0.25, segs = 18, lip = 1.2 }) {
  const prof = [[rin, z0], [rout - lip, z0], [rout, z0 + lip], [rout, z1 - lip * 1.4], [rout - lip * 1.4, z1], [rin, z1]];
  const g = sweepArc(prof, a0, a1, segs, true, 50);
  g.translate(w.x, w.y, 0);
  ps.addMirrored(slot, g);
}

function light(ps, color, lx, ly, lz, x, y, z, rx = 0, ry = 0, rz = 0, r = 0.8) {
  const g = setColor(roundedBox(lx, ly, lz, r, 1), ...color);
  ps.addMirrored('light', g, M(x, y, z, rx, ry, rz));
}

// A box lying on the loft surface at (x, u): local Y = surface normal, local X = along the body.
// ly is the thickness along the normal; `embed` sinks it into the surface.
const _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3(), _P = new THREE.Vector3();
function surfBox(ps, slot, loft, x, u, lx, ly, lz, { embed = 0.4, r = 0.5, color = null, mirrored = true, roll = 0, yaw = 0 } = {}) {
  loft.point(x, u, _P); loft.normal(x, u, _Y);
  _X.set(1, 0, 0).addScaledVector(_Y, -_Y.x);
  if (_X.lengthSq() < 1e-4) _X.set(0, 1, 0).addScaledVector(_Y, -_Y.y);
  _X.normalize();
  if (yaw) _X.applyAxisAngle(_Y, yaw).normalize();
  _Z.crossVectors(_X, _Y);
  const m = new THREE.Matrix4().makeBasis(_X, _Y, _Z);
  if (roll) m.multiply(new THREE.Matrix4().makeRotationX(roll));
  m.setPosition(_P.x + _Y.x * (ly / 2 - embed), _P.y + _Y.y * (ly / 2 - embed), _P.z + _Y.z * (ly / 2 - embed));
  let g = roundedBox(lx, ly, lz, r, 1);
  if (color) g = setColor(g, ...color);
  if (mirrored) ps.addMirrored(slot, g, m); else ps.add(slot, g, m);
}

function nozzle(ps, x, y, z, r, len = 6, mirrored = false) {
  // chrome bell + dark throat; glowing core disc set slightly inside the exit
  const bell = latheX([[0, r * 0.55], [-len * 0.15, r * 0.95], [-len * 0.75, r * 1.05], [-len, r * 0.96], [-len - 0.4, r * 0.7], [-len + 0.6, r * 0.62]], 22, 50);
  const throat = latheX([[-len + 0.8, r * 0.64], [-len * 0.4, r * 0.5], [0, r * 0.3]], 18);
  const core = discX(r * 0.6, 20, -1);
  const add = mirrored ? (slot, g, m) => ps.addMirrored(slot, g, m) : (slot, g, m) => ps.add(slot, g, m);
  add('chrome', bell, M(x + len, y, z));
  add('trim', throat, M(x + len, y, z));
  add('glow', core, M(x + 0.2, y, z));
}

// ----------------------------------------------------------------------------
const BODY_SPECS = {
  // =========================================================================
  vector: {
    // Octane-class buggy: low narrow nose with a barred grille cage and corner lamps, separate front
    // fender pods, pinched waist, compact cabin set back, high rear deck with an exposed engine block,
    // wide haunches and a big wing on struts. Floor raised for visible ground clearance.
    hitbox: 'OCTANE', tyre: { wF: 11.0, wB: 13.0, extraF: 6, extraB: 5, spokes: 10 },
    nozzles: [[-52.0, 13.0, 0, 5.6]],
    build(B) {
      const { ps, W } = B;
      const x0 = -50, x1 = 70;
      const t = {
        p0: [[x0, 6], [-40, 0], [55, 0], [x1, 4]],
        p2w: [[x0, 31], [-44, 35], [-30, 36], [-16, 34], [-4, 31], [14, 30], [30, 28.5], [46, 26], [60, 22.5], [x1, 18]],
        p2y: [[x0, 16], [-30, 17], [0, 16], [30, 13], [46, 11], [x1, 8.5]],
        p3w: [[x0, 29], [-44, 33], [-30, 34], [-16, 32], [-4, 29], [14, 28], [30, 26.5], [46, 24], [60, 20.5], [x1, 16]],
        p3y: [[x0, 30], [-40, 31], [-26, 29.5], [-14, 26.5], [0, 25], [14, 24.5], [26, 24], [36, 21.5], [46, 19], [58, 16.5], [x1, 12.5]],
        p4w: [[x0, 18], [-44, 20], [-30, 21], [-24, 20.5], [-14, 19.5], [8, 19.5], [22, 20.5], [30, 21], [46, 19], [60, 16.5], [x1, 13]],
        p4y: [[x0, 31], [-44, 32], [-30, 33], [-24, 37], [-14, 40], [2, 40], [34, 26.6], [40, 24.2], [46, 21.8], [58, 18.2], [x1, 14]],
        p5: [[x0, 31.5], [-44, 32.5], [-30, 33.5], [-24, 38.5], [-14, 42], [2, 42], [36, 27.4], [40, 26], [46, 24.4], [58, 21], [x1, 16]],
      };
      const [wf, wb] = W;
      // only the rear wheels shape the body (haunches); the front wheels sit in separate pods
      const loft = new Loft({
        section: sectionFn(t, [wb], 3.2), xs: stations(x0, x1, 2, [-24, -23, -15, -14, 2, 3, 34, 36, 64, 66]),
        tension: [0, 0.85, 0.7, 0.9, 0.85, 0.35], // hard-surface creases
        classify: classifier([
          { seg: 3, x0: -22, x1: 29, slot: 'glass' },     // side windows
          { seg: 4, x0: 3, x1: 35, slot: 'glass' },       // long raked windscreen
          { seg: 4, x0: -23, x1: -15, slot: 'glass' },    // small rear window
          { seg: [1, 2], x0: 64, x1: 72, slot: 'trim' },  // lower fascia
          { seg: 1, x0: -60, x1: -44, slot: 'trim' },     // rear diffuser
        ], ['trim', 'paint', 'paint', 'paint', 'paint']), // body colour down to the sills
        capSlot: 'paint',
      });
      loft.build(ps, 24);
      B.loft = loft;
      // racing stripes (accent)
      loft.patch(ps, 'accent', -48.5, 68.5, 0.88, 0.955, 0.2, 60, 2);
      loft.patch(ps, 'accent', -48.5, 68.5, -0.88, -0.955, 0.2, 60, 2);
      // dark side scoops along the pinched waist
      loft.patch(ps, 'trim', 12, 32, 0.22, 0.4, 0.25, 12, 2);   // scoop behind each front pod
      loft.patch(ps, 'trim', 12, 32, -0.22, -0.4, 0.25, 12, 2);
      // front fender pods standing off the narrow nose, joined by dark brackets; wide rear haunches
      fender(ps, 'paint', wf, { rin: 15.4, rout: 18.2, z0: 21.5, z1: 44, a0: -0.12, a1: Math.PI - 0.02, lip: 1.4, segs: 6 }); // angular faceted pod
      fender(ps, 'trim', wf, { rin: 15.0, rout: 15.5, z0: 22, z1: 43.5, a0: -0.12, a1: Math.PI - 0.02, lip: 0.2 });
      // sweep from the back of each pod into the body side
      ps.addMirrored('paint', extrudeSide([[wf.x + 10, wf.y + 15.5], [wf.x - 6, wf.y + 17.2], [wf.x - 20, wf.y + 18.4], [wf.x - 21, wf.y + 14.5], [wf.x + 10, wf.y + 13]], 20, 0.6), M(0, 0, 29)); // flat bridge from hood to pod
      ps.addMirrored('paint', extrudeSide([[wf.x - 19, wf.y + 19.8], [wf.x - 36, wf.y + 25.2], [wf.x - 44, wf.y + 27.2], [wf.x - 46, wf.y + 26], [wf.x - 34, wf.y + 22], [wf.x - 20, wf.y + 15.2]], 4.2, 0.6), M(0, 0, 27.6)); // side rib
      ps.addMirrored('trim', extrudeSide([[wf.x - 20, wf.y + 15], [wf.x - 34, wf.y + 21.6], [wf.x - 45, wf.y + 25.6], [wf.x - 45, wf.y + 24.4], [wf.x - 34, wf.y + 20.4], [wf.x - 20, wf.y + 13.8]], 4.4, 0.3), M(0, 0, 27.6)); // dark underline
      ps.addMirrored('trim', roundedBox(4, 9, 3, 1), M(wf.x - 9, wf.y + 6, 21.5));
      fender(ps, 'paint', wb, { rin: 18.3, rout: 23.5, z0: 28, z1: 46, a0: 0.12, a1: Math.PI + 0.12 });
      fender(ps, 'trim', wb, { rin: 17.9, rout: 18.4, z0: 28.5, z1: 45.5, a0: 0.12, a1: Math.PI + 0.12, lip: 0.2 });
      // front: bumper block, barred grille cage, round lamps low at the corners
      ps.add('trim', roundedBox(8, 8, 30, 2), M(67, 5.5, 0));
      ps.add('trim', roundedBox(3, 3, 32, 1.4), M(73.5, 13, 0));        // top tube
      ps.add('trim', roundedBox(3, 3, 40, 1.4), M(73, 2.5, 0));         // bottom tube
      for (let z = -12; z <= 12.01; z += 3) ps.add('chrome', setColor(roundedBox(1.6, 9.4, 1.1, 0.4), 0.32, 0.33, 0.37), M(73.6, 7.7, z)); // grille slats
      for (const z of [14.5, -14.5]) ps.add('trim', roundedBox(2.6, 10.5, 2.6, 1.1), M(73.4, 7.7, z)); // cage uprights
      ps.addMirrored('trim', roundedBox(7, 2.6, 2.6, 1.1), M(70.5, 12.8, 16.5, 0, -0.5, 0));
      for (const z of [18, -18]) {
        ps.add('trim', latheX([[-4.5, 0.01], [-4.5, 3.4], [-1, 4.2], [-1, 0.01]], 22, 40), M(76, 4.6, z));        // lamp can
        ps.add('chrome', latheX([[0, 0.01], [0, 4.5], [-1.2, 4.7], [-1.6, 4.4], [-1.6, 0.01]], 24, 40), M(76.2, 4.6, z)); // bezel
        ps.add('trim', latheX([[0.05, 3.2], [0.05, 3.7], [-0.6, 3.7], [-0.6, 3.2]], 24, 40), M(76.25, 4.6, z));   // inner ring
        ps.add('light', setColor(discX(3.2, 22, 1), ...HEAD), M(76.3, 4.6, z));
      }
      light(ps, DRL, 1.2, 1.2, 4.5, 70.2, 11, 12.5, 0, 0, 0, 0.5);
      // rear: bumper bar, tail lights, exposed engine block on the deck
      ps.add('trim', roundedBox(4, 5, 30, 1.2), M(-49, 9.5, 0));
      light(ps, TAIL, 2, 4.2, 11, -50.2, 27, 19, 0, 0, 0, 1.1);
      light(ps, AMBER, 1.6, 1.4, 5, -50.1, 23.7, 22, 0, 0, 0, 0.5);
      ps.add('trim', roundedBox(22, 4, 26, 1.5), M(-36, 33.5, 0));                 // engine bay plinth
      ps.add('chrome', roundedBox(15, 7.5, 18, 1.8), M(-35, 38, 0));               // engine block
      ps.add('chrome', setColor(roundedBox(11, 4.4, 15, 1.6), 0.78, 0.07, 0.05), M(-37, 43, 0)); // big red engine cover
      for (const z of [5, -5]) ps.add('chrome', latheX([[0, 0.01], [0, 1.1], [10, 1.1], [10, 0.01]], 10, 40), M(-47, 40.5, z)); // pipes
      ps.add('chrome', latheX([[0, 0.01], [0, 3.2], [3.5, 3.6], [4, 0.01]], 18, 40), M(-27, 38.5, 0, 0, 0, Math.PI / 2 - 0.3)); // intake
      // tall rear haunches that sweep up into pointed fins at the back corners, flanking the deck
      const fin = extrudeSide([[-16, 27], [-30, 30.5], [-42, 34.5], [-52, 40.5], [-54, 40], [-50, 34], [-46, 29], [-32, 26.5]], 4.5, 0.6); // swept fin
      ps.addMirrored('paint', fin, M(0, 0, 32.5));
      const finEdge = extrudeSide([[-42, 34.7], [-52, 40.7], [-54.2, 40.1], [-52.8, 39], [-44, 33.8]], 4.9, 0.3);
      ps.addMirrored('trim', finEdge, M(0, 0.15, 32.5));
      // dark mechanical rear face between the fins
      ps.add('trim', roundedBox(2.5, 13, 24, 1), M(-48.8, 19, 0));                     // recessed rear frame
      for (const z of [8, -8]) ps.add('chrome', latheX([[0, 0.01], [0, 2.1], [-6, 2.3], [-6.4, 1.6], [-5.8, 0.01]], 16, 40), M(-47, 13.5, z)); // exhaust pipes
      for (const z of [31.5, -31.5]) light(ps, TAIL, 1.4, 7, 4, -51.2, 33.5, z, 0, 0, -0.35, 0.6); // tail lights on the fin backs
      // dark edging on the outer faces of the front pods and rear haunches
      fender(ps, 'trim', wf, { rin: 15.0, rout: 18.5, z0: 43.4, z1: 44.6, a0: -0.12, a1: Math.PI - 0.02, lip: 0.3 });
      fender(ps, 'trim', wb, { rin: 17.9, rout: 23.8, z0: 45.4, z1: 46.6, a0: 0.12, a1: Math.PI + 0.12, lip: 0.3 });
      // front coilovers between body and pods: red springs on chrome shocks
      ps.addMirrored('chrome', setColor(latheX([[0, 0.01], [0, 1.9], [8, 1.9], [8, 0.01]], 12, 40), 0.78, 0.07, 0.05), M(wf.x - 2, wf.y + 3, 19.5, 0, 0, Math.PI / 2 - 0.25));
      ps.addMirrored('chrome', latheX([[0, 0.01], [0, 0.8], [11, 0.8], [11, 0.01]], 10, 40), M(wf.x - 2.5, wf.y + 1.5, 19.5, 0, 0, Math.PI / 2 - 0.25));
      // red canisters flanking the engine and a roof intake box
      for (const z of [10.5, -10.5]) ps.add('chrome', setColor(latheX([[0, 0.01], [0, 2.7], [0.6, 3], [9.4, 3], [10, 2.7], [10, 0.01]], 16, 40), 0.8, 0.07, 0.05), M(-45, 37.5, z));
      ps.add('trim', roundedBox(13, 2, 15, 0.8), M(-21, 41.2, 0));
      ps.add('chrome', setColor(roundedBox(11, 6.5, 13, 1.8), 0.72, 0.74, 0.78), M(-21.5, 45, 0));
      ps.add('trim', roundedBox(1, 4.6, 10.5, 0.3), M(-15.9, 45, 0));
      for (let y = 43.3; y <= 46.8; y += 1.15) ps.add('chrome', setColor(roundedBox(0.6, 0.35, 10, 0.15), 0.45, 0.46, 0.5), M(-15.4, y, 0));
      // big wing on struts above the deck
      const wing = extrudeSide([[-54, 50], [-51.5, 52.5], [-42.5, 52.1], [-41, 51.1], [-46, 50]], 66, 0.5);
      ps.add('accent', wing);
      ps.addMirrored('trim', extrudeSide([[-55, 48.5], [-52, 54.5], [-41, 53.5], [-40, 50], [-44, 47.5]], 1.6, 0.4), M(0, 0, 33.6)); // large endplates
      ps.addMirrored('trim', roundedBox(3, 11, 1.6, 0.5), M(-45.5, 44.5, 13, 0, 0, -0.25));
    },
  },
  // =========================================================================
  lancer: {
    hitbox: 'DOMINUS', tyre: { wF: 12.0, wB: 13.6, extraF: 4, extraB: 3.5, spokes: 6 },
    nozzles: [[-60.0, 6.5, 12, 4.6], [-60.0, 6.5, -12, 4.6]],
    build(B) {
      const { ps, W } = B;
      const x0 = -58, x1 = 77;
      const t = {
        p0: [[x0, 2], [-50, -2.5], [65, -2.5], [x1, 1]],
        p2w: [[x0, 36], [-52, 40], [-35, 41.5], [-15, 40], [10, 38.5], [45, 40], [65, 38], [x1, 31]],
        p2y: [[x0, 9], [0, 7], [x1, 6]],
        p3w: [[x0, 34], [-50, 37.5], [-35, 39], [0, 35], [20, 36.5], [55, 36], [72, 30], [x1, 26]],
        p3y: [[x0, 21], [-45, 22], [-20, 21.5], [0, 20.5], [18, 18.6], [55, 16.5], [x1, 11]],
        p4w: [[x0, 30], [-46, 32], [-38, 30], [-21, 21], [-4, 21.5], [12, 30], [18, 32], [55, 32], [x1, 22]],
        p4y: [[x0, 21.8], [-46, 23.2], [-38, 25.5], [-21, 31.5], [-4, 31.5], [12, 22], [18, 19.3], [55, 17.2], [x1, 11.8]],
        p5: [[x0, 22.2], [-52, 23.5], [-44, 24.2], [-38, 27], [-21, 33], [-12, 33.3], [-4, 32.6], [17, 20.2], [40, 19.6], [60, 17.8], [x1, 12.2]],
      };
      const loft = new Loft({
        section: sectionFn(t, W, 2.6, 1.1), xs: stations(x0, x1, 2, [-46, -38, -36, -21, -4, -3, 16, 17, 18, 73]),
        tension: [0, 0.4, 0.2, 0.55, 0.5, 0],
        classify: classifier([
          { seg: 3, x0: -36, x1: 16, slot: 'glass' },
          { seg: 4, x0: -3, x1: 17, slot: 'glass' },
          { seg: 4, x0: -38, x1: -21, slot: 'glass' },
          { seg: [1, 2], x0: 73, x1: 80, slot: 'trim' },
          { seg: 1, x0: -60, x1: -50, slot: 'trim' },
        ]),
        capSlot: (dir) => (dir > 0 ? 'trim' : 'paint'),
      });
      loft.build(ps, 36);
      B.loft = loft;
      // hood power bulge (accent) + twin stripes on the deck
      loft.patch(ps, 'accent', 18, 73, 0.935, 1.065, 0.45, 30, 4);
      loft.patch(ps, 'accent', -56.5, -40, 0.86, 0.94, 0.2, 10, 2);
      loft.patch(ps, 'accent', -56.5, -40, -0.86, -0.94, 0.2, 10, 2);
      // side strake (accent) along the flank
      loft.patch(ps, 'accent', -28, 40, 0.505, 0.535, 0.25, 30, 2);
      loft.patch(ps, 'accent', -28, 40, -0.505, -0.535, 0.25, 30, 2);
      const [wf, wb] = W;
      fender(ps, 'trim', wf, { rin: 14.4, rout: 15.0, z0: 27.5, z1: 41, a0: 0.05, a1: Math.PI - 0.05, lip: 0.2 });
      fender(ps, 'trim', wb, { rin: 15.9, rout: 16.5, z0: 29, z1: 42.5, a0: 0.05, a1: Math.PI - 0.05, lip: 0.2 });
      // ducktail lip
      ps.add('accent', extrudeSide([[-58.8, 22], [-59.6, 25.6], [-55.5, 25], [-50, 23.4]], 64, 0.5));
      // chin splitter, rear diffuser fins
      ps.add('trim', roundedBox(8, 2.4, 66, 1), M(74, -1.2, 0));
      for (const z of [-20, -6, 6, 20]) ps.add('trim', roundedBox(10, 4, 1.2, 0.4), M(-54, 1, z));
      // lights
      light(ps, HEAD, 2.4, 2.6, 13, 75.2, 10.2, 18, 0, -0.35, 0.05, 1.0);
      light(ps, DRL, 1, 0.9, 16, 75.4, 7.2, 16, 0, -0.3, 0, 0.4);
      light(ps, TAIL, 2, 2.4, 7, -58.2, 18.5, 26, 0, 0.25, 0, 0.8);
      light(ps, TAIL, 2, 2.4, 7, -58.4, 18.5, 17.5, 0, 0.1, 0, 0.8);
      // side vents
      ps.addMirrored('trim', roundedBox(9, 3.2, 1.2, 0.5), M(31, 11.5, 39.4, 0, -0.05, 0));
    },
  },
  // =========================================================================
  stingray: {
    hitbox: 'PLANK', tyre: { wF: 12.5, wB: 17.5, extraF: 6, extraB: 15.5, spokes: 6 },
    nozzles: [[-60.2, 6, 9, 4.8], [-60.2, 6, -9, 4.8]],
    build(B) {
      const { ps, W } = B;
      const x0 = -58, x1 = 79;
      const t = {
        p0: [[x0, -1], [-50, -3.5], [70, -3.5], [x1, -2.5]],
        p1y: [[x0, 0], [-50, -2.4], [70, -2.4], [x1, -2]],
        p2w: [[x0, 24], [-36, 25], [-20, 26], [-12, 38], [32, 39], [40, 26], [60, 25], [72, 27], [x1, 22]],
        p2y: [[x0, 5], [-20, 4], [0, 2.5], [40, 1.5], [x1, -1]],
        p3w: [[x0, 23], [-36, 24], [-20, 25], [-12, 35], [30, 36], [40, 24.5], [60, 24], [72, 25], [x1, 19]],
        p3y: [[x0, 13.5], [-30, 13.5], [0, 12], [20, 10.5], [45, 7.5], [65, 4.5], [x1, 1.5]],
        p4w: [[x0, 19], [-34, 20], [-30, 15], [-20, 13.5], [0, 13.5], [16, 15], [22, 17], [45, 17], [x1, 12]],
        p4y: [[x0, 14.2], [-34, 14.4], [-30, 17], [-20, 24.5], [-4, 25.8], [12, 18.5], [22, 13.2], [45, 8.4], [65, 5.4], [x1, 2.2]],
        p5: [[x0, 15], [-34, 15.4], [-28, 19], [-14, 28.2], [-6, 28.4], [8, 24], [21, 14.3], [45, 9.2], [65, 6], [x1, 2.6]],
      };
      const loft = new Loft({
        section: sectionFn(t, W, 2.5), xs: stations(x0, x1, 2, [-30, -28, -4, 12, 21, 22, 74]),
        tension: [0, 0.3, 0.55, 0.5, 0.4, 0],
        classify: classifier([
          { seg: [3, 4], x0: -28, x1: 21, slot: 'glass' },      // bubble canopy
          { seg: [1, 2], x0: 74, x1: 82, slot: 'trim' },
        ]),
        capSlot: (dir) => (dir > 0 ? 'trim' : 'paint'),
      });
      loft.build(ps, 40);
      B.loft = loft;
      // canopy frame (accent) + nose stripe
      loft.patch(ps, 'accent', 21, 76, 0.93, 1.07, 0.25, 24, 4);
      loft.patch(ps, 'accent', -56, -28, 0.94, 1.06, 0.25, 12, 4);
      const [wf, wb] = W;
      // front wheel pods (open-wheel style blades)
      fender(ps, 'paint', wf, { rin: 15.0, rout: 17.4, z0: 25.5, z1: 41.5, a0: -0.15, a1: Math.PI * 0.95, segs: 16 });
      // big rear fender pods + fins
      fender(ps, 'paint', wb, { rin: 19.6, rout: 22.8, z0: 25.5, z1: 46.2, a0: -0.1, a1: Math.PI + 0.35, segs: 20 });
      fender(ps, 'trim', wb, { rin: 19.2, rout: 19.7, z0: 26, z1: 45.6, a0: -0.1, a1: Math.PI + 0.35, segs: 20, lip: 0.2 });
      const fin = extrudeSide([[-62, 14], [-60, 34.5], [-56.5, 35], [-44, 21], [-30, 16], [-30, 14]], 2.2, 0.6);
      ps.addMirrored('paint', fin, M(0, 0, 33));
      ps.addMirrored('accent', extrudeSide([[-61.2, 30.5], [-60.4, 34.6], [-56.8, 35.1], [-54.6, 32.4]], 2.6, 0.4), M(0, 0, 33));
      // sponson side intakes
      ps.addMirrored('trim', roundedBox(12, 3, 2, 0.8), M(4, 4.2, 38.5, 0, 0.08, 0));
      // shovel splitter
      ps.add('trim', extrudeSide([[70, -4.2], [82.5, -3.6], [82, -1.8], [70, -2]], 50, 0.5));
      // lights: slim slits at the nose, tail bar between fins
      light(ps, HEAD, 6, 1.4, 6, 76.2, 1.4, 14, 0, -0.35, -0.1, 0.6);
      light(ps, TAIL, 1.4, 1.8, 16, -58.4, 11.6, 10, 0, 0, 0, 0.6);
    },
  },
  // =========================================================================
  arrowhead: {
    hitbox: 'BREAKOUT', tyre: { wF: 12.0, wB: 12.5, extraF: 7, extraB: 1, spokes: 5 },
    nozzles: [[-59.0, 5.0, 15, 4.4], [-59.0, 5.0, -15, 4.4]],
    build(B) {
      const { ps, W } = B;
      const x0 = -56, x1 = 84;
      const t = {
        p0: [[x0, -1], [-48, -3.5], [70, -3], [x1, -1.8]],
        p1y: [[x0, 0], [-48, -2.2], [70, -1.8], [x1, -1.4]],
        p2w: [[x0, 38], [-35, 41], [0, 37.5], [20, 37], [50, 34.5], [70, 27], [x1, 11]],
        p2y: [[x0, 7], [0, 5], [50, 2.5], [x1, -0.8]],
        p3w: [[x0, 36], [-35, 38.5], [0, 36], [20, 35], [50, 31.5], [70, 23], [x1, 8]],
        p3y: [[x0, 20], [-30, 20], [0, 17], [20, 13.8], [50, 8.6], [70, 4.5], [x1, 0.2]],
        p4w: [[x0, 32], [-36, 33], [-32, 26], [-18, 21], [3, 22], [17, 29], [21, 31], [50, 25], [x1, 4]],
        p4y: [[x0, 21.6], [-36, 21.6], [-32, 23.5], [-18, 27.3], [3, 27.2], [17, 16.6], [21, 14.6], [50, 9.4], [70, 5.3], [x1, 0.6]],
        p5: [[x0, 23.6], [-40, 23.8], [-33, 25], [-18, 29.6], [-6, 29.8], [3, 28.6], [20, 15.6], [50, 10.4], [70, 6], [x1, 0.9]],
      };
      const loft = new Loft({
        section: sectionFn(t, W, 2.6, 1.05), xs: stations(x0, x1, 2, [-36, -34, -32, -19, -18, 2, 3, 18, 19, 20, 21, 80]),
        tension: [0, 0.5, 0.35, 0.65, 0.55, 0.1],
        classify: classifier([
          { seg: 3, x0: -32, x1: 18, slot: 'glass' },
          { seg: 4, x0: 2, x1: 19, slot: 'glass' },
          { seg: 4, x0: -34, x1: -19, slot: 'glass' },
          { seg: 1, x0: -60, x1: -48, slot: 'trim' },
        ]),
        capSlot: 'paint',
      });
      loft.build(ps, 34);
      B.loft = loft;
      // nose arrow stripe + offset racing band (accent)
      loft.patch(ps, 'accent', 20, 82, 0.955, 1.045, 0.2, 30, 2);
      loft.patch(ps, 'accent', -54.5, -34, 0.955, 1.045, 0.2, 10, 2);
      loft.patch(ps, 'accent', -40, 50, 0.47, 0.5, 0.25, 40, 2);
      loft.patch(ps, 'accent', -40, 50, -0.47, -0.5, 0.25, 40, 2);
      // side blade intake behind the door
      surfBox(ps, 'trim', loft, -24, 0.56, 14, 1.6, 4.5, { embed: 0.9, r: 0.6 });
      const [wf, wb] = W;
      fender(ps, 'trim', wf, { rin: 15.6, rout: 16.2, z0: 27, z1: 40.5, a0: 0.05, a1: Math.PI - 0.05, lip: 0.2 });
      fender(ps, 'trim', wb, { rin: 17.1, rout: 17.7, z0: 29, z1: 42, a0: 0.05, a1: Math.PI - 0.05, lip: 0.2 });
      // low rear wing on stalks
      ps.add('accent', extrudeSide([[-57.5, 27.6], [-55, 29.8], [-47, 29.4], [-46, 28.4], [-50, 27.6]], 64, 0.5));
      ps.addMirrored('trim', roundedBox(3, 5, 1.4, 0.5), M(-52, 25.4, 20));
      // wide splitter
      ps.add('trim', extrudeSide([[60, -4.8], [84, -2.6], [84, -1.6], [60, -2.4]], 46, 0.4));
      // lights: thin full-width LED blade at the nose, full-width tail bar
      light(ps, HEAD, 3, 1.1, 12, 75.5, 3.6, 12.5, 0, -0.42, -0.2, 0.45);
      ps.add('light', setColor(roundedBox(1.6, 2.4, 68, 0.6), ...TAIL), M(-56.4, 17.5, 0));
      ps.add('trim', roundedBox(3, 9, 62, 1.2), M(-55.8, 4.5, 0));
      for (const z of [-24, -8, 8, 24]) ps.add('trim', roundedBox(8, 4, 1, 0.3), M(-52, -1, z));
    },
  },
  // =========================================================================
  nomad: {
    hitbox: 'HYBRID', tyre: { wF: 11.0, wB: 13.0, extraF: 6.5, extraB: 6, spokes: 5 },
    nozzles: [[-54.0, 11, 0, 5.2]],
    build(B) {
      const { ps, W } = B;
      const x0 = -52, x1 = 81;
      const t = {
        p0: [[x0, 4], [-44, 0.5], [70, 0.5], [x1, 2.5]],
        p2w: [[x0, 34], [-45, 38], [-30, 40], [-10, 37.5], [10, 34], [30, 29], [45, 27], [62, 27], [72, 24], [x1, 16]],
        p2y: [[x0, 12], [-30, 11], [0, 9.5], [40, 8], [x1, 4]],
        p3w: [[x0, 32], [-45, 36], [-30, 37.5], [-10, 35], [10, 32], [30, 27.5], [60, 25], [72, 21], [x1, 12]],
        p3y: [[x0, 26.5], [-30, 26], [0, 23.5], [24, 20.5], [50, 16], [70, 11.5], [x1, 6.5]],
        p4w: [[x0, 27], [-42, 30], [-38, 27], [-18, 20], [0, 20.5], [20, 25], [24, 26], [50, 21], [x1, 10]],
        p4y: [[x0, 30], [-42, 30.6], [-38, 31.5], [-18, 36.2], [0, 35.6], [20, 22.4], [24, 21], [50, 16.4], [70, 12], [x1, 7.2]],
        p5: [[x0, 31.5], [-42, 32], [-36, 33.5], [-18, 38.6], [-6, 38.8], [2, 37.4], [23, 22.8], [50, 17.6], [70, 12.8], [x1, 8]],
      };
      const loft = new Loft({
        section: sectionFn(t, W, 3.2), xs: stations(x0, x1, 2, [-40, -38, -19, -18, 0, 1, 22, 23, 24, 76]),
        tension: [0, 0.35, 0.15, 0.5, 0.45, 0],
        classify: classifier([
          { seg: 3, x0: -38, x1: 22, slot: 'glass' },
          { seg: 4, x0: 1, x1: 23, slot: 'glass' },
          { seg: 4, x0: -40, x1: -19, slot: 'glass' },
          { seg: [1, 2], x0: 76, x1: 84, slot: 'trim' },
          { seg: 1, x0: -60, x1: -46, slot: 'trim' },
        ]),
        capSlot: 'paint',
      });
      loft.build(ps, 38);
      B.loft = loft;
      // diagonal shoulder accent sweeping from the door to the rear haunch + roof spine
      loft.patch(ps, 'accent', -46, 20, 0.55, 0.62, 0.25, 28, 2);
      loft.patch(ps, 'accent', -46, 20, -0.55, -0.62, 0.25, 28, 2);
      loft.patch(ps, 'accent', -50, 0, 0.95, 1.05, 0.2, 20, 2);
      const [wf, wb] = W;
      // separate front pods (Hybrid class: exposed front wheels)
      fender(ps, 'paint', wf, { rin: 15.6, rout: 18.4, z0: 25, z1: 40.5, a0: -0.35, a1: Math.PI + 0.05, segs: 18 });
      fender(ps, 'trim', wf, { rin: 15.2, rout: 15.7, z0: 25.5, z1: 40, a0: -0.35, a1: Math.PI + 0.05, lip: 0.2 });
      fender(ps, 'trim', wb, { rin: 18.0, rout: 18.6, z0: 29, z1: 42, a0: 0.05, a1: Math.PI - 0.05, lip: 0.2 });
      // integrated rear spoiler lip (accent)
      ps.add('accent', extrudeSide([[-53.4, 30.8], [-54.2, 35.4], [-49, 34.8], [-42, 32.6]], 60, 0.5));
      // splitter, side intake ahead of rear wheel
      ps.add('trim', roundedBox(9, 2.6, 44, 1), M(78, 1.2, 0));
      ps.addMirrored('trim', roundedBox(11, 6, 2, 1), M(-12, 16, 35.4, 0, 0.15, 0));
      // lights: slanted slit headlights, C-shaped tails
      ps.add('trim', roundedBox(2.2, 3.4, 16, 1), M(81, 4.6, 0));
      light(ps, HEAD, 1.8, 2.2, 7, 81.0, 6.4, 9.5, 0, 0, 0, 0.8);
      surfBox(ps, 'light', loft, 73.5, 0.63, 10, 1.2, 2.2, { embed: 0.5, r: 0.5, color: DRL, yaw: 0.12 });
      light(ps, TAIL, 2, 3.2, 15, -52.2, 25.2, 20, 0, 0, 0, 1.0);
      light(ps, TAIL, 2, 9, 2.6, -52.1, 19.5, 28.5, 0, 0, 0, 0.9);
    },
  },
  // =========================================================================
  bulwark: {
    hitbox: 'MERC', tyre: { wF: 13.0, wB: 13.0, extraF: 6, extraB: 3, spokes: 6 },
    nozzles: [[-53.0, 7, 23, 4.6], [-53.0, 7, -23, 4.6]],
    build(B) {
      const { ps, W } = B;
      const x0 = -51, x1 = 75;
      const t = {
        p0: [[x0, 1.5], [-48, -1.5], [70, -1.5], [x1, 1]],
        p1w: [[x0, 31], [x1, 30]],
        p1y: [[x0, 2], [-48, -0.5], [70, -0.5], [x1, 1.5]],
        p2w: [[x0, 35], [-46, 36.5], [60, 36.5], [x1, 34.5]],
        p2y: [[x0, 12], [x1, 12]],
        p3w: [[x0, 34], [-46, 35.5], [52, 35.5], [x1, 33]],
        p3y: [[x0, 28], [-46, 28.5], [52, 28.5], [70, 27], [x1, 25]],
        p4w: [[x0, 30.5], [-46, 32], [40, 31.5], [46, 32], [52, 32.5], [x1, 30]],
        p4y: [[x0, 46], [-46, 48.2], [36, 48.2], [42, 46], [51, 29.2], [52, 28.9], [x1, 25.6]],
        p5: [[x0, 47.5], [-46, 50], [36, 50], [42, 48], [51, 29.6], [x1, 26.4]],
      };
      const loft = new Loft({
        section: sectionFn(t, W, 3.4, 1.15), xs: stations(x0, x1, 2, [-46, -44, 4, 9, 37, 38, 41, 42, 50, 51, 52, 70]),
        tension: [0, 0.75, 0.6, 0.8, 0.8, 0],
        classify: classifier([
          { seg: 3, x0: -44, x1: 4, slot: 'glass' },
          { seg: 3, x0: 9, x1: 38, slot: 'glass' },
          { seg: 4, x0: 41, x1: 50, slot: 'glass' },
          { seg: [1, 2], x0: 70, x1: 80, slot: 'trim' },
          { seg: 1, x0: -60, x1: 80, slot: 'trim' },        // rugged lower cladding
        ]),
        capSlot: (dir) => (dir > 0 ? 'trim' : 'paint'),
      });
      loft.build(ps, 34);
      B.loft = loft;
      // accent: bonnet panel + belt stripe
      loft.patch(ps, 'accent', 53, 73, 0.72, 1.28, 0.3, 8, 10);
      loft.patch(ps, 'accent', -49, 38, 0.6, 0.66, 0.25, 30, 2);
      loft.patch(ps, 'accent', -49, 38, -0.6, -0.66, 0.25, 30, 2);
      const [wf, wb] = W;
      // boxy fender flares (polygonal arcs)
      fender(ps, 'trim', wf, { rin: 18.0, rout: 21.0, z0: 30, z1: 40.0, a0: -0.05, a1: Math.PI + 0.05, segs: 5, lip: 0.8 });
      fender(ps, 'trim', wb, { rin: 18.0, rout: 21.0, z0: 30, z1: 40.5, a0: -0.05, a1: Math.PI + 0.05, segs: 5, lip: 0.8 });
      // bull bar
      ps.add('chrome', roundedBox(2.2, 2.2, 60, 1), M(79, 6, 0));
      ps.add('chrome', roundedBox(2.2, 2.2, 44, 1), M(79, 16, 0));
      ps.addMirrored('chrome', roundedBox(2.2, 18, 2.2, 1), M(79, 9, 18));
      ps.addMirrored('chrome', roundedBox(6, 2, 2, 0.8), M(76.5, 6, 18));
      // roof rack + light bar
      ps.addMirrored('trim', roundedBox(70, 1.8, 1.8, 0.7), M(-6, 52.2, 25));
      for (const x of [-36, -14, 8, 28]) ps.add('trim', roundedBox(2, 1.6, 52, 0.6), M(x, 52.4, 0));
      ps.add('trim', roundedBox(4, 4, 46, 1.2), M(34, 53.4, 0));
      ps.add('light', setColor(roundedBox(1.2, 2.6, 40, 0.5), ...DRL), M(36.2, 53.4, 0));
      // spare wheel on the tailgate
      const sp = getWheelGeometries(1, 6).tyre.clone(); sp.scale(15, 15, 7);
      ps.add('trim', sp, M(-53.5, 27, 0, 0, Math.PI / 2, 0));
      ps.add('accent', latheX([[0.3, 8], [-0.5, 9.4], [-2, 9.4], [-2.4, 0.5]], 20), M(-56.5, 27, 0));
      // lights: square headlamps, vertical tails
      light(ps, HEAD, 1.6, 6, 7, 75.2, 17.6, 25, 0, 0, 0, 1.2);
      light(ps, AMBER, 1.4, 2, 4, 75.3, 11.6, 27.5, 0, 0, 0, 0.6);
      light(ps, TAIL, 1.4, 14, 3, -51.2, 30, 31, 0, 0, 0, 0.6);
      // grille slats
      for (const y of [12, 15.5, 19]) ps.add('chrome', roundedBox(1, 1.2, 30, 0.4), M(75.6, y, 0));
    },
  },
};

const cache = new Map();

export function bodySpec(bodyId) {
  return BODY_SPECS[bodyId] ? bodyId : (CAR_BODIES.find((b) => b.hitbox === bodyId) || CAR_BODIES[0]).id;
}

// Bodies modelled in Blender (tools/blender/*.py) ship as compact quantised meshes; decode into
// per-slot non-indexed geometries in uu, car model axes (+X fwd, +Y up, +Z right).
const MODELLED = { vector: [VECTOR_MESH_META, VECTOR_MESH_B64] };
function addModelled(ps, meta, b64) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
  const q = 1 / meta.q;
  for (const part of meta.parts) {
    const { nv, ni, off, wide, slot } = part;
    let o = off;
    const P = new Int16Array(bin, o, nv * 3); o += nv * 6;
    const N = new Int8Array(bin, o, nv * 3); o += nv * 3;
    const C = new Uint8Array(bin, o, nv); o += nv;
    o = (o + 3) & ~3;
    const I = wide ? new Uint32Array(bin, o, ni) : new Uint16Array(bin, o, ni);
    const pos = new Float32Array(ni * 3), nrm = new Float32Array(ni * 3), col = new Float32Array(ni * 3);
    for (let k = 0; k < ni; k++) {
      const v = I[k];
      // Blender (x, y left, z up) -> model (x, z, -y)
      pos[k * 3] = P[v * 3] * q; pos[k * 3 + 1] = P[v * 3 + 2] * q; pos[k * 3 + 2] = -P[v * 3 + 1] * q;
      let nx = N[v * 3], ny = N[v * 3 + 2], nz = -N[v * 3 + 1];
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm[k * 3] = nx / l; nrm[k * 3 + 1] = ny / l; nrm[k * 3 + 2] = nz / l;
      const c = meta.palette[C[v]];
      col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    if (slot === 'light' || slot === 'chrome') g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    ps.add(slot, g);
  }
}

export function buildBody(bodyId) {
  const id = bodySpec(bodyId);
  if (cache.has(id)) return cache.get(id);
  const spec = BODY_SPECS[id];
  const ps = new PartSet();
  const W = restWheels(spec.hitbox, spec.tyre.extraF, spec.tyre.extraB);
  const B = { ps, W, spec };
  const noModel = typeof location !== 'undefined' && /[?&]procedural=1/.test(location.search);
  if (MODELLED[id] && !noModel) addModelled(ps, ...MODELLED[id]);
  else spec.build(B);
  for (const [x, y, z, r] of spec.nozzles) nozzle(ps, x, y, z, r, 6);
  const geoms = ps.build(0.01);
  const res = {
    id, hitbox: spec.hitbox, geoms, tyre: spec.tyre,
    nozzles: spec.nozzles.map(([x, y, z]) => new THREE.Vector3(x / 100, y / 100, z / 100)),
    nozzleRadius: spec.nozzles.map((n) => n[3] / 100),
  };
  cache.set(id, res);
  return res;
}

export function bodyIds() { return Object.keys(BODY_SPECS); }
export { clamp };
