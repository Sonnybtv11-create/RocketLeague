// OWNER: VFX agent. Powerslide tyre marks.
//
// Each mark segment is one instance of a quad laid on the driving surface
// between two consecutive contact points of a back wheel (works on the floor,
// walls and ceiling: the quad is built around the surface normal). Segments
// live in a ring buffer and fade out with age in the shader. One draw call.
import * as THREE from 'three';

const STRIDE = 12;

const VERT = /* glsl */`
attribute vec4 aA;   // start xyz, birth
attribute vec4 aB;   // end xyz, width
attribute vec4 aN;   // normal xyz, strength
uniform float uTime;
uniform float uLife;
varying float vA;
varying vec2 vUv;
void main() {
  float age = uTime - aA.w;
  if (age < 0.0 || age > uLife) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
  vec3 d = aB.xyz - aA.xyz;
  vec3 side = normalize(cross(aN.xyz, d + vec3(1e-5))) * aB.w;
  vec3 p = mix(aA.xyz, aB.xyz, position.x) + side * position.y + aN.xyz * 0.012;
  float f = 1.0 - smoothstep(uLife * 0.45, uLife, age);
  vA = aN.w * f;
  vUv = vec2(position.x, position.y);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
varying float vA;
varying vec2 vUv;
float hash(float p) { return fract(sin(p * 91.7) * 43758.5453); }
void main() {
  float across = 1.0 - abs(vUv.y);
  // tread grain across the mark
  float grain = 0.75 + 0.25 * hash(floor((vUv.y + 1.0) * 6.0));
  float a = vA * smoothstep(0.0, 0.35, across) * grain * 0.55;
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.012, 0.012, 0.012, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SkidMarks {
  constructor(capacity = 2400, life = 7) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    for (let i = 0; i < capacity; i++) this.data[i * STRIDE + 3] = -1e9;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ib = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1).setUsage(THREE.DynamicDrawUsage);
    this.buffer = ib;
    geo.setAttribute('aA', new THREE.InterleavedBufferAttribute(ib, 4, 0));
    geo.setAttribute('aB', new THREE.InterleavedBufferAttribute(ib, 4, 4));
    geo.setAttribute('aN', new THREE.InterleavedBufferAttribute(ib, 4, 8));
    geo.instanceCount = capacity;
    this.uniforms = { uTime: { value: 0 }, uLife: { value: life } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'vfx.skids';
    this.head = 0; this.lo = -1; this.hi = -1; this.wrapped = false;
    this.used = 0; this.lastAdd = -1e9;
  }

  setLife(life) { this.uniforms.uLife.value = life; }

  add(ax, ay, az, bx, by, bz, nx, ny, nz, width, strength, time) {
    const i = this.head;
    this.head = (i + 1) % this.capacity;
    const d = this.data, o = i * STRIDE;
    d[o] = ax; d[o + 1] = ay; d[o + 2] = az; d[o + 3] = time;
    d[o + 4] = bx; d[o + 5] = by; d[o + 6] = bz; d[o + 7] = width;
    d[o + 8] = nx; d[o + 9] = ny; d[o + 10] = nz; d[o + 11] = strength;
    if (this.lo < 0) { this.lo = i; this.hi = i; } else if (i < this.lo) this.wrapped = true; else this.hi = i;
    if (i + 1 > this.used) this.used = i + 1;
    this.lastAdd = time;
  }

  update(time) {
    this.uniforms.uTime.value = time;
    this.mesh.geometry.instanceCount = this.used;
    this.mesh.visible = this.used > 0 && time < this.lastAdd + this.uniforms.uLife.value;
    if (this.lo >= 0) {
      const b = this.buffer;
      b.clearUpdateRanges();
      if (this.wrapped) b.addUpdateRange(0, this.capacity * STRIDE);
      else b.addUpdateRange(this.lo * STRIDE, (this.hi - this.lo + 1) * STRIDE);
      b.needsUpdate = true;
      this.lo = -1; this.hi = -1; this.wrapped = false;
    }
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) this.data[i * STRIDE + 3] = -1e9;
    this.buffer.clearUpdateRanges();
    this.buffer.addUpdateRange(0, this.capacity * STRIDE);
    this.buffer.needsUpdate = true;
    this.head = 0; this.lo = -1; this.hi = -1; this.wrapped = false;
    this.used = 0; this.lastAdd = -1e9;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}
