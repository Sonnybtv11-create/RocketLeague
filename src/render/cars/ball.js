// TURBO PITCH — the ball (car agent).
// The ball is the Blender model in tools/blender/models/ball.blend (tools/blender/import_ball.py ->
// ballMesh.js): a gunmetal honeycomb core under armoured hubs, oval scale panels and glowing lenses.
// The core's hex holes are redrawn per pixel from its UVs (see HONEYCOMB below). ?procedural=1 shows
// the earlier code-built ball: 42 panels (12 dark pentagonal "cores" with a glowing inset ring +
// 30 light hexagonal plates) computed per-pixel from a geodesic set of panel centres (spherical
// Voronoi), with dark grooves between panels. Emissive accents are tinted by the half of the
// pitch the ball is in (blue / neutral / orange). A touch (large velocity change near a car)
// fires a short emissive flash scaled by the hit strength.
// The blob shadow is a soft decal straight below the ball on whatever surface is there
// (arena raycast), oriented to the surface normal and conformed to curved ramps. It grows a
// little and fades slightly with height but always stays clearly visible.
import * as THREE from 'three';
import { BALL_RADIUS, TEAM_COLORS } from '../../contracts.js';
import { applySimTransform } from '../util.js';
import { syncEnvironment, registerEnvUser } from './materials.js';
import { BALL_MESH_META, BALL_MESH_B64 } from './ballMesh.js';
import { decodeMesh } from '../meshpack.js';

const R_M = BALL_RADIUS / 100;

// 42 panel centres: icosahedron vertices (12, pentagons) + edge midpoints (30, hexagons)
function panelCentres() {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((p) => new THREE.Vector3(...p).normalize());
  const out = v.slice();
  const minD = v[0].distanceTo(v[1]) * 1.01;
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
    if (v[i].distanceTo(v[j]) < minD) out.push(v[i].clone().add(v[j]).normalize());
  }
  return out; // 12 + 30
}

// Honeycomb core: the model's honeycomb texture (3060 x 1820 px) is a triangular lattice of flat-topped
// hexagonal holes, pitch 24.65 px, apothem 10.3 px; holes are recessed ~0.6 uu (displacement) and
// darker. Redrawn here in texture-pixel space with a bump, fading to the average tone once a cell
// gets smaller than a few screen pixels.
const HONEYCOMB = `
float hcHole; float hcAA;
void honeycomb(vec2 uv) {
  vec2 p = uv * vec2(3060.0, 1820.0);
  const float P = 24.65;
  vec2 s = vec2(P, P * 1.7320508);
  vec2 a = mod(p, s) - 0.5 * s;
  vec2 b = mod(p - 0.5 * s, s) - 0.5 * s;
  vec2 q = dot(a, a) < dot(b, b) ? a : b;
  q = abs(q);
  float d = max(q.y, 0.8660254 * q.x + 0.5 * q.y) - 10.3;   // < 0 inside a hole
  float fw = fwidth(d);
  hcAA = smoothstep(2.5, 6.0, fw);                          // 1 = cells below pixel size
  hcHole = mix(1.0 - smoothstep(-0.75 * fw, 0.75 * fw, d), 0.69, hcAA);
}`;

function buildModelBall(glow) { // glow: the live pitch-half colour (THREE.Color, updated by the caller)
  const geo = decodeMesh(BALL_MESH_META, BALL_MESH_B64, { scale: 1 / 100 }); // uu -> metres, Blender axes
  const group = new THREE.Group();
  const core = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.7, roughness: 0.42, envMapIntensity: 1.0, name: 'ball.core' });
  core.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + HONEYCOMB)
      .replace('#include <color_fragment>', `#include <color_fragment>
honeycomb(vUv);
diffuseColor.rgb = mix(vec3(0.13, 0.135, 0.145), vec3(0.03, 0.032, 0.036), hcHole);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // bump from the hole edges: height falls 0.6 cm into each hole
  float h = -0.0059 * hcHole * (1.0 - hcAA);
  vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  normal = normalize(abs(det) * normal - grad);
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.6, hcHole * 0.6);`);
    sh.vertexShader = sh.vertexShader.replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nvarying vec2 vUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvUv = uv;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <uv_pars_fragment>', '#include <uv_pars_fragment>\nvarying vec2 vUv;');
  };
  core.customProgramCacheKey = () => 'turbo-ball-core-v1';
  const shell = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.5, roughness: 0.36, clearcoat: 0.3, clearcoatRoughness: 0.3, envMapIntensity: 1.0, name: 'ball.shell' });
  const print = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.92, 0.93, 0.94, THREE.LinearSRGBColorSpace), roughness: 0.4, metalness: 0, name: 'ball.print' });
  const lights = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, name: 'ball.lights' });
  const mats = { core, shell, print, glow: lights };
  for (const m of [core, shell, print]) registerEnvUser(m);
  for (const [slot, g] of Object.entries(geo)) {
    const m = new THREE.Mesh(g, mats[slot] || shell);
    m.name = 'ball.' + slot;
    m.castShadow = false; m.receiveShadow = slot !== 'glow';
    group.add(m);
  }
  return {
    object: group,
    // lenses glow in the pitch-half colour (bright, for bloom) and everything lifts on a touch
    update(f) {
      lights.color.copy(glow).multiplyScalar(2.2 + f * 3);
      for (const m of [core, shell, print]) m.emissive.setScalar(f * 0.35);
    },
    dispose() { for (const g of Object.values(geo)) g.dispose(); for (const m of Object.values(mats)) m.dispose(); },
  };
}

export function createBallModel(ctx) {
  const group = new THREE.Group();
  group.name = 'ball';
  const centres = panelCentres();
  const uniforms = {
    uCentres: { value: centres },
    uGlow: { value: new THREE.Color(1, 1, 1) },
    uFlash: { value: 0 },
  };
  const procedural = typeof location !== 'undefined' && /[?&]procedural=1/.test(location.search);
  let ball, model = null, legacyDispose = null;
  if (!procedural) {
    model = buildModelBall(uniforms.uGlow.value);
    ball = model.object;
  } else {
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.34, metalness: 0.12, clearcoat: 0.7, clearcoatRoughness: 0.18,
      emissive: 0xffffff, envMapIntensity: 1.0, name: 'ball',
    });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBallDir;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBallDir = normalize(position);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
  varying vec3 vBallDir;
  uniform vec3 uCentres[42];
  uniform vec3 uGlow;
  uniform float uFlash;
  float gPanelEdge; float gPent; float gRing; float gHash; float gCore;
  void ballPanels() {
    vec3 d = normalize(vBallDir);
    float d1 = -2.0, d2 = -2.0; int id = 0;
    for (int i = 0; i < 42; i++) {
      float k = dot(d, uCentres[i]);
      if (k > d1) { d2 = d1; d1 = k; id = i; } else if (k > d2) { d2 = k; }
    }
    // e ~ angular distance to the nearest panel border
    float e = (d1 - d2) / max(1e-4, sqrt(max(0.0, 1.0 - d1 * d1)) + 0.35);
    float fw = fwidth(e) * 1.2 + 1e-4;
    gPanelEdge = 1.0 - smoothstep(0.010, 0.010 + fw, e);           // groove between panels
    gPent = id < 12 ? 1.0 : 0.0;
    float ang = acos(clamp(d1, -1.0, 1.0));                          // angle from the panel centre
    float fa = fwidth(ang) * 1.2 + 1e-4;
    gCore = gPent * (1.0 - smoothstep(0.115, 0.115 + fa, ang));      // dark core disc on the 12 pentagons
    gRing = gPent * (smoothstep(0.128 - fa, 0.128, ang) - smoothstep(0.158, 0.158 + fa, ang)); // glowing ring
    gHash = fract(sin(float(id) * 12.9898) * 43758.5453);
  }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
  ballPanels();
  vec3 panelCol = mix(vec3(0.82, 0.84, 0.88), vec3(0.72, 0.75, 0.8), step(0.55, gHash));
  panelCol = mix(panelCol, vec3(0.13, 0.14, 0.17), gCore);
  panelCol = mix(panelCol, vec3(0.9), gRing);
  diffuseColor.rgb = mix(panelCol, vec3(0.05, 0.055, 0.065), gPanelEdge);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.75, gPanelEdge);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance = uGlow * (gRing * 2.6 + gCore * 0.12) + vec3(1.0, 0.97, 0.9) * uFlash * (1.0 - gPanelEdge * 0.7) * 0.9;`);
    };
    mat.customProgramCacheKey = () => 'turbo-ball-v1';
    registerEnvUser(mat);
    ball = new THREE.Mesh(new THREE.SphereGeometry(R_M, 64, 40), mat);
    ball.castShadow = false; // the blob decal below is THE landing cue; a sun-shadow blob would be ambiguous
    ball.receiveShadow = true;
    legacyDispose = () => { ball.geometry.dispose(); mat.dispose(); };
  }
  ball.name = 'ball.model';
  group.add(ball);

  // ------------------------------------------------------------------ shadow decal
  const RINGS = [0, 0.45, 0.72, 0.9, 1.08, 1.3];
  const ALPHA = [1, 0.97, 0.85, 0.6, 0.22, 0];
  const SEG = 28;
  const nV = 1 + (RINGS.length - 1) * SEG;
  const base = new Float32Array(nV * 2); // unit-disc template (u, v)
  const pos = new Float32Array(nV * 3), col = new Float32Array(nV * 4);
  const idx = [];
  let vi = 1;
  base[0] = 0; base[1] = 0; col.set([0, 0, 0, 1], 0);
  for (let r = 1; r < RINGS.length; r++) {
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      base[vi * 2] = Math.cos(a) * RINGS[r]; base[vi * 2 + 1] = Math.sin(a) * RINGS[r];
      col.set([0, 0, 0, ALPHA[r]], vi * 4);
      vi++;
    }
  }
  for (let s = 0; s < SEG; s++) idx.push(0, 1 + s, 1 + (s + 1) % SEG);
  for (let r = 1; r < RINGS.length - 1; r++) {
    const a0 = 1 + (r - 1) * SEG, b0 = 1 + r * SEG;
    for (let s = 0; s < SEG; s++) {
      const s2 = (s + 1) % SEG;
      idx.push(a0 + s, b0 + s, b0 + s2, a0 + s, b0 + s2, a0 + s2);
    }
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  sg.setAttribute('color', new THREE.BufferAttribute(col, 4));
  sg.setIndex(idx);
  const smat = new THREE.MeshBasicMaterial({
    color: 0x000000, vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.FrontSide, toneMapped: false, fog: false,
    name: 'ball.shadow',
  });
  smat.forceSinglePass = true;
  const shadow = new THREE.Mesh(sg, smat);
  shadow.frustumCulled = false;
  shadow.renderOrder = 2;
  group.add(shadow);

  // ------------------------------------------------------------------ state / temporaries
  const nrm = { x: 0, y: 0, z: 1 };
  const N = new THREE.Vector3(), T = new THREE.Vector3(), Bt = new THREE.Vector3(), H = new THREE.Vector3();
  const prevVel = new THREE.Vector3(), prevPos = new THREE.Vector3();
  let havePrev = false, flash = 0;
  const blue = new THREE.Color(TEAM_COLORS[0].glow), orange = new THREE.Color(TEAM_COLORS[1].glow);
  // neutral glow: the model's cyan lens colour (old ball: cool white)
  const white = procedural ? new THREE.Color(0.85, 0.92, 1.0) : new THREE.Color().setRGB(0.55, 0.9, 1.0, THREE.LinearSRGBColorSpace);
  const glow = uniforms.uGlow.value;
  const LIFT = 1.2; // uu above the surface
  const raycast = ctx.arena && ctx.arena.raycast;
  const nrmTmp = { x: 0, y: 0, z: 1 };

  function placeShadow(bp) {
    if (!raycast) return false;
    const maxLen = 4000;
    const t = raycast(bp.x, bp.y, bp.z, 0, 0, -1, maxLen, nrm);
    if (t < 0) return false;
    const hx = bp.x, hy = bp.y, hz = bp.z - t;          // hit point (sim)
    const height = Math.max(0, t - BALL_RADIUS);
    // size & opacity vs height: grows ~35% and fades to ~60% by ceiling height, never vanishes
    const k = Math.min(1, height / 1900);
    // stays >= 0.78 opacity at any height (critical gameplay cue)
    const radius = BALL_RADIUS * (0.92 + 0.38 * k);
    smat.opacity = 0.9 - 0.12 * k;
    // basis in three space: N = surface normal
    N.set(nrm.x, nrm.z, nrm.y).normalize();
    T.set(1, 0, 0); if (Math.abs(N.x) > 0.9) T.set(0, 0, 1);
    T.addScaledVector(N, -T.dot(N)).normalize();
    Bt.crossVectors(N, T);
    H.set(hx / 100, hz / 100, hy / 100);
    const flat = nrm.z > 0.999;
    for (let i = 0; i < nV; i++) {
      const u = base[i * 2] * radius, v = base[i * 2 + 1] * radius; // uu in the tangent plane
      let px = H.x * 100 + (T.x * u + Bt.x * v), py = H.y * 100 + (T.y * u + Bt.y * v), pz = H.z * 100 + (T.z * u + Bt.z * v); // three axes, uu
      let lift = LIFT;
      if (!flat) {
        // conform to curved surfaces: re-cast along -N from above the tangent-plane point (sim axes)
        const sx = px + N.x * 60, sy = pz + N.z * 60, sz = py + N.y * 60;
        const tt = raycast(sx, sy, sz, -N.x, -N.z, -N.y, 160, nrmTmp);
        if (tt >= 0) lift = LIFT + (60 - tt);
        else lift = LIFT;
      }
      px += N.x * lift; py += N.y * lift; pz += N.z * lift;
      pos[i * 3] = px / 100; pos[i * 3 + 1] = py / 100; pos[i * 3 + 2] = pz / 100;
    }
    sg.attributes.position.needsUpdate = true;
    return true;
  }

  // dev hook (?cardebug=1) used by the automated checks
  const dbg = typeof location !== 'undefined' && location.search.includes('cardebug') ? { peakFlash: 0, flash: 0, shadow } : null;
  if (dbg) (window.__carsDebug || (window.__carsDebug = { ctx, models: [] })).ball = dbg;

  return {
    object3d: group,
    update(bv, dt = 1 / 60, view) {
      syncEnvironment(ctx);
      const hidden = !!(view && view.match && view.match.ballHidden);
      group.visible = !hidden;
      if (hidden || !bv) { havePrev = false; return; }
      applySimTransform(ball, bv.pos, bv.rot);
      // --- touch flash: big velocity change with a car close by (decay first so a new hit shows at full strength)
      flash *= Math.exp(-Math.min(dt, 0.05) * 7);
      if (flash < 0.01) flash = 0;
      if (havePrev && prevPos.distanceTo(bv.pos) < 600) {
        const dvx = bv.vel.x - prevVel.x, dvy = bv.vel.y - prevVel.y, dvz = bv.vel.z - prevVel.z;
        const dv = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
        if (dv > 260 && view && view.cars) {
          let near = false;
          for (const c of view.cars) {
            if (c.isDemoed) continue;
            const dx = c.pos.x - bv.pos.x, dy = c.pos.y - bv.pos.y, dz = c.pos.z - bv.pos.z;
            if (dx * dx + dy * dy + dz * dz < 260 * 260) { near = true; break; }
          }
          if (near) flash = Math.max(flash, Math.min(1, 0.35 + dv / 2600));
        }
      }
      prevVel.set(bv.vel.x, bv.vel.y, bv.vel.z); prevPos.set(bv.pos.x, bv.pos.y, bv.pos.z); havePrev = true;
      uniforms.uFlash.value = flash;

      if (dbg) { dbg.peakFlash = Math.max(dbg.peakFlash, flash); dbg.flash = flash; }
      // --- accent glow tint by pitch half (sim +Y = orange half)
      const wO = THREE.MathUtils.smoothstep(bv.pos.y, 150, 1400), wB = THREE.MathUtils.smoothstep(-bv.pos.y, 150, 1400);
      const wW = 1 - wO - wB;
      glow.setRGB(white.r * wW + blue.r * wB + orange.r * wO, white.g * wW + blue.g * wB + orange.g * wO, white.b * wW + blue.b * wB + orange.b * wO);
      if (model) model.update(flash);
      // --- shadow
      shadow.visible = placeShadow(bv.pos);
    },
    dispose() {
      if (model) model.dispose(); else legacyDispose();
      sg.dispose(); smat.dispose();
    },
  };
}
