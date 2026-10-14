// OWNER: VFX agent. Camera-facing ribbon trails (supersonic contrails).
//
// Each ribbon keeps a ring buffer of sampled world points (sampled at a fixed
// rate, not per frame) plus a live head point. Every frame the strip is
// rebuilt on the CPU into one shared, preallocated vertex buffer (a few hundred
// vertices at most) — one draw call for all ribbons, zero allocations.
import * as THREE from 'three';

const N = 36;            // samples per ribbon
const SAMPLE_DT = 1 / 50;
const VPR = (N + 1) * 2; // vertices per ribbon

export class Ribbons {
  constructor(count, { life = 0.7, width = 0.07, color = [1.4, 1.45, 1.55], alpha = 0.5 } = {}) {
    this.count = count; this.life = life; this.width = width; this.alpha = alpha;
    this.pts = new Float32Array(count * N * 3);
    this.times = new Float32Array(count * N).fill(-1e9);
    this.head = new Int32Array(count);
    this.lastSample = new Float32Array(count).fill(-1e9);
    this.live = new Float32Array(count * 3);
    this.emitting = new Uint8Array(count);
    this.activeUntil = new Float32Array(count).fill(-1);
    const pos = new Float32Array(count * VPR * 3);
    const col = new Float32Array(count * VPR * 4);
    const idx = [];
    for (let r = 0; r < count; r++) {
      const b = r * VPR;
      for (let i = 0; i < N; i++) {
        const a = b + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aCol', this.colAttr);
    geo.setIndex(idx);
    this.color = color;
    this.material = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        attribute vec4 aCol; varying vec4 vC;
        void main() { vC = aCol; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying vec4 vC;
        void main() {
          float across = 1.0 - abs(vC.r * 2.0 - 1.0);
          float a = vC.a * across * across;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      uniforms: { uColor: { value: new THREE.Vector3(...color) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 19;
    this.mesh.name = 'vfx.ribbons';
    this._t = new THREE.Vector3(); this._s = new THREE.Vector3(); this._c = new THREE.Vector3();
  }

  // Feed the emitter position for ribbon r this frame. emitting=false lets it fade out.
  feed(r, x, y, z, emitting, time) {
    const L = this.live;
    if (emitting && !this.emitting[r]) {
      // (re)start: drop stale samples so the strip doesn't bridge a gap
      for (let i = 0; i < N; i++) this.times[r * N + i] = -1e9;
      this.lastSample[r] = -1e9;
    } else if (emitting) {
      const dx = x - L[r * 3], dy = y - L[r * 3 + 1], dz = z - L[r * 3 + 2];
      if (dx * dx + dy * dy + dz * dz > 16) { // teleport
        for (let i = 0; i < N; i++) this.times[r * N + i] = -1e9;
        this.lastSample[r] = -1e9;
      }
    }
    L[r * 3] = x; L[r * 3 + 1] = y; L[r * 3 + 2] = z;
    this.emitting[r] = emitting ? 1 : 0;
    if (emitting) {
      this.activeUntil[r] = time + this.life;
      if (time - this.lastSample[r] >= SAMPLE_DT) {
        this.lastSample[r] = time;
        const h = this.head[r];
        const o = (r * N + h) * 3;
        this.pts[o] = x; this.pts[o + 1] = y; this.pts[o + 2] = z;
        this.times[r * N + h] = time;
        this.head[r] = (h + 1) % N;
      }
    }
  }

  update(time, camPos) {
    const P = this.posAttr.array, C = this.colAttr.array;
    const t = this._t, s = this._s, c = this._c;
    let any = false, active = false;
    for (let r = 0; r < this.count; r++) {
      const vb = r * VPR;
      if (time > this.activeUntil[r]) {
        if (this.activeUntil[r] !== -2) {
          for (let v = 0; v < VPR; v++) { C[(vb + v) * 4 + 3] = 0; P[(vb + v) * 3] = 0; P[(vb + v) * 3 + 1] = -100; P[(vb + v) * 3 + 2] = 0; }
          this.activeUntil[r] = -2; any = true;
        }
        continue;
      }
      any = true; active = true;
      // walk from newest to oldest: index 0 = live head (if emitting) else newest sample
      let prevX = this.live[r * 3], prevY = this.live[r * 3 + 1], prevZ = this.live[r * 3 + 2];
      let k = 0;
      const head = this.head[r];
      const total = N + 1;
      for (let i = 0; i < total; i++) {
        let x, y, z, age;
        if (i === 0) {
          if (this.emitting[r]) { x = prevX; y = prevY; z = prevZ; age = 0; }
          else {
            const si = (head - 1 + N) % N;
            const o = (r * N + si) * 3; x = this.pts[o]; y = this.pts[o + 1]; z = this.pts[o + 2];
            age = time - this.times[r * N + si];
          }
        } else {
          const si = (head - i + N * 2) % N;
          const o = (r * N + si) * 3;
          x = this.pts[o]; y = this.pts[o + 1]; z = this.pts[o + 2];
          age = time - this.times[r * N + si];
        }
        const f = Math.max(0, 1 - age / this.life);
        if (f <= 0) { x = prevX; y = prevY; z = prevZ; } // collapse dead tail onto the last live point
        // tangent from previous point
        t.set(prevX - x, prevY - y, prevZ - z);
        if (t.lengthSq() < 1e-8) t.set(0, 0, 1);
        c.set(camPos.x - x, camPos.y - y, camPos.z - z);
        s.crossVectors(t, c);
        const sl = s.length() || 1;
        const w = this.width * (0.35 + 0.65 * f) / sl;
        const v0 = (vb + k) * 3, v1 = v0 + 3;
        P[v0] = x + s.x * w; P[v0 + 1] = y + s.y * w; P[v0 + 2] = z + s.z * w;
        P[v1] = x - s.x * w; P[v1 + 1] = y - s.y * w; P[v1 + 2] = z - s.z * w;
        const a = this.alpha * f * f * (i === 0 ? 0.6 : 1);
        const c0 = (vb + k) * 4, c1 = c0 + 4;
        C[c0] = 0; C[c0 + 3] = a;
        C[c1] = 1; C[c1 + 3] = a;
        k += 2;
        if (i > 0) { prevX = x; prevY = y; prevZ = z; }
        else if (!this.emitting[r]) { prevX = x; prevY = y; prevZ = z; }
      }
    }
    if (any) { this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true; }
    return active;
  }

  clear() {
    this.times.fill(-1e9); this.lastSample.fill(-1e9); this.emitting.fill(0); this.activeUntil.fill(-1);
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}
