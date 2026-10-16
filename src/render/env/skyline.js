// Stadium skyline (original): a transparent hexagon-glass dome over the whole stadium, two giant
// steel arches with light bars spanning the ends, strings of flags across the sky and a ring of
// glass skyscrapers with horizontal light bands — the big-stadium silhouette above the stands.
import * as THREE from 'three';
import { rng } from './textures.js';
import { BOWL } from './stadium.js';

const S = 0.01;

// ---------------------------------------------------------------- hex glass dome
const DOME_VERT = /* glsl */`
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const DOME_FRAG = /* glsl */`
uniform float uCell;
uniform vec3 uLine;
uniform float uAlpha;
varying vec3 vWorld;
varying vec3 vNormalW;
// distance to the nearest hexagon edge (cells of size 1, edge at 0)
float hexEdge(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
  vec2 q = dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw;
  q = abs(q);
  return 0.5 - max(dot(q, s * 0.5), q.x);
}
void main() {
  // top-down projection on the cap, cylindrical on the steep rim
  vec2 pTop = vWorld.xz / uCell;
  vec2 pSide = vec2(atan(vWorld.z, vWorld.x) * 18.0, vWorld.y / uCell);
  float up = smoothstep(0.35, 0.75, abs(vNormalW.y));
  float e = mix(hexEdge(pSide), hexEdge(pTop), up);
  float w = fwidth(e);
  float line = 1.0 - smoothstep(0.0, w * 1.2 + 0.002, e);
  gl_FragColor = vec4(uLine, uAlpha * line + 0.025);
}`;

function buildDome() {
  // a cap lofted from the stadium footprint: starts above the outer roof ring, rises to a shallow peak
  const { A, B, R } = BOWL;
  const ring = [];
  const seg = 18;
  const corner = (cx, cy, a0) => { for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * Math.PI / 2; ring.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]); } };
  corner(A - R, B - R, 0); corner(-(A - R), B - R, Math.PI / 2); corner(-(A - R), -(B - R), Math.PI); corner(A - R, -(B - R), Math.PI * 1.5);
  const OUT = 4500;           // footprint grows to the stand's back wall
  const rows = 14;
  const pos = [], idx = [];
  const n = ring.length;
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    const k = 1 - t * 0.985;
    const z = 4950 + (9800 - 4950) * Math.sin(t * Math.PI / 2);
    for (let i = 0; i < n; i++) {
      const [x, y] = ring[i];
      const l = Math.hypot(x, y) || 1;
      const ox = x + (x / l) * OUT, oy = y + (y / l) * OUT;
      pos.push(ox * k * S, z * S, oy * k * S);
    }
  }
  for (let r = 0; r < rows; r++) for (let i = 0; i < n; i++) {
    const a = r * n + i, b = r * n + (i + 1) % n, c = (r + 1) * n + (i + 1) % n, d = (r + 1) * n + i;
    idx.push(a, b, c, a, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.ShaderMaterial({
    uniforms: { uCell: { value: 13 }, uLine: { value: new THREE.Color(0xd8ecff) }, uAlpha: { value: 0.17 } },
    vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  m.extensions = { derivatives: true };
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'glassDome';
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------- giant arches
// elliptical arch in a vertical plane at sim y = yPlane, spanning x in [-L, L] with peak height H
function archPoint(L, H, yPlane, t) { // t in [0, 1]
  const a = Math.PI * (1 - t);
  return [Math.cos(a) * L, yPlane, Math.sin(a) * H];
}
function buildArches() {
  const steel = [], lamps = [];
  const L = 11200, H = 10600, W = 520, T = 360; // uu
  const NSEG = 64;
  for (const yPlane of [-9300, 9300]) {
    const inward = -Math.sign(yPlane); // lamps face the pitch
    for (const off of [0, inward * 900]) { // main box beam + a slimmer partner beam
      const w = off ? W * 0.45 : W, th = off ? T * 0.55 : T;
      const pts = [];
      for (let i = 0; i <= NSEG; i++) pts.push(archPoint(L - (off ? 350 : 0), H - (off ? 450 : 0), yPlane + off, i / NSEG));
      steel.push({ pts, w, th });
    }
    // light bars on the main beam's underside
    for (let i = 4; i < NSEG - 3; i += 2) {
      const p = archPoint(L, H, yPlane, i / NSEG);
      lamps.push({ p, inward });
    }
  }
  // sweep a rectangular section along each curve
  const pos = [], idx = [];
  for (const { pts, w, th } of steel) {
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
      const tx = q[0] - o[0], tz = q[2] - o[2], tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl; // in-plane normal (towards the arch centre)
      const corners = [[-w / 2, -th / 2], [w / 2, -th / 2], [w / 2, th / 2], [-w / 2, th / 2]];
      for (const [dy, dn] of corners) pos.push((p[0] + nx * dn) * S, (p[2] + nz * dn) * S, (p[1] + dy) * S);
    }
    for (let i = 0; i < pts.length - 1; i++) for (let f = 0; f < 4; f++) {
      const a = base + i * 4 + f, b = base + i * 4 + (f + 1) % 4, c = base + (i + 1) * 4 + (f + 1) % 4, d = base + (i + 1) * 4 + f;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.5, metalness: 0.55, side: THREE.DoubleSide, envMapIntensity: 0.8 });
  const arches = new THREE.Mesh(g, mat);
  arches.name = 'arches';
  // lamp bars (instanced, bright)
  const lampGeo = new THREE.BoxGeometry(4.2, 0.5, 1.1);
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.96, 0.86).multiplyScalar(4) });
  const lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, lamps.length);
  const dummy = new THREE.Object3D();
  lamps.forEach(({ p }, i) => {
    const t = Math.atan2(p[2] / 10600, p[0] / 11200);
    dummy.position.set(p[0] * S, (p[2] - 230) * S, p[1] * S);
    dummy.rotation.set(0, 0, t - Math.PI / 2);
    dummy.updateMatrix();
    lampMesh.setMatrixAt(i, dummy.matrix);
  });
  const group = new THREE.Group();
  group.add(arches, lampMesh);
  return { group, disposables: [g, mat, lampGeo, lampMat, lampMesh], H, L };
}

// ---------------------------------------------------------------- flags on cables
function makeFlagAtlas() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  const cols = ['#d62828', '#ffffff', '#1d3fbb', '#f7c600', '#1f8a3a', '#111111', '#ff8a1f', '#5bc0eb', '#8b1e3f', '#2a9d8f'];
  const R = rng(99);
  for (let k = 0; k < 16; k++) {
    const x = (k % 8) * 64, y = Math.floor(k / 8) * 64;
    const pick = () => cols[Math.floor(R() * cols.length)];
    const a = pick(), b = pick(), d = pick();
    const style = k % 5;
    g.fillStyle = a; g.fillRect(x, y, 64, 64);
    g.fillStyle = b;
    if (style === 0) g.fillRect(x + 21, y, 22, 64);                       // vertical tricolour
    else if (style === 1) g.fillRect(x, y + 21, 64, 22);                  // horizontal tricolour
    else if (style === 2) { g.fillRect(x + 18, y, 12, 64); g.fillRect(x, y + 26, 64, 12); } // cross
    else if (style === 3) { g.fillRect(x, y + 32, 64, 32); }              // bicolour
    else { g.beginPath(); g.arc(x + 32, y + 32, 14, 0, Math.PI * 2); g.fill(); } // disc
    g.fillStyle = d;
    if (style === 0) g.fillRect(x + 43, y, 21, 64);
    if (style === 1) g.fillRect(x, y + 43, 64, 21);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function buildFlags(L, H) {
  // cables between the two arches, sagging over the pitch; flags hang every few metres
  const cables = [];
  for (const fx of [-0.62, -0.25, 0.25, 0.62]) {
    const x = fx * L;
    const zEnd = Math.sqrt(1 - fx * fx) * H - 300;
    cables.push({ x, zEnd });
  }
  const R = rng(7);
  const pos = [], uv = [], idx = [], linePos = [];
  const FW = 330, FH = 230, STEP = 520, Y0 = 9300;
  for (const { x, zEnd } of cables) {
    const sag = 2600;
    const zAt = (y) => zEnd - sag * (1 - (y / Y0) ** 2);
    for (let y = -Y0; y < Y0; y += 300) linePos.push(x * S, zAt(y) * S, y * S, x * S, zAt(y + 300) * S, (y + 300) * S);
    for (let y = -Y0 + STEP; y < Y0 - STEP / 2; y += STEP) {
      const k = Math.floor(R() * 16), u0 = (k % 8) / 8, v0 = 1 - Math.floor(k / 8) * 0.5;
      const z0 = zAt(y), base = pos.length / 3;
      // quad in the y-z plane hanging below the cable, slightly angled for variety
      const tilt = (R() - 0.5) * 60;
      pos.push(x * S, z0 * S, (y - FW / 2) * S, x * S, z0 * S, (y + FW / 2) * S,
        (x + tilt) * S, (z0 - FH) * S, (y + FW / 2) * S, (x + tilt) * S, (z0 - FH) * S, (y - FW / 2) * S);
      uv.push(u0, v0, u0 + 1 / 8, v0, u0 + 1 / 8, v0 - 0.5, u0, v0 - 0.5);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const tex = makeFlagAtlas();
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, fog: false });
  const flags = new THREE.Mesh(g, mat);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
  const lm = new THREE.LineBasicMaterial({ color: 0x1b2028 });
  const lines = new THREE.LineSegments(lg, lm);
  const group = new THREE.Group();
  group.add(flags, lines);
  flags.frustumCulled = false; lines.frustumCulled = false;
  return { group, disposables: [g, mat, tex, lg, lm] };
}

// ---------------------------------------------------------------- glass skyscrapers
function makeTowerTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 128, 0);
  grd.addColorStop(0, '#2f5f9c'); grd.addColorStop(0.5, '#6f9fd6'); grd.addColorStop(1, '#244f88');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 256);
  const R = rng(31);
  // floors: thin dark seams, every few floors a bright light band
  for (let y = 0; y < 256; y += 8) {
    g.fillStyle = 'rgba(30,50,80,0.35)'; g.fillRect(0, y, 128, 1);
    if ((y / 8) % 4 === 0) { g.fillStyle = `rgba(255,255,255,${0.55 + R() * 0.35})`; g.fillRect(0, y + 3, 128, 2); }
  }
  // vertical mullions
  for (let x = 0; x < 128; x += 16) { g.fillStyle = 'rgba(40,60,90,0.3)'; g.fillRect(x, 0, 1, 256); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
function buildTowers() {
  const R = rng(4242);
  const geos = [];
  const place = (ang, dist, w, h, sides) => {
    const geo = new THREE.CylinderGeometry(w * 0.82, w, h, sides, 1, false, Math.PI / sides);
    geo.translate(Math.cos(ang) * dist, h / 2 - 20, Math.sin(ang) * dist);
    // texture repeats: around ~ every 40 m, up ~ every 64 m
    const uvA = geo.attributes.uv;
    const circ = 2 * Math.PI * w;
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * circ / 40, uvA.getY(i) * h / 64);
    geos.push(geo);
  };
  // clusters behind both ends and a few on the sides (three units = metres)
  for (let i = 0; i < 22; i++) {
    const end = i % 2 ? 1 : -1;
    const side = i % 4 < 2;
    const ang = side ? (end > 0 ? 0 : Math.PI) + (R() - 0.5) * 0.9 : (end > 0 ? Math.PI / 2 : -Math.PI / 2) + (R() - 0.5) * 1.3;
    const dist = 330 + R() * 330;
    place(ang, dist, 16 + R() * 18, 180 + R() * 260, R() < 0.5 ? 6 : 8);
  }
  const merged = mergeGeos(geos);
  geos.forEach((g) => g.dispose());
  const tex = makeTowerTexture();
  const mat = new THREE.MeshBasicMaterial({ map: tex, fog: false });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = 'skyscrapers';
  mesh.frustumCulled = false;
  return { mesh, disposables: [merged, tex, mat] };
}
function mergeGeos(geos) {
  let nPos = 0, nIdx = 0;
  for (const g of geos) { nPos += g.attributes.position.count; nIdx += g.index.count; }
  const pos = new Float32Array(nPos * 3), uv = new Float32Array(nPos * 2), idx = new Uint32Array(nIdx);
  let po = 0, io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, po * 3);
    uv.set(g.attributes.uv.array, po * 2);
    const ia = g.index.array;
    for (let i = 0; i < ia.length; i++) idx[io + i] = ia[i] + po;
    po += g.attributes.position.count; io += ia.length;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  m.setIndex(new THREE.BufferAttribute(idx, 1));
  return m;
}

// ---------------------------------------------------------------- public
export function createSkyline() {
  const group = new THREE.Group();
  group.name = 'skyline';
  const dome = buildDome();
  const arches = buildArches();
  const flags = buildFlags(arches.L, arches.H);
  const towers = buildTowers();
  group.add(towers.mesh, arches.group, flags.group, dome);
  const disposables = [dome.geometry, dome.material, ...arches.disposables, ...flags.disposables, ...towers.disposables];
  return {
    object3d: group,
    setDetail(level) { flags.group.visible = level > 0; },
    dispose() { for (const d of disposables) d.dispose && d.dispose(); },
  };
}
