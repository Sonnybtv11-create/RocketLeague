// OWNER: VFX agent. Boost flames (one draw call for every nozzle of every car).
//
// A unit flame "bulb" (lathe, axis −X, length 1, max radius 1) is instanced per
// nozzle and per layer (0 = white-hot core, 1 = orange outer flame). Each
// instance knows its car slot and nozzle offset (model space); the car
// transforms and boost intensities are uniform arrays updated once per frame,
// so no per-instance buffers change while driving.
import * as THREE from 'three';

export const MAX_CARS = 8;
export const MAX_NOZZLES = 4;

const VERT = /* glsl */`
#define MAX_CARS ${MAX_CARS}
attribute vec4 aNoz;    // nozzle model offset xyz, seed
attribute vec2 aInfo;   // car slot, layer
uniform mat4 uCarMat[MAX_CARS];
uniform vec4 uCarK[MAX_CARS];   // boost intensity 0..1, supersonic 0..1, size scale, unused
uniform float uTime;
varying float vT;
varying float vLayer;
varying float vOn;
varying float vSeed;
varying float vAng;
varying vec3 vN;
varying vec3 vV;
void main() {
  int ci = int(aInfo.x + 0.5);
  vec4 k = uCarK[ci];
  float on = k.x;
  if (on < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vOn = 0.0; return; }
  float layer = aInfo.y;
  float seed = aNoz.w;
  float flick = 0.86 + 0.1 * sin(uTime * 71.0 + seed * 13.0) + 0.07 * sin(uTime * 43.0 + seed * 5.0) + 0.05 * sin(uTime * 113.0 + seed);
  float L = (layer < 0.5 ? 0.42 : 0.95) * (0.35 + 0.65 * on) * (1.0 + 0.35 * k.y) * flick * k.z;
  float R = (layer < 0.5 ? 0.055 : 0.105) * (0.55 + 0.45 * on) * k.z;
  float t = -position.x;
  vec3 lp = vec3(position.x * L, position.y * R, position.z * R);
  // slight lateral lick of the tip
  lp.yz += t * t * R * 0.5 * vec2(sin(uTime * 37.0 + seed * 3.0), cos(uTime * 29.0 + seed * 7.0));
  lp += aNoz.xyz;
  mat4 M = uCarMat[ci];
  vec4 wp = M * vec4(lp, 1.0);
  vN = normalize(mat3(M) * vec3(normal.x / L, normal.y / R, normal.z / R));
  vV = cameraPosition - wp.xyz;
  vT = t;
  vLayer = layer;
  vOn = on;
  vSeed = seed;
  vAng = atan(position.z, position.y);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */`
varying float vT;
varying float vLayer;
varying float vOn;
varying float vSeed;
varying float vAng;
varying vec3 vN;
varying vec3 vV;
uniform float uTime;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  if (vOn < 0.01) discard;
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float t = clamp(vT, 0.0, 1.0);
  float n = vnoise(vec2(t * 7.0 - uTime * 26.0, vAng * 1.6 + vSeed * 9.0));
  vec3 col;
  float a;
  if (vLayer < 0.5) {
    // core: white-hot -> yellow
    col = mix(vec3(3.0, 2.5, 1.4), vec3(2.4, 1.2, 0.25), smoothstep(0.1, 0.9, t));
    a = pow(facing, 0.8) * pow(1.0 - t, 1.1) * (0.75 + 0.25 * n);
  } else {
    // outer: yellow-orange -> red, licked by scrolling noise
    col = mix(vec3(2.8, 1.35, 0.25), vec3(1.0, 0.13, 0.02), smoothstep(0.05, 0.85, t));
    a = pow(facing, 1.2) * pow(1.0 - t, 0.9) * smoothstep(0.1, 0.7, n + 0.45 * (1.0 - t)) * 0.95;
  }
  a *= vOn;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function flameGeometry() {
  // radius profile along t (0 at nozzle .. 1 tip)
  const pts = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const r = i === N ? 0 : Math.max(0.0, (0.72 + 0.28 * Math.sin(Math.min(t / 0.35, 1) * Math.PI * 0.5)) * Math.pow(1 - t, 0.6));
    pts.push(new THREE.Vector2(r, t));
  }
  // close the base with a small cap so the nozzle end looks solid
  pts.unshift(new THREE.Vector2(0, 0));
  const g = new THREE.LatheGeometry(pts, 14);
  g.rotateZ(Math.PI / 2); // +Y (lathe axis) -> -X
  g.deleteAttribute('uv');
  return g;
}

export class BoostFlames {
  constructor(carMats, carK) {
    const base = flameGeometry();
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('normal', base.getAttribute('normal'));
    const n = MAX_CARS * MAX_NOZZLES * 2;
    this.noz = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.info = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    geo.setAttribute('aNoz', this.noz);
    geo.setAttribute('aInfo', this.info);
    geo.instanceCount = 0;
    this.geo = geo;
    this.uniforms = { uCarMat: { value: carMats }, uCarK: { value: carK }, uTime: { value: 0 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.name = 'vfx.flames';
  }

  // slots: array of { slot, nozzles: [THREE.Vector3] } — rebuilt only when the car set changes
  setCars(slots) {
    let k = 0;
    const nz = this.noz.array, inf = this.info.array;
    for (const s of slots) {
      const nozzles = s.nozzles.slice(0, MAX_NOZZLES);
      for (let j = 0; j < nozzles.length; j++) {
        for (let layer = 1; layer >= 0; layer--) {
          const p = nozzles[j];
          nz[k * 4] = p.x; nz[k * 4 + 1] = p.y; nz[k * 4 + 2] = p.z; nz[k * 4 + 3] = (s.slot * 7 + j * 3.3) % 10;
          inf[k * 2] = s.slot; inf[k * 2 + 1] = layer;
          k++;
        }
      }
    }
    this.geo.instanceCount = k;
    this.noz.needsUpdate = true;
    this.info.needsUpdate = true;
  }

  update(time) { this.uniforms.uTime.value = time; }
  dispose() { this.geo.dispose(); this.material.dispose(); }
}
