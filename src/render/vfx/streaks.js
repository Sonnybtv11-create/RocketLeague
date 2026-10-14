// OWNER: VFX agent. Supersonic wind streaks (one draw call for all cars).
//
// Thin, camera-facing lines that slide from the front of the car to behind it
// around the body, like air being torn past. Fully animated in the vertex
// shader from per-instance constants + the shared per-car uniform arrays.
import * as THREE from 'three';
import { MAX_CARS } from './flames.js';

export const STREAKS_PER_CAR = 18;

const VERT = /* glsl */`
#define MAX_CARS ${MAX_CARS}
attribute vec4 aLoc;   // up offset, right offset, phase, speed (cycles/s)
attribute vec4 aSpan;  // front x, travel range, length, width
attribute float aCar;
uniform mat4 uCarMat[MAX_CARS];
uniform vec4 uCarK[MAX_CARS];   // .w = supersonic streak intensity
uniform float uTime;
varying float vA;
varying vec2 vUv;
void main() {
  int ci = int(aCar + 0.5);
  float on = uCarK[ci].w;
  if (on < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
  float ph = fract(aLoc.z + uTime * aLoc.w);
  float x = aSpan.x - ph * aSpan.y;
  vec3 lp = vec3(x + position.x * aSpan.z * 0.5, aLoc.x, aLoc.y);
  // streaks flare outwards as they pass the car
  lp.yz *= 1.0 + 0.12 * ph;
  mat4 M = uCarMat[ci];
  vec4 wp = M * vec4(lp, 1.0);
  vec3 fw = normalize(mat3(M) * vec3(1.0, 0.0, 0.0));
  vec3 toCam = cameraPosition - wp.xyz;
  vec3 side = normalize(cross(fw, toCam));
  float dist = length(toCam);
  wp.xyz += side * position.y * max(aSpan.w, dist * 0.0012);
  vA = on * sin(3.14159 * ph) * smoothstep(0.6, 3.0, dist);
  vUv = position.xy;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */`
varying float vA;
varying vec2 vUv;
void main() {
  float a = vA * (1.0 - abs(vUv.y)) * smoothstep(1.0, 0.2, abs(vUv.x)) * 0.28;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(1.25, 1.3, 1.4), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SupersonicStreaks {
  constructor(carMats, carK) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const n = MAX_CARS * STREAKS_PER_CAR;
    this.loc = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.span = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.car = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    geo.setAttribute('aLoc', this.loc);
    geo.setAttribute('aSpan', this.span);
    geo.setAttribute('aCar', this.car);
    geo.instanceCount = 0;
    this.geo = geo;
    this.uniforms = { uCarMat: { value: carMats }, uCarK: { value: carK }, uTime: { value: 0 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, forceSinglePass: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 23;
    this.mesh.name = 'vfx.streaks';
  }

  // slots: [{ slot, cfg (CAR_CONFIGS entry) }]
  setCars(slots) {
    let k = 0;
    const L = this.loc.array, S = this.span.array, C = this.car.array;
    for (const s of slots) {
      const hs = s.cfg.hitboxSize, ho = s.cfg.hitboxOffset;
      const cy = ho.z / 100, hh = hs.z / 200 + 0.16, hw = hs.y / 200 + 0.16;
      const front = (ho.x + hs.x / 2) / 100 + 0.35, range = hs.x / 100 + 0.5;
      for (let j = 0; j < STREAKS_PER_CAR; j++) {
        // angles around the body, mostly over the top and sides (none under the floor)
        const a = -1.75 + 3.5 * ((j + 0.5) / STREAKS_PER_CAR) + (Math.random() - 0.5) * 0.15;
        L[k * 4] = cy + Math.cos(a) * hh;
        L[k * 4 + 1] = Math.sin(a) * hw;
        L[k * 4 + 2] = Math.random();
        L[k * 4 + 3] = 2.4 + Math.random() * 1.6;
        S[k * 4] = front; S[k * 4 + 1] = range;
        S[k * 4 + 2] = 0.55 + Math.random() * 0.6; S[k * 4 + 3] = 0.008 + Math.random() * 0.006;
        C[k] = s.slot;
        k++;
      }
    }
    this.geo.instanceCount = k;
    this.loc.needsUpdate = true; this.span.needsUpdate = true; this.car.needsUpdate = true;
  }

  update(time) { this.uniforms.uTime.value = time; }
  dispose() { this.geo.dispose(); this.material.dispose(); }
}
