// Stadium around the arena: two-tier stand bowl (rounded rectangle), LED
// ribbons, roof canopy with floodlight banks + glow sprites, instanced crowd
// (shader-drawn silhouettes, subtle idle motion, cheering on goals).
import * as THREE from 'three';
import { rng, makeSeatTexture, makeFasciaTexture, makePanelTexture } from './textures.js';
import { setColor, setEmis, vertexEmissive, merge } from './matUtil.js';

const S = 0.01;
// rounded-rectangle footprint of the stand bowl (sim uu)
export const BOWL = { A: 4800, B: 6550, R: 2600 };
// cross-section (offset from the bowl footprint outward, height z), sim uu
const SEC = {
  front: [[0, 0], [0, 760]],
  walk1: [[0, 760], [150, 760]],
  lower: [[150, 760], [2250, 2050]],
  rib2: [[2250, 2050], [2250, 2450]],
  walk2: [[2250, 2450], [2400, 2450]],
  upper: [[2400, 2450], [4300, 3700]],
  back: [[4300, 3700], [4300, 4700]],
  roofTop: [[4400, 4800], [900, 5350]],
  roofEdge: [[900, 5350], [900, 5080]],
  roofUnder: [[900, 5080], [4400, 4600]],
};
const ROW_DEPTH = 87.5;
// conservative outer bounds of the stadium structure (sim uu), for shadow fitting
export const STADIUM_EXTENT = { x: 4800 + 4500, y: 6550 + 4500, z: 5400 };

// Path along the bowl footprint (CCW), with outward normals and arc length.
function bowlPath(cornerSegs = 18, straightStep = 1400) {
  const { A, B, R } = BOWL;
  const pts = [];
  const cx = A - R, cy = B - R;
  const centres = [[cx, cy, 0], [-cx, cy, Math.PI / 2], [-cx, -cy, Math.PI], [cx, -cy, Math.PI * 1.5]];
  for (let c = 0; c < 4; c++) {
    const [ox, oy, a0] = centres[c];
    for (let i = 0; i <= cornerSegs; i++) {
      const a = a0 + (i / cornerSegs) * (Math.PI / 2);
      pts.push({ x: ox + R * Math.cos(a), y: oy + R * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
    }
    // straight to the next corner start
    const [nx0, ny0, na0] = centres[(c + 1) % 4];
    const sx = ox + R * Math.cos(a0 + Math.PI / 2), sy = oy + R * Math.sin(a0 + Math.PI / 2);
    const ex = nx0 + R * Math.cos(na0), ey = ny0 + R * Math.sin(na0);
    const len = Math.hypot(ex - sx, ey - sy);
    const n = Math.max(1, Math.round(len / straightStep));
    const nrm = [Math.cos(a0 + Math.PI / 2), Math.sin(a0 + Math.PI / 2)];
    for (let k = 1; k < n; k++) pts.push({ x: sx + (ex - sx) * k / n, y: sy + (ey - sy) * k / n, nx: nrm[0], ny: nrm[1] });
  }
  pts.push({ ...pts[0] }); // closed
  return pts;
}

function strip(pts, sec, pos, uv, nrm, idx, uScale, vScale) {
  // one surface strip of the cross-section swept along the path
  const [[d0, z0], [d1, z1]] = sec;
  const base = pos.length / 3;
  const secLen = Math.hypot(d1 - d0, z1 - z0);
  let s0 = 0, s1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i) {
      const q = pts[i - 1];
      s0 += Math.hypot((p.x + p.nx * d0) - (q.x + q.nx * d0), (p.y + p.ny * d0) - (q.y + q.ny * d0));
      s1 += Math.hypot((p.x + p.nx * d1) - (q.x + q.nx * d1), (p.y + p.ny * d1) - (q.y + q.ny * d1));
    }
    pos.push((p.x + p.nx * d0) * S, z0 * S, (p.y + p.ny * d0) * S);
    pos.push((p.x + p.nx * d1) * S, z1 * S, (p.y + p.ny * d1) * S);
    uv.push(s0 / uScale, 0, s1 / uScale, secLen / vScale);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
}

function buildStrips(pts, list) {
  const pos = [], uv = [], idx = [];
  for (const [sec, us, vs] of list) strip(pts, sec, pos, uv, null, idx, us, vs);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ crowd
const CROWD_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec3 iCol;
attribute vec4 iRnd;
uniform float uTime;
uniform float uExcite;
varying vec2 vL;
varying vec3 vCol;
varying vec4 vRnd;
varying vec2 vSize;
#include <fog_pars_vertex>
void main() {
  vec3 toCam = cameraPosition - iPos;
  vec2 dir = normalize(toCam.xz + vec2(1e-4));
  vec3 right = vec3(dir.y, 0.0, -dir.x);
  float h = 0.92 * (0.88 + 0.24 * iRnd.y);
  float w = 0.62 * (0.9 + 0.2 * iRnd.y);
  float hop = max(0.0, sin(uTime * (6.0 + iRnd.x * 3.0) + iRnd.x * 40.0));
  float bob = hop * hop * uExcite * (0.22 + 0.2 * iRnd.w) + sin(uTime * (1.1 + iRnd.y) + iRnd.x * 30.0) * 0.02;
  vec3 p = iPos + right * (position.x * w) + vec3(0.0, position.y * h + bob, 0.0);
  vL = vec2(position.x * w, position.y * h);
  vSize = vec2(w, h);
  vCol = iCol;
  vRnd = iRnd;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const CROWD_FRAG = /* glsl */`
uniform vec3 uLight;
uniform float uExcite;
uniform float uTime;
varying vec2 vL;
varying vec3 vCol;
varying vec4 vRnd;
varying vec2 vSize;
#include <fog_pars_fragment>
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  float h = vSize.y;
  vec2 p = vL;
  // head
  float head = length(p - vec2(0.0, h - 0.16)) - 0.12;
  // torso with rounded shoulders
  float body = sdBox(p - vec2(0.0, (h - 0.27) * 0.5), vec2(0.21, (h - 0.27) * 0.5), 0.09);
  float d = min(head, body);
  // raised arms when cheering
  float arms = 1e3;
  if (vRnd.w * uExcite > 0.3) {
    float wave = sin(uTime * 7.0 + vRnd.x * 20.0) * 0.05;
    arms = min(sdBox(p - vec2(-0.24 + wave, h - 0.12), vec2(0.045, 0.2), 0.04), sdBox(p - vec2(0.24 + wave, h - 0.12), vec2(0.045, 0.2), 0.04));
    d = min(d, arms);
  }
  if (d > 0.0) discard;
  vec3 skin = mix(vec3(0.95, 0.72, 0.55), vec3(0.35, 0.22, 0.14), vRnd.z);
  skin = pow(skin, vec3(2.2));
  vec3 c = (head < 0.0 || arms < 0.0 && p.y > h - 0.1) ? skin : vCol;
  if (head < 0.0 && p.y > h - 0.1 && vRnd.y > 0.45) c = pow(vec3(0.12, 0.08, 0.05) + vRnd.z * 0.15, vec3(2.2)); // hair
  float shade = 0.55 + 0.45 * smoothstep(0.0, h, p.y);
  shade *= 0.8 + 0.4 * fract(vRnd.x * 13.7);
  gl_FragColor = vec4(c * uLight * shade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function buildCrowd(path, quality) {
  const R = rng(2024);
  const items = [];
  const palette = [0xc8c8c8, 0x2a2a2e, 0xb83a34, 0xd8b040, 0x3d8a4e, 0x6e4f9a, 0x3a8f9c, 0xc06a98, 0x5e4a3a, 0x4060b8, 0xd88040, 0x8a9098]
    .map((h) => new THREE.Color(h));
  const blue = [new THREE.Color(0x1f6bff), new THREE.Color(0x2f8cff), new THREE.Color(0x103a9a)];
  const orange = [new THREE.Color(0xff7a14), new THREE.Color(0xffa040), new THREE.Color(0xc75008)];
  const tiers = [SEC.lower, SEC.upper];
  // per-path cumulative lengths for spacing along each row
  for (const [[d0, z0], [d1, z1]] of tiers) {
    for (let d = d0 + ROW_DEPTH * 0.5; d < d1 - 20; d += ROW_DEPTH) {
      const z = z0 + (d - d0) / (d1 - d0) * (z1 - z0);
      // walk the path at offset d, place people every ~78 uu
      let carry = R() * 78;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const ax = a.x + a.nx * d, ay = a.y + a.ny * d, bx = b.x + b.nx * d, by = b.y + b.ny * d;
        const len = Math.hypot(bx - ax, by - ay);
        let t = carry;
        while (t < len) {
          if (R() < 0.9) {
            const f = t / len;
            const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
            const endBias = y / 6500; // -1 blue end .. +1 orange end
            let c;
            const r = R();
            if (endBias < -0.3 && r < 0.68) c = blue[(R() * 3) | 0];
            else if (endBias > 0.3 && r < 0.68) c = orange[(R() * 3) | 0];
            else if (r < 0.35) c = (R() < 0.5 + endBias * 0.6 ? orange : blue)[(R() * 3) | 0];
            else c = palette[(R() * palette.length) | 0];
            items.push([x + (R() - 0.5) * 14, y + (R() - 0.5) * 14, z + 8, c, R(), R(), R(), R()]);
          }
          t += 70 + R() * 16;
        }
        carry = t - len;
      }
    }
  }
  // shuffle so that reducing the instance count thins the crowd uniformly
  for (let i = items.length - 1; i > 0; i--) { const j = (R() * (i + 1)) | 0; const t = items[i]; items[i] = items[j]; items[j] = t; }
  const n = items.length;
  const iPos = new Float32Array(n * 3), iCol = new Float32Array(n * 3), iRnd = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    iPos[i * 3] = it[0] * S; iPos[i * 3 + 1] = it[2] * S; iPos[i * 3 + 2] = it[1] * S;
    const c = it[3].clone().multiplyScalar(0.8 + 0.25 * it[4]);
    iCol[i * 3] = c.r; iCol[i * 3 + 1] = c.g; iCol[i * 3 + 2] = c.b;
    iRnd[i * 4] = it[4]; iRnd[i * 4 + 1] = it[5]; iRnd[i * 4 + 2] = it[6]; iRnd[i * 4 + 3] = it[7];
  }
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.attributes.position);
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
  g.setAttribute('iCol', new THREE.InstancedBufferAttribute(iCol, 3));
  g.setAttribute('iRnd', new THREE.InstancedBufferAttribute(iRnd, 4));
  g.instanceCount = Math.round(n * quality);
  g.userData.total = n;
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uExcite: { value: 0.1 }, uLight: { value: new THREE.Color(0.4, 0.41, 0.46) } }]),
    vertexShader: CROWD_VERT, fragmentShader: CROWD_FRAG, fog: true,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.name = 'crowd';
  return mesh;
}

// ------------------------------------------------------------------ glow sprites
const GLOW_VERT = /* glsl */`
attribute float aSize;
uniform float uScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(-mv.z, 1.0);
  gl_Position = projectionMatrix * mv;
}`;
const GLOW_FRAG = /* glsl */`
uniform vec3 uColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  if (r > 1.0) discard;
  float a = exp(-r * 5.0) * 0.9 + exp(-r * 40.0) * 0.6;
  gl_FragColor = vec4(uColor * a, 1.0);
  #include <colorspace_fragment>
}`;

export function createStadium(ctx) {
  const renderer = ctx.renderer;
  const group = new THREE.Group();
  group.name = 'stadium';
  const path = bowlPath();
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  // structure (concrete)
  // structure (concrete) + roof canopy share one mesh (colour/emissive per vertex)
  const structGeo = buildStrips(path, [[SEC.front, 1000, 1000], [SEC.walk1, 1000, 1000], [SEC.walk2, 1000, 1000], [SEC.back, 1000, 1000]]);
  const roofGeo = buildStrips(path, [[SEC.roofTop, 1000, 1000], [SEC.roofEdge, 1000, 1000], [SEC.roofUnder, 1000, 1000]]);
  setEmis(setColor(structGeo, new THREE.Color(0x7d838f)), new THREE.Color(0, 0, 0));
  setEmis(setColor(roofGeo, new THREE.Color(0xf4e2dc)), new THREE.Color(0x6a6c74));
  const shellGeo = track(merge([structGeo, roofGeo]));
  structGeo.dispose(); roofGeo.dispose();
  const panelTex = track(makePanelTexture(renderer));
  const shellMat = track(vertexEmissive(new THREE.MeshStandardMaterial({ map: panelTex, vertexColors: true, roughness: 0.88, metalness: 0.0, side: THREE.DoubleSide, envMapIntensity: 0.15 }), 'stadiumShell'));
  const shellMesh = new THREE.Mesh(shellGeo, shellMat); shellMesh.castShadow = true;
  shellMesh.name = 'stadiumStructure';
  group.add(shellMesh);
  const structMat = track(new THREE.MeshStandardMaterial({ color: 0x7d838f, roughness: 0.92, metalness: 0.05 }));

  // seating tiers
  const seatTex = track(makeSeatTexture(renderer));
  const seatGeo = track(buildStrips(path, [[SEC.lower, 256, ROW_DEPTH * 8 * 1.18], [SEC.upper, 256, ROW_DEPTH * 8 * 1.18]]));
  const seatMat = track(new THREE.MeshStandardMaterial({ map: seatTex, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide }));
  const seatMesh = new THREE.Mesh(seatGeo, seatMat); seatMesh.castShadow = true;
  group.add(seatMesh);

  // LED ribbons (front fascia above the arena wall + mid-tier ribbon)
  const ribTex = track(makeFasciaTexture(renderer));
  // negative u scale: the path runs CCW in sim space, which is mirrored in three space
  const ribGeo = track(buildStrips(path, [[[[0, 520], [0, 760]], 8192, 240], [[[2250, 2120], [2250, 2420]], 8192, 300]]));
  const ribMat = track(new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffffff, emissiveMap: ribTex, emissiveIntensity: 1.1, roughness: 0.6, side: THREE.DoubleSide }));
  const rib = new THREE.Mesh(ribGeo, ribMat); rib.renderOrder = 1;
  // ribbons sit 1 uu in front of the structure faces (offset slightly inward)
  rib.scale.set(0.9995, 1, 0.9995);
  group.add(rib);

  // roof canopy

  // roof support pylons (instanced boxes from the back wall up to the roof)
  const pylonGeo = track(new THREE.BoxGeometry(1.4, 1, 1.4));
  const pylons = [];
  for (let i = 0; i < path.length - 1; i += 3) pylons.push(path[i]);
  const pylonMesh = new THREE.InstancedMesh(pylonGeo, structMat, pylons.length);
  const dummy = new THREE.Object3D();
  pylons.forEach((p, i) => {
    dummy.position.set((p.x + p.nx * 4350) * S, 47.5, (p.y + p.ny * 4350) * S);
    dummy.scale.set(1, 15, 1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
    pylonMesh.setMatrixAt(i, dummy.matrix);
  });
  group.add(pylonMesh);

  // floodlight banks along the roof's inner edge, angled down to the pitch
  const lamps = [];
  {
    let acc = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const ax = a.x + a.nx * 900, ay = a.y + a.ny * 900, bx = b.x + b.nx * 900, by = b.y + b.ny * 900;
      const len = Math.hypot(bx - ax, by - ay);
      let t = acc;
      while (t < len) {
        const f = t / len;
        const nx = a.nx + (b.nx - a.nx) * f, ny = a.ny + (b.ny - a.ny) * f, nl = Math.hypot(nx, ny);
        lamps.push({ x: ax + (bx - ax) * f, y: ay + (by - ay) * f, nx: nx / nl, ny: ny / nl });
        t += 1250;
      }
      acc = t - len;
    }
  }
  const lampGeo = track(new THREE.BoxGeometry(3.6, 1.2, 0.5));
  const lampMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.95, 0.82).multiplyScalar(5) }));
  const lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, lamps.length);
  const glowPos = new Float32Array(lamps.length * 3), glowSize = new Float32Array(lamps.length);
  lamps.forEach((l, i) => {
    const x = (l.x - l.nx * 40) * S, y = 50.5, z = (l.y - l.ny * 40) * S;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, 0, 0);
    dummy.lookAt(x - l.nx, y - 0.9, z - l.ny); // face the pitch, tilted down
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    lampMesh.setMatrixAt(i, dummy.matrix);
    glowPos[i * 3] = x - l.nx * 0.5; glowPos[i * 3 + 1] = y - 0.3; glowPos[i * 3 + 2] = z - l.ny * 0.5;
    glowSize[i] = 520;
  });
  group.add(lampMesh);
  const glowGeo = track(new THREE.BufferGeometry());
  glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPos, 3));
  glowGeo.setAttribute('aSize', new THREE.BufferAttribute(glowSize, 1));
  const glowMat = track(new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 }, uColor: { value: new THREE.Color(1.0, 0.88, 0.65).multiplyScalar(0.55) } },
    vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const glows = new THREE.Points(glowGeo, glowMat);
  glows.frustumCulled = false;
  glows.renderOrder = 5;
  group.add(glows);

  // outer ground
  const groundGeo = track(new THREE.CircleGeometry(900, 48));
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = track(new THREE.MeshStandardMaterial({ color: 0x4a4d53, roughness: 1 })); // concourse / plaza
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.y = -0.3;
  group.add(ground);

  // crowd
  let crowd = buildCrowd(path, ctx.quality.crowd ?? 1);
  group.add(crowd);
  track(crowd.geometry); track(crowd.material);

  let time = 0, excite = 0.1;
  return {
    object3d: group,
    update(view, dt, camera) {
      time += dt;
      const m = view && view.match;
      const target = m && (m.state === 'goal' || m.state === 'ended') ? 1.0 : (m && m.state === 'countdown' ? 0.35 : 0.12);
      excite += (target - excite) * Math.min(1, dt * 2.5);
      crowd.material.uniforms.uTime.value = time;
      crowd.material.uniforms.uExcite.value = excite;
      // point size scale: pixels per metre at distance 1
      const h = renderer.domElement.height;
      const fov = camera ? camera.fov : 70;
      glowMat.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) * 0.01;
    },
    setCrowd(q) { crowd.geometry.instanceCount = Math.round(crowd.geometry.userData.total * q); crowd.visible = q > 0; },
    setDetail(level) { pylonMesh.visible = level > 0; glows.visible = level > 0; },
    dispose() { for (const d of disposables) d.dispose && d.dispose(); lampMesh.dispose(); pylonMesh.dispose(); },
  };
}
