// Boost pads, instanced. The pedestals are modelled in Blender (tools/blender/arena_assets.py ->
// arenaAssets.js): big pads are a stepped metal ring with vents, a raised collar around a glowing
// well and three lamp lobes, with licking flames and a floating golden orb on top; small pads are a
// bevelled disc with a glowing puck and ring. Empty pads (isActive false): dim glow, no orb, no flames.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { decodeMesh } from '../meshpack.js';
import { BIG_PAD_META, BIG_PAD_B64, SMALL_PAD_META, SMALL_PAD_B64 } from './arenaAssets.js';

const S = 0.01;
const FULL = new THREE.Color(1.0, 0.5, 0.04).multiplyScalar(1.5);
const EMPTY = new THREE.Color(0.06, 0.045, 0.035);
const SMALL_FULL = new THREE.Color(1.0, 0.52, 0.04).multiplyScalar(1.5);

const FLAME_VERT = /* glsl */`
varying vec2 vUv;
varying float vH;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec3 p = position;
  vH = uv.y;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const FLAME_FRAG = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying float vH;
#include <fog_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
void main() {
  float a = vUv.x * 12.0;
  float n = noise(vec2(a, vUv.y * 3.0 - uTime * 2.6)) * 0.65 + noise(vec2(a * 2.3, vUv.y * 6.0 - uTime * 4.1)) * 0.35;
  float tongue = smoothstep(0.12, 0.0, vUv.y - n * 0.8);
  float base = 1.0 - vUv.y;
  float alpha = tongue * base * (0.4 + 0.6 * base) * 1.1;
  if (alpha < 0.01) discard;
  vec3 col = mix(vec3(1.0, 0.18, 0.0), vec3(1.0, 0.55, 0.05), base * base) * 1.15;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const ORB_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_vertex>
void main() {
  vP = position;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vV = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const ORB_FRAG = /* glsl */`
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_fragment>
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise(vec3 p) { vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), u.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), u.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), u.x), u.y), u.z); }
void main() {
  vec3 n = normalize(vN), v = normalize(vV);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 2.0);
  vec3 q = normalize(vP) * 2.2 + vec3(0.0, uTime * 0.6, uTime * 0.25);
  float sw = noise(q) * 0.6 + noise(q * 2.1) * 0.4;
  vec3 core = mix(vec3(0.75, 0.2, 0.0), vec3(1.0, 0.62, 0.06), smoothstep(0.3, 0.7, sw));
  vec3 col = core * (0.75 + 0.6 * sw) + vec3(1.0, 0.7, 0.15) * fres * 1.3;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// modelled pedestal: every lit slot (metal / dark) merged into one vertex-coloured base, glow apart
function padGeometries(meta, b64) {
  const g = decodeMesh(meta, b64, { scale: S });
  const lit = Object.keys(g).filter((k) => k !== 'glow').map((k) => g[k]);
  const base = mergeGeometries(lit, false);
  for (const x of lit) x.dispose();
  return { base, glow: g.glow };
}
function flameGeometry() {
  // open cone, uv.x around, uv.y up
  const g = new THREE.CylinderGeometry(0.35, 0.75, 1.0, 24, 4, true);
  g.translate(0, 0.5 + 0.1, 0);
  return g;
}

export function createPads(ctx) {
  const group = new THREE.Group();
  group.name = 'boostPads';
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.7, roughness: 0.38 });
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true });
  const flameMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, fog: true,
  });
  const orbMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: ORB_VERT, fragmentShader: ORB_FRAG, fog: true,
  });

  let meshes = null;
  let pads = null;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);

  function build(viewPads) {
    const big = viewPads.filter((p) => p.isBig), small = viewPads.filter((p) => !p.isBig);
    const mk = (geo, mat, n, shadow) => {
      const m = new THREE.InstancedMesh(geo, mat, Math.max(n, 1));
      m.count = n; m.frustumCulled = false; m.receiveShadow = !!shadow; m.castShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(m);
      return m;
    };
    const bigG = padGeometries(BIG_PAD_META, BIG_PAD_B64), smallG = padGeometries(SMALL_PAD_META, SMALL_PAD_B64);
    meshes = {
      bigBase: mk(bigG.base, metal, big.length, true),
      bigGlow: mk(bigG.glow, glowMat, big.length),
      bigOrb: mk(new THREE.SphereGeometry(0.5, 28, 18), orbMat, big.length),
      bigFlame: mk(flameGeometry(), flameMat, big.length),
      smallBase: mk(smallG.base, metal, small.length, true),
      smallGlow: mk(smallG.glow, glowMat, small.length),
    };
    // flames and glow use instanceColor for the on/off state
    for (const k of ['bigGlow', 'smallGlow']) {
      meshes[k].instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(meshes[k].count, 1) * 3), 3);
      meshes[k].instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    pads = viewPads.map((p) => ({ index: p.index, isBig: p.isBig, slot: p.isBig ? big.indexOf(p) : small.indexOf(p), x: p.pos.x * S, z: p.pos.y * S, phase: (p.index * 1.7) % 6.28, active: null }));
    // static matrices
    for (const p of pads) {
      dummy.position.set(p.x, 0.005, p.z); dummy.rotation.set(0, p.phase, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
      if (p.isBig) { meshes.bigBase.setMatrixAt(p.slot, dummy.matrix); meshes.bigGlow.setMatrixAt(p.slot, dummy.matrix); }
      else { meshes.smallBase.setMatrixAt(p.slot, dummy.matrix); meshes.smallGlow.setMatrixAt(p.slot, dummy.matrix); }
    }
    for (const k in meshes) meshes[k].instanceMatrix.needsUpdate = true;
    setDetail(detail);
  }

  let time = 0;
  function update(view, dt) {
    if (!view.pads || !view.pads.length) return;
    if (!meshes || pads.length !== view.pads.length) { dispose(true); build(view.pads); }
    time += dt;
    flameMat.uniforms.uTime.value = time;
    orbMat.uniforms.uTime.value = time;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i], vp = view.pads[i];
      const active = !!vp.isActive;
      if (p.isBig) {
        if (active) {
          dummy.position.set(p.x, 1.25 + Math.sin(time * 2.0 + p.phase) * 0.08, p.z);
          dummy.rotation.set(0, time * 0.8 + p.phase, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          meshes.bigOrb.setMatrixAt(p.slot, dummy.matrix);
          dummy.position.set(p.x, 0, p.z); dummy.rotation.set(0, time * 0.5 + p.phase, 0);
          const fl = 1 + Math.sin(time * 9 + p.phase) * 0.06; dummy.scale.set(1.0, fl, 1.0); dummy.updateMatrix();
          meshes.bigFlame.setMatrixAt(p.slot, dummy.matrix);
        } else {
          meshes.bigOrb.setMatrixAt(p.slot, zero);
          meshes.bigFlame.setMatrixAt(p.slot, zero);
        }
        if (active !== p.active) { meshes.bigGlow.setColorAt(p.slot, active ? FULL : EMPTY); meshes.bigGlow.instanceColor.needsUpdate = true; }
      } else {
        if (active !== p.active) { meshes.smallGlow.setColorAt(p.slot, active ? SMALL_FULL : EMPTY); meshes.smallGlow.instanceColor.needsUpdate = true; }
      }
      p.active = active;
    }
    meshes.bigOrb.instanceMatrix.needsUpdate = true;
    meshes.bigFlame.instanceMatrix.needsUpdate = true;
  }

  let detail = 2;
  function setDetail(level) { // 0 = low: no flames
    detail = level;
    if (!meshes) return;
    meshes.bigFlame.visible = level > 0;
  }

  function dispose(keepMaterials) {
    if (meshes) for (const k in meshes) { group.remove(meshes[k]); meshes[k].geometry.dispose(); meshes[k].dispose && meshes[k].dispose(); }
    meshes = null;
    if (!keepMaterials) { metal.dispose(); glowMat.dispose(); flameMat.dispose(); orbMat.dispose(); }
  }

  return { object3d: group, update, setDetail, dispose };
}
