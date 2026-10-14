// OWNER: VFX agent. GPU particle pool.
//
// One draw call per pool. Every particle is a camera-facing quad whose whole
// life is evaluated analytically in the vertex shader from its spawn record
// (position, velocity, drag, gravity, birth time, life, sizes, colours), so the
// CPU only writes a 24-float record when a particle is born. Records live in a
// ring buffer (oldest particles are overwritten when the pool is full) inside
// one interleaved instanced buffer; only the slots written this frame are
// uploaded (addUpdateRange).
//
// Shapes: 0 soft glow, 1 smoke puff (noisy), 2 spark (stretched along screen
// velocity), 3 thin ring, 4 glint (four-point star + glow).
import * as THREE from 'three';

const STRIDE = 24;
export const SHAPE = Object.freeze({ GLOW: 0, SMOKE: 1, SPARK: 2, RING: 3, GLINT: 4 });

const VERT = /* glsl */`
attribute vec4 aP0;   // pos.xyz, birth time
attribute vec4 aV0;   // vel.xyz, life
attribute vec4 aSz;   // size0, size1, drag, gravity
attribute vec4 aC0;   // colour at birth (linear HDR rgb, alpha)
attribute vec4 aC1;   // colour at death
attribute vec4 aMs;   // shape, stretch (s), rotation/seed, fade-in fraction
uniform float uTime;
varying vec4 vCol;
varying vec2 vUv;
varying float vShape;
varying float vSeed;
varying float vWorldY;
varying float vFloorSoft;
void main() {
  float age = uTime - aP0.w;
  float t = age / aV0.w;
  if (t < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec4(0.0); return; }
  float k = aSz.z;
  float ek = exp(-k * age);
  float f = k > 1e-4 ? (1.0 - ek) / k : age;
  vec3 pos = aP0.xyz + aV0.xyz * f;
  pos.y -= 0.5 * aSz.w * age * age;
  vec3 vel = aV0.xyz * ek;
  vel.y -= aSz.w * age;
  float size = mix(aSz.x, aSz.y, 1.0 - (1.0 - t) * (1.0 - t));
  // smoke billows ride up over the floor instead of sinking into it
  if (aMs.x > 0.5 && aMs.x < 1.5) pos.y = max(pos.y, size * 0.45);
  vec4 mv = viewMatrix * vec4(pos, 1.0);
  vec2 c = position.xy;
  vec2 offs;
  if (aMs.y > 0.0) {
    vec3 vv = (viewMatrix * vec4(vel, 0.0)).xyz;
    // screen-plane velocity, compensating for depth so streaks keep their world length
    vec2 d = vv.xy;
    float L = length(d);
    vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
    vec2 perp = vec2(-dir.y, dir.x);
    float len = size + L * aMs.y;
    offs = dir * (c.x * len - len + size) + perp * c.y * size; // head at the particle, tail behind
  } else {
    float s = sin(aMs.z), co = cos(aMs.z);
    offs = vec2(co * c.x - s * c.y, s * c.x + co * c.y) * size;
  }
  mv.xy += offs;
  gl_Position = projectionMatrix * mv;
  // world height of this corner (camera right/up from the view matrix rows) -> soft floor fade
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vWorldY = pos.y + camR.y * offs.x + camU.y * offs.y;
  vFloorSoft = max(size * 0.35, 0.05);
  vCol = mix(aC0, aC1, t);
  vCol.a *= smoothstep(0.0, max(aMs.w, 1e-3), t);
  vUv = c;
  vShape = aMs.x;
  vSeed = aMs.z;
}
`;

const FRAG = /* glsl */`
varying vec4 vCol;
varying vec2 vUv;
varying float vShape;
varying float vSeed;
varying float vWorldY;
varying float vFloorSoft;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float r = length(vUv);
  float a;
  if (vShape < 0.5) {               // soft glow
    float q = max(1.0 - r, 0.0);
    a = q * q * (0.6 + 0.4 * q);
  } else if (vShape < 1.5) {        // smoke puff
    vec2 p = vUv * 1.7 + vec2(vSeed * 3.1, vSeed * 1.7);
    float n = vnoise(p) * 0.65 + vnoise(p * 2.3) * 0.35;
    a = smoothstep(1.0, 0.15, r + (n - 0.5) * 0.7);
  } else if (vShape < 2.5) {        // spark streak (x = along, +1 = head)
    float across = 1.0 - abs(vUv.y);
    float along = smoothstep(-1.0, 0.2, vUv.x) * smoothstep(1.0, 0.75, vUv.x);
    a = across * across * across * along;
  } else if (vShape < 3.5) {        // thin ring
    float d = (r - 0.8) / 0.12;
    a = exp(-d * d) + 0.12 * max(0.0, 1.0 - r);
  } else {                          // glint: four-point star
    float sx = exp(-abs(vUv.y) * 22.0) * max(0.0, 1.0 - abs(vUv.x));
    float sy = exp(-abs(vUv.x) * 22.0) * max(0.0, 1.0 - abs(vUv.y));
    float q = max(1.0 - r * 1.6, 0.0);
    a = max(sx, sy) + q * q;
  }
  a *= vCol.a * smoothstep(-0.02, vFloorSoft, vWorldY);
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class ParticlePool {
  constructor(capacity, additive, renderOrder) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    for (let i = 0; i < capacity; i++) { this.data[i * STRIDE + 3] = -1e9; this.data[i * STRIDE + 7] = 1; }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ib = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1).setUsage(THREE.DynamicDrawUsage);
    this.buffer = ib;
    ['aP0', 'aV0', 'aSz', 'aC0', 'aC1', 'aMs'].forEach((n, i) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(ib, 4, i * 4)));
    geo.instanceCount = capacity;
    this.uniforms = { uTime: { value: 0 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = additive ? 'vfx.particles.add' : 'vfx.particles.alpha';
    this.head = 0; this.used = 0; this.aliveUntil = -1;
    this.dirtyLo = -1; this.dirtyHi = -1; this.wrapped = false;
    this.time = 0;
    // current style (set with style(); read by emit())
    this.c0 = [1, 1, 1, 1]; this.c1 = [1, 1, 1, 0];
    this.drag = 0; this.grav = 0; this.shape = 0; this.stretch = 0; this.fadeIn = 0;
  }

  // Set the style used by subsequent emit() calls. Colours are [r,g,b,a] linear (may exceed 1).
  style(c0, c1, drag = 0, grav = 0, shape = 0, stretch = 0, fadeIn = 0) {
    this.c0 = c0; this.c1 = c1; this.drag = drag; this.grav = grav;
    this.shape = shape; this.stretch = stretch; this.fadeIn = fadeIn;
    return this;
  }

  // Spawn one particle (three.js world space, metres). size = radius of the quad.
  emit(x, y, z, vx, vy, vz, life, s0, s1, birth = this.time) {
    const i = this.head;
    this.head = (i + 1) % this.capacity;
    const d = this.data, o = i * STRIDE, c0 = this.c0, c1 = this.c1;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = birth;
    d[o + 4] = vx; d[o + 5] = vy; d[o + 6] = vz; d[o + 7] = life;
    d[o + 8] = s0; d[o + 9] = s1; d[o + 10] = this.drag; d[o + 11] = this.grav;
    d[o + 12] = c0[0]; d[o + 13] = c0[1]; d[o + 14] = c0[2]; d[o + 15] = c0[3];
    d[o + 16] = c1[0]; d[o + 17] = c1[1]; d[o + 18] = c1[2]; d[o + 19] = c1[3];
    d[o + 20] = this.shape; d[o + 21] = this.stretch; d[o + 22] = Math.random() * 6.2832; d[o + 23] = this.fadeIn;
    if (birth + life > this.aliveUntil) this.aliveUntil = birth + life;
    if (i + 1 > this.used) this.used = i + 1;
    if (this.dirtyLo < 0) { this.dirtyLo = i; this.dirtyHi = i; }
    else if (i < this.dirtyLo) this.wrapped = true;
    else this.dirtyHi = i;
  }

  update(time) {
    this.time = time;
    this.uniforms.uTime.value = time;
    // only draw the part of the pool that has ever been written, and nothing once all are dead
    this.mesh.geometry.instanceCount = this.used;
    this.mesh.visible = time < this.aliveUntil && this.used > 0;
    if (this.dirtyLo >= 0) {
      const b = this.buffer;
      b.clearUpdateRanges();
      if (this.wrapped) b.addUpdateRange(0, this.capacity * STRIDE);
      else b.addUpdateRange(this.dirtyLo * STRIDE, (this.dirtyHi - this.dirtyLo + 1) * STRIDE);
      b.needsUpdate = true;
      this.dirtyLo = -1; this.dirtyHi = -1; this.wrapped = false;
    }
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) this.data[i * STRIDE + 3] = -1e9;
    this.head = 0; this.used = 0; this.aliveUntil = -1;
    this.buffer.clearUpdateRanges();
    this.buffer.addUpdateRange(0, this.capacity * STRIDE);
    this.buffer.needsUpdate = true;
    this.dirtyLo = -1; this.dirtyHi = -1; this.wrapped = false;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}
