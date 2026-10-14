// TURBO PITCH — car/ball materials (car agent).
// Paint is cached per team, accent per colour; everything else is shared by all cars.
// A small procedural "stadium" environment map is generated once (PMREM) and used as the
// cars' reflection source ONLY while the scene has no environment of its own — as soon as
// the environment module sets scene.environment, materials fall back to it automatically.
import * as THREE from 'three';
import { TEAM_COLORS } from '../../contracts.js';

let shared = null;       // shared materials
const paintCache = new Map();
const accentCache = new Map();
let fallbackEnv = null;  // PMREM texture
let envUsers = new Set();
let envState = null;     // 'fallback' | 'scene'

export function getSharedMaterials() {
  if (shared) return shared;
  shared = {
    trim: new THREE.MeshStandardMaterial({ color: 0x17191e, roughness: 0.55, metalness: 0.35, name: 'car.trim' }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x080b12, roughness: 0.04, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6, name: 'car.glass' }),
    light: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, name: 'car.lights' }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xc4c8d0, roughness: 0.18, metalness: 1.0, name: 'car.chrome' }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.88, metalness: 0.0, name: 'car.tyre' }),
    rim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.85, name: 'car.rim' }),
  };
  for (const m of Object.values(shared)) envUsers.add(m);
  return shared;
}

export function getPaint(team) {
  let m = paintCache.get(team);
  if (!m) {
    const tc = TEAM_COLORS[team] || TEAM_COLORS[0];
    m = new THREE.MeshPhysicalMaterial({
      color: tc.primary, roughness: 0.34, metalness: 0.12,
      clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 1.1, name: 'car.paint.' + team,
    });
    paintCache.set(team, m); envUsers.add(m);
  }
  return m;
}

export function getAccent(hex) {
  const key = (hex || '#e8e8e8').toLowerCase();
  let m = accentCache.get(key);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(key), roughness: 0.3, metalness: 0.2,
      clearcoat: 1.0, clearcoatRoughness: 0.06, envMapIntensity: 1.0, name: 'car.accent.' + key,
    });
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
