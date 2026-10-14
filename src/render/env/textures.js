// Procedural textures for the arena (generated once at start-up, all original).
import * as THREE from 'three';
import { ARENA_PARAMS } from '../../sim/arena.js';
import { quadRing, V_LOWER } from './arenaMesh.js';
import { PAD_LOCS_BIG as BOOST_PADS_BIG, PAD_LOCS_SMALL as BOOST_PADS_SMALL } from '../../sim/const.js';

const { X, Y, RF, GW } = ARENA_PARAMS;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d') };
}

// deterministic PRNG
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function finish(tex, renderer, { srgb = true, repeat = false, aniso = true } = {}) {
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; }
  if (aniso && renderer) tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

// draw text scaled to fit maxW
function fitText(g, text, x, y, maxW, size, weight = 'bold') {
  g.font = `${weight} ${size}px Arial, Helvetica, sans-serif`;
  const w = g.measureText(text).width;
  if (w > maxW) { size = Math.floor(size * maxW / w); g.font = `${weight} ${size}px Arial, Helvetica, sans-serif`; }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

export const TEAM_CSS = ['#2f78ff', '#ff7c1c'];
export const TEAM_PAINT = ['#2457c8', '#f27a1a']; // field paint
const PAINT_ALPHA = [1.0, 1.3]; // orange needs more coverage to not read as brown over green
export const TEAM_CSS_LIGHT = ['#7fb2ff', '#ffb36e'];

// ------------------------------------------------------------------ field
// Canvas covers x in [-X, X], y in [-Y, Y] at 4 uu / px. Drawing is done in sim
// units through a transform (y up = towards the orange goal = canvas top).
export function makeFieldTextures(renderer) {
  const PX = 4;
  const W = (2 * X) / PX, Hh = (2 * Y) / PX;
  const { c, g } = canvas(W, Hh);
  const R = rng(1337);
  const toSim = () => g.setTransform(1 / PX, 0, 0, -1 / PX, W / 2, Hh / 2);

  // --- turf base: checkerboard mowing squares + team-half tint
  g.setTransform(1, 0, 0, 1, 0, 0);
  toSim();
  const SQ = 1024, OX = SQ / 2; // half-square x offset: no light/dark seam on x = 0
  for (let ix = -5; ix < 5; ix++) {
    for (let iy = -5; iy < 5; iy++) {
      const light = ((ix + iy) & 1) === 0;
      const team = iy < 0 ? 0 : 1;
      let r = light ? 66 : 50, gg = light ? 118 : 94, b = light ? 53 : 42;
      if (team === 0) { r -= 3; b += 5; } else { r += 5; gg += 1; b -= 3; }
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(ix * SQ + OX, iy * SQ, SQ, SQ);
    }
  }
  // fine mowing stripes inside each square (alternating direction per square)
  g.globalAlpha = 0.025;
  for (let ix = -5; ix < 5; ix++) for (let iy = -5; iy < 5; iy++) {
    const horiz = ((ix + iy) & 1) === 0;
    for (let k = 0; k < 8; k += 2) {
      g.fillStyle = '#ffffff';
      if (horiz) g.fillRect(ix * SQ + OX, iy * SQ + k * 128, SQ, 128); else g.fillRect(ix * SQ + OX + k * 128, iy * SQ, 128, SQ);
    }
  }
  g.globalAlpha = 1;
  // low/medium-frequency mottling: tiny random canvases scaled up with smoothing
  // and overlaid (fast 2D-canvas primitives, no per-pixel JS loop)
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = true;
  g.globalCompositeOperation = 'overlay';
  for (const [mw, mh, alpha] of [[34, 42, 0.22], [150, 186, 0.1]]) {
    const m = canvas(mw, mh);
    const im = m.g.createImageData(mw, mh);
    for (let i = 0; i < mw * mh; i++) { const v = 128 + (R() - 0.5) * 120; im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
    m.g.putImageData(im, 0, 0);
    g.globalAlpha = alpha;
    g.drawImage(m.c, 0, 0, W, Hh);
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  toSim();

  const line = (w, col = 'rgba(255,255,255,0.92)') => { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'butt'; g.lineJoin = 'miter'; };
  const poly = (pts, close) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); if (close) g.closePath(); };

  // --- team colour zones (drawn under the white lines)
  for (const team of [0, 1]) {
    const s = team === 0 ? -1 : 1;
    const col = TEAM_PAINT[team];
    // diagonal chevron stripes inside the penalty box (pointing to midfield)
    g.save();
    g.beginPath();
    g.rect(-2500, s > 0 ? 3250 : -5120, 5000, 5120 - 3250);
    g.clip();
    const pa = PAINT_ALPHA[team];
    g.fillStyle = col; g.globalAlpha = 0.5 * pa;
    for (let k = -12; k < 12; k++) {
      const off = k * 420;
      for (const side of [-1, 1]) {
        g.beginPath();
        // band along direction (side, -s)
        const x0 = 0, y0 = s * 3250 + off * s;
        const dx = side, dy = s;
        const w = 100;
        g.moveTo(x0, y0); g.lineTo(x0 + dx * 4000, y0 + dy * 4000);
        g.lineTo(x0 + dx * 4000, y0 + dy * 4000 + s * w * 1.41); g.lineTo(x0, y0 + s * w * 1.41);
        g.closePath(); g.fill();
      }
    }
    g.restore();
    // solid goal area
    g.fillStyle = col; g.globalAlpha = Math.min(1, 0.55 * pa);
    g.fillRect(-1500, s > 0 ? 4250 : -5120, 3000, 870);
    // goal mouth strip
    g.globalAlpha = 0.95;
    g.fillRect(-GW, s > 0 ? 5040 : -5120, 2 * GW, 80);
    // corner stripe blocks along the side lines
    g.globalAlpha = 0.75;
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const y0 = s * (2350 + k * 260);
        g.fillRect(sx > 0 ? X - RF - 330 : -X + RF + 90, Math.min(y0, y0 + s * 170), 240, 170);
      }
    }
    // long thin team lines
    g.globalAlpha = 0.85;
    for (const sx of [-1, 1]) g.fillRect(sx * 1650 - 14, s > 0 ? 450 : -3250, 28, 2800);
    g.globalAlpha = 1;
  }

  // --- centre motif (original): a hexagon split along the halfway line into the
  // two team colours, ringed by two concentric dashed team-colour rings.
  const hexPts = (r) => { const p = []; for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; p.push([r * Math.cos(a), r * Math.sin(a)]); } return p; };
  for (const team of [0, 1]) {
    const s = team === 0 ? -1 : 1;
    g.save();
    g.beginPath(); g.rect(-2000, s > 0 ? 0 : -2000, 4000, 2000); g.clip();
    g.fillStyle = TEAM_PAINT[team]; g.globalAlpha = 0.85 * PAINT_ALPHA[team];
    poly(hexPts(360), true); g.fill();
    g.globalAlpha = 0.7 * PAINT_ALPHA[team];
    g.lineWidth = 44; g.strokeStyle = TEAM_PAINT[team];
    g.setLineDash([150, 90]);
    g.beginPath(); g.arc(0, 0, 560, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 26; g.setLineDash([60, 70]);
    g.beginPath(); g.arc(0, 0, 720, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    g.restore();
  }
  g.globalAlpha = 1;

  // --- white markings
  // boundary line: ring at u = RF + 70 (follows the octagon) incl. goal line
  {
    const q = quadRing(RF + 70);
    const quad = q.slice(0, q.length - 2);
    const pts = [];
    for (const p of quad) pts.push(p);
    for (let i = quad.length - 1; i >= 0; i--) pts.push([-quad[i][0], quad[i][1]]);
    for (let i = 0; i < quad.length; i++) pts.push([-quad[i][0], -quad[i][1]]);
    for (let i = quad.length - 1; i >= 0; i--) pts.push([quad[i][0], -quad[i][1]]);
    line(36); poly(pts, true); g.stroke();
  }
  line(36);
  poly([[-X + RF + 70, 0], [X - RF - 70, 0]]); g.stroke();
  g.beginPath(); g.arc(0, 0, 1000, 0, Math.PI * 2); g.stroke();
  line(20); poly(hexPts(375), true); g.stroke();
  for (const s of [-1, 1]) {
    line(32);
    // penalty box
    poly([[-2500, s * (5120 - RF - 70)], [-2500, s * 3250], [2500, s * 3250], [2500, s * (5120 - RF - 70)]]); g.stroke();
    // D arc (outside the box)
    const R0 = 2350, yc = s * 5120;
    const ang = Math.acos((5120 - 3250) / R0);
    g.beginPath();
    if (s > 0) g.arc(0, yc, R0, -Math.PI / 2 - ang, -Math.PI / 2 + ang); else g.arc(0, yc, R0, Math.PI / 2 - ang, Math.PI / 2 + ang);
    g.stroke();
    // goal area outline
    line(26);
    poly([[-1500, s * 5120], [-1500, s * 4250], [1500, s * 4250], [1500, s * 5120]]); g.stroke();
    // dashed lines across the field (like RL's broken lines)
    line(18, 'rgba(255,255,255,0.7)');
    g.setLineDash([140, 120]);
    poly([[-X + RF + 70, s * 2000], [X - RF - 70, s * 2000]]); g.stroke();
    g.setLineDash([]);
  }
  // pad markings
  for (const p of BOOST_PADS_SMALL) {
    g.fillStyle = 'rgba(20,40,20,0.18)'; g.beginPath(); g.arc(p[0], p[1], 125, 0, Math.PI * 2); g.fill();
    line(10, 'rgba(255,255,255,0.4)'); g.beginPath(); g.arc(p[0], p[1], 125, 0, Math.PI * 2); g.stroke();
  }
  for (const p of BOOST_PADS_BIG) {
    g.fillStyle = 'rgba(30,30,20,0.35)'; g.beginPath(); g.arc(p[0], p[1], 260, 0, Math.PI * 2); g.fill();
    line(18, 'rgba(255,214,90,0.7)'); g.beginPath(); g.arc(p[0], p[1], 260, 0, Math.PI * 2); g.stroke();
  }

  const map = finish(new THREE.CanvasTexture(c), renderer);
  return { map };
}

// Tileable grass detail (greyscale around 0.5), sampled at high frequency in the floor shader.
export function makeGrassDetail(renderer) {
  const N = 256;
  const { c, g } = canvas(N, N);
  const img = g.createImageData(N, N);
  const R = rng(99);
  const base = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) base[i] = R();
  // blades: short vertical-ish streaks
  const val = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += base[((y + k) % N) * N + ((x + (k >> 1)) % N)];
    val[y * N + x] = v / 4;
  }
  for (let i = 0; i < N * N; i++) {
    const v = Math.round(255 * Math.max(0, Math.min(1, 0.5 + (val[i] - 0.5) * 1.6 + (base[i] - 0.5) * 0.35)));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(new THREE.CanvasTexture(c), renderer, { srgb: false, repeat: true });
}

// ------------------------------------------------------------------ lower wall
// One tile = 2048 uu along the wall (s) x V_LOWER (profile length, ramp + wall
// up to crossbar height). Returns {map, emissiveMap} for a team.
export const WALL_TILE = 2048;
function drawLowerWall(team) {
  const W = 1024, Hh = 400;
  const { c, g } = canvas(W, Hh);
  const e = canvas(W, Hh);
  const vy = (v) => Hh - (v / V_LOWER) * Hh; // canvas y for profile length v (v=0 at floor)
  const sx = (s) => (s / WALL_TILE) * W;
  const RAMP = Math.PI / 2 * RF; // 402
  const col = TEAM_CSS[team], light = TEAM_CSS_LIGHT[team];
  // ramp panel: light grey with soft gradient
  let gr = g.createLinearGradient(0, vy(0), 0, vy(RAMP));
  gr.addColorStop(0, '#9aa1ad'); gr.addColorStop(0.35, '#d5dae3'); gr.addColorStop(1, '#e6e9ef');
  g.fillStyle = gr; g.fillRect(0, vy(RAMP), W, vy(0) - vy(RAMP));
  // panel seams on the ramp
  g.strokeStyle = 'rgba(60,70,90,0.35)'; g.lineWidth = 2;
  for (let s = 0; s < WALL_TILE; s += 256) { g.beginPath(); g.moveTo(sx(s), vy(0)); g.lineTo(sx(s), vy(RAMP)); g.stroke(); }
  for (const v of [130, 270]) { g.beginPath(); g.moveTo(0, vy(v)); g.lineTo(W, vy(v)); g.stroke(); }
  // vertical wall lower part
  gr = g.createLinearGradient(0, vy(RAMP), 0, vy(V_LOWER));
  gr.addColorStop(0, '#cfd4dd'); gr.addColorStop(1, '#aab1be');
  g.fillStyle = gr; g.fillRect(0, vy(V_LOWER), W, vy(RAMP) - vy(V_LOWER));
  // team trims (also emissive)
  const trims = [[RAMP - 10, RAMP + 26], [8, 22], [V_LOWER - 22, V_LOWER]];
  e.g.fillStyle = '#000'; e.g.fillRect(0, 0, W, Hh);
  for (const [a, b] of trims) {
    g.fillStyle = col; g.fillRect(0, vy(b), W, vy(a) - vy(b));
    e.g.fillStyle = light; e.g.fillRect(0, vy(b), W, vy(a) - vy(b));
  }
  // ad board band
  const A1 = V_LOWER - 30, A0 = A1 - 150;
  g.fillStyle = '#121828'; g.fillRect(0, vy(A1), W, vy(A0) - vy(A1));
  e.g.fillStyle = '#05070c'; e.g.fillRect(0, vy(A1), W, vy(A0) - vy(A1));
  const words = ['TURBO PITCH', '»»»', 'SUPERSONIC', '»»»'];
  const bw = W / words.length, bh = vy(A0) - vy(A1);
  for (let k = 0; k < words.length; k++) {
    const x0 = k * bw;
    // board frame
    g.fillStyle = k % 2 ? col : '#1b2338'; g.fillRect(x0 + 4, vy(A1) + 4, bw - 8, bh - 8);
    e.g.fillStyle = k % 2 ? col : '#0b0f1a'; e.g.globalAlpha = k % 2 ? 0.22 : 1; e.g.fillRect(x0 + 4, vy(A1) + 4, bw - 8, bh - 8); e.g.globalAlpha = 1;
    for (const ctx2 of [g, e.g]) {
      ctx2.fillStyle = k % 2 ? (ctx2 === g ? '#ffffff' : '#a0a4ac') : (ctx2 === g ? '#f2f4f8' : '#8a8e98');
      fitText(ctx2, words[k], x0 + bw / 2, vy(A1) + bh / 2 + 2, bw * 0.84, Math.round(bh * (k % 2 ? 0.8 : 0.5)));
    }
  }
  return { c, e: e.c, W, Hh };
}

// Atlas with both teams: v in [0, 0.5] = blue wall, [0.5, 1] = orange wall
// (u = s / WALL_TILE, v = (team + profileLength / V_LOWER) / 2).
export function makeLowerWallAtlas(renderer) {
  const parts = [drawLowerWall(0), drawLowerWall(1)];
  const W = parts[0].W, Hh = parts[0].Hh;
  const A = canvas(W, Hh * 2), E = canvas(W, Hh * 2);
  // canvas top = v 1 (flipY): orange on top, blue below
  A.g.drawImage(parts[1].c, 0, 0); A.g.drawImage(parts[0].c, 0, Hh);
  E.g.drawImage(parts[1].e, 0, 0); E.g.drawImage(parts[0].e, 0, Hh);
  const map = finish(new THREE.CanvasTexture(A.c), renderer, { repeat: true });
  const emissiveMap = finish(new THREE.CanvasTexture(E.c), renderer, { repeat: true });
  map.wrapT = emissiveMap.wrapT = THREE.ClampToEdgeWrapping;
  return { map, emissiveMap };
}

// ------------------------------------------------------------------ glass hex grid
// Tile = sqrt(3)*a x 3a with hex radius a (pointy-top). RGBA: white lines, alpha.
export const HEX_A = 260;
export function makeHexTexture(renderer) {
  const W = 256, Hh = Math.round(W * 3 / Math.sqrt(3)); // 443
  const { c, g } = canvas(W, Hh);
  const a = Hh / 3; // px
  g.clearRect(0, 0, W, Hh);
  g.fillStyle = 'rgba(255,255,255,0.17)'; g.fillRect(0, 0, W, Hh);
  g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 2.2;
  const hex = (cx, cy) => {
    g.beginPath();
    for (let i = 0; i <= 6; i++) {
      const ang = Math.PI / 6 + i * Math.PI / 3;
      const x = cx + a * Math.cos(ang), y = cy + a * Math.sin(ang);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  };
  const w = Math.sqrt(3) * a;
  for (let row = -1; row <= 3; row++) for (let col = -1; col <= 2; col++) hex(col * w + (row & 1 ? w / 2 : 0), row * 1.5 * a);
  const t = finish(new THREE.CanvasTexture(c), renderer, { repeat: true });
  return t;
}

// ------------------------------------------------------------------ goal net
export function makeNetTexture(renderer) {
  const N = 128;
  const { c, g } = canvas(N, N);
  g.clearRect(0, 0, N, N);
  g.fillStyle = 'rgba(255,255,255,0.13)'; g.fillRect(0, 0, N, N); // faint backing so the net reads as a surface
  g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 3;
  // diamond mesh: 2 cells per tile
  g.beginPath();
  for (let k = -2; k <= 2; k++) {
    g.moveTo(k * N / 2, 0); g.lineTo(k * N / 2 + N, N);
    g.moveTo(k * N / 2 + N, 0); g.lineTo(k * N / 2, N);
  }
  g.stroke();
  return finish(new THREE.CanvasTexture(c), renderer, { repeat: true });
}

// ------------------------------------------------------------------ goal floor
// Tileable hex floor: dark base, white hex lines (tinted per team by vertex colour /
// emissive). 9 hex columns x 10 rows per tile.
export function makeGoalFloorTexture(renderer) {
  const W = 250, Hh = 240;
  const { c, g } = canvas(W, Hh);
  g.fillStyle = '#16191f'; g.fillRect(0, 0, W, Hh);
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 2.5;
  const w = W / 9, a = w / Math.sqrt(3), rh = Hh / 10;
  for (let row = -1; row <= 10; row++) for (let col = -1; col <= 9; col++) {
    const cx = col * w + (row & 1 ? w / 2 : 0), cy = row * rh;
    g.beginPath();
    for (let i = 0; i <= 6; i++) { const ang = Math.PI / 6 + i * Math.PI / 3; const x = cx + a * 0.9 * Math.cos(ang), y = cy + a * 0.9 * Math.sin(ang); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
  }
  return finish(new THREE.CanvasTexture(c), renderer, { repeat: true });
}

// ------------------------------------------------------------------ stands
// Seat rows (tileable along the stand): concrete steps with coloured seats.
export function makeSeatTexture(renderer) {
  const W = 256, Hh = 256;
  const { c, g } = canvas(W, Hh);
  const R = rng(7);
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    const y0 = r * Hh / rows;
    g.fillStyle = '#5d6270'; g.fillRect(0, y0, W, Hh / rows);
    g.fillStyle = '#7b8190'; g.fillRect(0, y0, W, 4);
    for (let s = 0; s < 16; s++) {
      g.fillStyle = R() < 0.5 ? '#2b3b6e' : '#3a466f';
      g.fillRect(s * 16 + 2, y0 + 8, 12, Hh / rows - 14);
    }
  }
  return finish(new THREE.CanvasTexture(c), renderer, { repeat: true });
}

// Banner / ad board for stand fascias (one tile = 4 boards)
export function makeFasciaTexture(renderer) {
  const W = 4096, Hh = 128;
  const { c, g } = canvas(W, Hh);
  const words = ['TURBO PITCH', 'BOOST', 'AERIAL', 'KICKOFF', 'TURBO PITCH', 'DEMO', 'OVERTIME', 'SAVE!'];
  const bw = W / words.length;
  for (let k = 0; k < words.length; k++) {
    g.fillStyle = ['#152040', '#0f1626', '#1c1c2a', '#101a33'][k % 4]; g.fillRect(k * bw, 0, bw, Hh);
    g.fillStyle = k % 3 === 1 ? '#ffb347' : (k % 3 === 2 ? '#7fb2ff' : '#ffffff');
    fitText(g, words[k], k * bw + bw / 2, Hh / 2 + 3, bw * 0.86, Math.round(Hh * 0.5));
    g.fillStyle = '#000'; g.fillRect(k * bw, 0, 2, Hh);
  }
  return finish(new THREE.CanvasTexture(c), renderer, { repeat: true });
}

// Structure panels / roof trusses: one tile = 1000 x 1000 uu. Light panels,
// a heavy beam along v (radial truss), lighter cross beams and seams.
export function makePanelTexture(renderer) {
  const N = 256;
  const { c, g } = canvas(N, N);
  const R = rng(55);
  g.fillStyle = '#d8dade'; g.fillRect(0, 0, N, N);
  for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(0,0,0,${R() * 0.04})`; g.fillRect(R() * N, R() * N, 4 + R() * 20, 4 + R() * 20); }
  g.fillStyle = '#9a9ea8';
  for (let k = 0; k < 4; k++) g.fillRect(0, k * N / 4, N, 2);
  for (let k = 0; k < 8; k++) g.fillRect(k * N / 8, 0, 2, N);
  // main truss beam
  g.fillStyle = '#5d626d'; g.fillRect(0, 0, 18, N);
  g.fillStyle = '#787d88'; g.fillRect(18, 0, 4, N);
  // truss diagonals
  g.strokeStyle = '#6a6f7a'; g.lineWidth = 3;
  for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(0, k * N / 4); g.lineTo(18, k * N / 4 + N / 8); g.lineTo(0, (k + 1) * N / 4); g.stroke(); }
  // cross beam
  g.fillStyle = '#80858f'; g.fillRect(0, N / 2 - 4, N, 8);
  return finish(new THREE.CanvasTexture(c), renderer, { repeat: true });
}
