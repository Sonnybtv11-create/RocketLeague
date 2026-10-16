// TURBO PITCH — car/ball materials (car agent).
// Paint is cached per team, accent per colour; everything else is shared by all cars.
// A small procedural "stadium" environment map is generated once (PMREM) and used as the
// cars' reflection source ONLY while the scene has no environment of its own — as soon as
// the environment module sets scene.environment, materials fall back to it automatically.
import * as THREE from 'three';
import { TEAM_COLORS } from '../../contracts.js';

// Game-style car shading on top of PBR: baked height/cavity occlusion (lower body and underside
// darker, so the car reads as solid rather than evenly lit) and, for paint, "flop" — the colour
// deepens towards grazing angles like real metallic paint.
function carShading(m, { flop = 0, ao = 0.5 } = {}) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCarY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarY = position.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCarY;')
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        float occ = mix(${(1 - ao).toFixed(3)}, 1.0, smoothstep(-0.06, 0.24, vCarY));
        diffuseColor.rgb *= occ;
        ${flop > 0 ? `float ndv = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
        diffuseColor.rgb *= mix(${(1 - flop).toFixed(3)}, 1.0, pow(ndv, 0.55));` : ''}
      }`);
  };
  m.customProgramCacheKey = () => `carshade:${flop}:${ao}`;
  return m;
}

let shared = null;       // shared materials
const paintCache = new Map();
const accentCache = new Map();
let fallbackEnv = null;  // PMREM texture
let envUsers = new Set();
let envState = null;     // 'fallback' | 'scene'

export function getSharedMaterials() {
  if (shared) return shared;
  shared = {
    trim: carShading(new THREE.MeshPhysicalMaterial({ color: 0x25282e, roughness: 0.42, metalness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.3, name: 'car.trim' }), { ao: 0.45 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x080b12, roughness: 0.16, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.16, envMapIntensity: 1.0, name: 'car.glass' }),
    // instanced depth material for the tyres' shadow pass (keeps the instanced shadow program separate)
    tyreDepth: new THREE.MeshDepthMaterial({ name: 'car.tyre.depth' }),
    light: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, name: 'car.lights' }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xc4c8d0, roughness: 0.18, metalness: 1.0, name: 'car.chrome' }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x151619, roughness: 0.72, metalness: 0.0, name: 'car.tyre' }),
    rim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.85, name: 'car.rim' }),
  };
  for (const m of Object.values(shared)) if (!m.isMeshDepthMaterial && !m.isMeshBasicMaterial) envUsers.add(m);
  return shared;
}

export function getPaint(team) {
  let m = paintCache.get(team);
  if (!m) {
    const tc = TEAM_COLORS[team] || TEAM_COLORS[0];
    m = carShading(new THREE.MeshPhysicalMaterial({
      color: tc.primary, roughness: 0.3, metalness: 0.45,
      clearcoat: 1.0, clearcoatRoughness: 0.04, envMapIntensity: 1.55, name: 'car.paint.' + team,
    }), { flop: 0.5, ao: 0.5 });
    paintCache.set(team, m); envUsers.add(m);
  }
  return m;
}

export function getAccent(hex) {
  const key = (hex || '#e8e8e8').toLowerCase();
  let m = accentCache.get(key);
  if (!m) {
    m = carShading(new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(key), roughness: 0.3, metalness: 0.35,
      clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 1.3, name: 'car.accent.' + key,
    }), { flop: 0.4, ao: 0.45 });
    accentCache.set(key, m); envUsers.add(m);
  }
  return m;
}

export function registerEnvUser(m) { envUsers.add(m); if (envState === 'fallback' && fallbackEnv) { m.envMap = fallbackEnv; m.needsUpdate = true; } }

// Procedural stadium-ish environment: dark night sky gradient, a ring of floodlight banks,
// lit stands and a green pitch below. Used only until the scene supplies scene.environment.
function buildFallbackEnv(renderer) {
  const scene = new THREE.Scene();
  const skyGeo = new THREE.SphereGeometry(50, 32, 16);
  const cols = [];
  const p = skyGeo.attributes.position;
  const top = new THREE.Color(0x0b1430), hor = new THREE.Color(0x3a4a6e), stand = new THREE.Color(0x1a1d26), pitch = new THREE.Color(0x1f5a28);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 50;
    if (y > 0.25) c.copy(hor).lerp(top, Math.min(1, (y - 0.25) / 0.6));
    else if (y > -0.05) c.copy(stand).lerp(hor, (y + 0.05) / 0.3);
    else c.copy(pitch).multiplyScalar(0.8 + 0.2 * Math.min(1, -y * 3));
    cols.push(c.r, c.g, c.b);
  }
  skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  scene.add(new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  // floodlight banks
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 5.6) });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.2), lampMat);
    m.position.set(Math.cos(a) * 40, 22, Math.sin(a) * 40);
    m.lookAt(0, 0, 0);
    scene.add(m);
  }
  // soft overhead panel
  const pan = new THREE.Mesh(new THREE.PlaneGeometry(40, 18), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 1.25, 1.4) }));
  pan.position.set(0, 45, 0); pan.rotation.x = Math.PI / 2; scene.add(pan);
  // stand glow bands (team colours left/right)
  for (const [z, col] of [[38, 0x2a5cff], [-38, 0xff7a1a]]) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(60, 1.5), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(1.5) }));
    b.position.set(0, 4, z); b.lookAt(0, 4, 0); scene.add(b);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.02);
  pm.dispose();
  scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return rt.texture;
}

// Called every frame by car/ball models (cheap): switches reflection source if needed.
export function syncEnvironment(ctx) {
  const want = ctx.scene && ctx.scene.environment ? 'scene' : 'fallback';
  if (want === envState) return;
  if (want === 'fallback' && !fallbackEnv) {
    try { fallbackEnv = buildFallbackEnv(ctx.renderer); } catch (e) { fallbackEnv = null; }
  }
  envState = want;
  for (const m of envUsers) { m.envMap = want === 'fallback' ? fallbackEnv : null; m.needsUpdate = true; }
}
