// Procedural sky dome (late-afternoon stadium day: deep blue zenith, hazy
// horizon, warm sun, drifting cumulus) + distant scenery silhouettes.
import * as THREE from 'three';
import { rng } from './textures.js';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // at the far plane
}`;

const SKY_FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform float uTime;
uniform float uCloudDetail;
varying vec3 vDir;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= uCloudDetail) break;
    v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5;
  }
  return v;
}
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 zenith = srgb(vec3(0.075, 0.27, 0.58));
  vec3 mid = srgb(vec3(0.20, 0.52, 0.85));
  vec3 horizon = srgb(vec3(0.68, 0.82, 0.93));
  vec3 below = srgb(vec3(0.42, 0.52, 0.55));
  vec3 col = h > 0.0 ? mix(mix(horizon, mid, smoothstep(0.0, 0.22, h)), zenith, smoothstep(0.18, 0.85, h)) : mix(horizon, below, smoothstep(0.0, -0.15, h));
  float sd = max(dot(d, uSunDir), 0.0);
  // warm haze around the sun + horizon
  col += srgb(vec3(1.0, 0.78, 0.5)) * (pow(sd, 6.0) * 0.35 + pow(sd, 64.0) * 0.6) * (0.6 + 0.4 * (1.0 - abs(h)));
  // clouds (planar projection)
  if (h > 0.0) {
    vec2 uv = d.xz / (h + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
    float n = fbm(uv);
    float cov = smoothstep(0.50, 0.78, n);
    float thick = smoothstep(0.5, 0.95, n);
    vec3 cLit = srgb(vec3(1.0, 0.97, 0.92)) * 1.25;
    vec3 cShade = srgb(vec3(0.62, 0.70, 0.82));
    float lit = clamp(0.55 + 0.45 * (fbm(uv + uSunDir.xz * 0.06) - n) * 6.0, 0.0, 1.0);
    vec3 cc = mix(cShade, cLit, lit) + srgb(vec3(1.0, 0.8, 0.6)) * pow(sd, 8.0) * 0.6;
    float fade = smoothstep(0.02, 0.25, h);
    col = mix(col, cc, cov * fade * (0.55 + 0.45 * thick));
  }
  // sun disc
  col += srgb(vec3(1.0, 0.95, 0.85)) * smoothstep(0.9993, 0.9997, sd) * 18.0;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createSky(sunDir, radius = 1800) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: sunDir.clone() }, uTime: { value: 0 }, uCloudDetail: { value: 6 } },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 100; // after the other opaques: early-z skips covered pixels
  mesh.name = 'sky';
  return mesh;
}

// Distant scenery: mountain range, green hills and a skyline cluster, one mesh
// with vertex colours already blended towards the haze colour.
export function createScenery() {
  const R = rng(4242);
  const pos = [], col = [], idx = [];
  const haze = new THREE.Color(0xa9c6dc);
  const push = (x, y, z, c) => { pos.push(x, y, z); col.push(c.r, c.g, c.b); return pos.length / 3 - 1; };
  const tmp = new THREE.Color();
  // ring silhouette: N segments, heights from layered noise
  const ring = (radius, base, amp, seg, cLow, cHigh, hazeAmt, snow, seed) => {
    const r2 = rng(seed);
    const ph = [r2() * 6, r2() * 6, r2() * 6];
    const hs = [];
    for (let i = 0; i <= seg; i++) {
      const a = i / seg * Math.PI * 2;
      let h = Math.sin(a * 2 + ph[0]) * 0.35 + Math.sin(a * 5 + ph[1]) * 0.25 + Math.sin(a * 11 + ph[2]) * 0.12 + (r2() - 0.5) * 0.12;
      h = base + amp * Math.max(0.05, 0.5 + h);
      hs.push(h);
    }
    // a few dominant peaks
    for (let p = 0; p < 3; p++) {
      const c = Math.floor(r2() * seg), w = 6 + Math.floor(r2() * 6), peak = amp * (1.2 + r2());
      for (let k = -w; k <= w; k++) { const i = (c + k + seg) % seg; hs[i] = Math.max(hs[i], base + peak * (1 - Math.abs(k) / (w + 1))); }
    }
    hs[seg] = hs[0];
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
      const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius, x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
      const lowC = tmp.copy(cLow).lerp(haze, hazeAmt).clone();
      const top0 = tmp.copy(cHigh).lerp(haze, hazeAmt * 0.8).clone();
      const sn0 = snow && hs[i] > base + amp * 1.05 ? new THREE.Color(0xeef3f8).lerp(haze, 0.35) : top0;
      const sn1 = snow && hs[i + 1] > base + amp * 1.05 ? new THREE.Color(0xeef3f8).lerp(haze, 0.35) : top0;
      const a = push(x0, -30, z0, lowC), b = push(x1, -30, z1, lowC);
      const c = push(x1, hs[i + 1], z1, sn1), d = push(x0, hs[i], z0, sn0);
      idx.push(a, c, b, a, d, c);
    }
  };
  ring(1500, 20, 150, 160, new THREE.Color(0x4d6378), new THREE.Color(0x7d8fa3), 0.55, true, 11);
  ring(1100, 0, 45, 120, new THREE.Color(0x2f4a2c), new THREE.Color(0x4a6a3a), 0.35, false, 23);
  // (glass skyscrapers live in skyline.js)
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
  m.name = 'scenery';
  m.frustumCulled = false;
  return m;
}
