// OWNER: VFX agent. Shockwaves: oriented expanding rings and fresnel sphere shells.
// Two instanced meshes (one draw call each), shader-animated from spawn records.
import * as THREE from 'three';

const STRIDE = 16;

const COMMON = /* glsl */`
attribute vec4 aC;   // centre xyz, birth
attribute vec4 aN;   // normal xyz (rings), life
attribute vec4 aR;   // r0, r1, thickness (fraction of radius), intensity
attribute vec4 aK;   // rgb (linear HDR), ease power
uniform float uTime;
varying vec3 vCol;
varying float vA;
varying float vT;
varying float vY;
float lifeT() { return (uTime - aC.w) / aN.w; }
float radiusAt(float t) { return mix(aR.x, aR.y, 1.0 - pow(1.0 - t, aK.w)); }
`;

const RING_VERT = COMMON + /* glsl */`
varying vec2 vUv;
varying float vTh;
void main() {
  float t = lifeT();
  if (t < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
  vec3 n = normalize(aN.xyz);
  vec3 a = abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 u = normalize(cross(n, a));
  vec3 v = cross(n, u);
  float R = radiusAt(t);
  float ext = 1.0 + aR.z * 1.5;
  vec3 p = aC.xyz + (u * position.x + v * position.y) * R * ext;
  vUv = position.xy * ext;
  vTh = aR.z;
  vCol = aK.rgb;
  vA = aR.w * pow(1.0 - t, 1.6);
  vT = t;
  vY = abs(aN.y) > 0.9 ? 100.0 : p.y; // flat floor-level rings are exempt from the floor fade
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const RING_FRAG = /* glsl */`
varying vec3 vCol;
varying float vA;
varying float vT;
varying float vY;
varying vec2 vUv;
varying float vTh;
void main() {
  float r = length(vUv);
  float d = (r - 1.0) / max(vTh, 0.01);
  float a = exp(-d * d * 2.0);
  // faint inner fill behind the front, stronger early
  a += 0.08 * (1.0 - vT) * smoothstep(1.0, 0.2, r) * step(r, 1.0);
  a *= vA;
  a *= smoothstep(-0.02, 0.18, vY);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SHELL_VERT = COMMON + /* glsl */`
varying vec3 vN;
varying vec3 vV;
void main() {
  float t = lifeT();
  if (t < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
  float R = radiusAt(t);
  vec3 p = aC.xyz + position * R;
  vN = normal;
  vV = cameraPosition - p;
  vCol = aK.rgb;
  vA = aR.w * pow(1.0 - t, 1.4);
  vT = t;
  vY = abs(aN.y) > 0.9 ? 100.0 : p.y; // flat floor-level rings are exempt from the floor fade
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const SHELL_FRAG = /* glsl */`
varying vec3 vCol;
varying float vA;
varying float vT;
varying float vY;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float a = vA * pow(f, 2.5);
  a *= smoothstep(-0.02, 0.18, vY);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class ShockPool {
  constructor(baseGeo, vert, frag, capacity, renderOrder, name) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    for (let i = 0; i < capacity; i++) { this.data[i * STRIDE + 3] = -1e9; this.data[i * STRIDE + 7] = 1; }
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = baseGeo.index;
    geo.setAttribute('position', baseGeo.getAttribute('position'));
    if (baseGeo.getAttribute('normal')) geo.setAttribute('normal', baseGeo.getAttribute('normal'));
    const ib = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1).setUsage(THREE.DynamicDrawUsage);
    this.buffer = ib;
    ['aC', 'aN', 'aR', 'aK'].forEach((n, i) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(ib, 4, i * 4)));
    geo.instanceCount = capacity;
    this.uniforms = { uTime: { value: 0 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vert, fragmentShader: frag,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = name;
    this.head = 0;
    this.dirty = false;
    this.aliveUntil = -1;
  }

  // centre (three world), normal, radius r0 -> r1 over life seconds, thickness (fraction), intensity, colour [r,g,b] HDR
  add(cx, cy, cz, nx, ny, nz, life, r0, r1, thick, intensity, col, ease = 3, birth) {
    const i = this.head;
    this.head = (i + 1) % this.capacity;
    const d = this.data, o = i * STRIDE;
    d[o] = cx; d[o + 1] = cy; d[o + 2] = cz; d[o + 3] = birth;
    d[o + 4] = nx; d[o + 5] = ny; d[o + 6] = nz; d[o + 7] = life;
    d[o + 8] = r0; d[o + 9] = r1; d[o + 10] = thick; d[o + 11] = intensity;
    d[o + 12] = col[0]; d[o + 13] = col[1]; d[o + 14] = col[2]; d[o + 15] = ease;
    this.dirty = true;
    this.aliveUntil = Math.max(this.aliveUntil, birth + life);
  }

  update(time) {
    this.uniforms.uTime.value = time;
    this.mesh.visible = time < this.aliveUntil;
    if (this.dirty) { this.buffer.needsUpdate = true; this.dirty = false; } // tiny buffer: full upload
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) this.data[i * STRIDE + 3] = -1e9;
    this.dirty = true;
    this.aliveUntil = -1;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

export class Shocks {
  constructor() {
    const quad = new THREE.PlaneGeometry(2, 2);
    const sphere = new THREE.SphereGeometry(1, 28, 18);
    this.rings = new ShockPool(quad, RING_VERT, RING_FRAG, 24, 24, 'vfx.rings');
    this.shells = new ShockPool(sphere, SHELL_VERT, SHELL_FRAG, 12, 24, 'vfx.shells');
    this.time = 0;
  }
  ring(cx, cy, cz, nx, ny, nz, life, r0, r1, thick, intensity, col, ease = 3) {
    this.rings.add(cx, cy, cz, nx, ny, nz, life, r0, r1, thick, intensity, col, ease, this.time);
  }
  shell(cx, cy, cz, life, r0, r1, intensity, col, ease = 3) {
    this.shells.add(cx, cy, cz, 0, 0, 0, life, r0, r1, 0, intensity, col, ease, this.time);
  }
  update(time) { this.time = time; this.rings.update(time); this.shells.update(time); }
  clear() { this.rings.clear(); this.shells.clear(); }
  dispose() { this.rings.dispose(); this.shells.dispose(); }
}
