// TURBO PITCH — floating nameplate with boost bar (car agent).
// A camera-facing card (name + boost bar fill) drawn on top of the scene.
//   * constant on-screen size: the card is ~3% of the viewport height (name text ~1.7%),
//     recomputed every frame from the camera's vertical FOV and the plate's view depth;
//   * fades out closer than ~8 m (the car itself is the cue) and beyond very long range;
//   * overlap resolution between the plates of one frame: the farther plate is nudged up in
//     screen space above the nearer one, or hidden when the nudge would be too large.
// All plate updates of a frame run before that frame is rendered, so a later plate may still
// move/hide an earlier one.
import * as THREE from 'three';
import { TEAM_COLORS } from '../../contracts.js';

const CW = 512, CH = 112;
const ASPECT = CW / CH;
const H_FRAC = 0.032;                     // card height / viewport height
const NEAR_HIDE = 8, NEAR_FULL = 12;      // metres: fade in
const FAR_FULL = 105, FAR_HIDE = 125;     // metres: fade out
const ANCHOR_UP = 1.0;                    // metres above the car origin
const planeGeo = new THREE.PlaneGeometry(1, 1);
const barGeo = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0); // anchored at its left edge

// Plates placed during the current frame (reset when the frame token changes)
const placed = [];
let frameKey = null;

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

export function createNameplate(name, team) {
  const tc = TEAM_COLORS[team] || TEAM_COLORS[0];
  const canvas = document.createElement('canvas');
  canvas.width = CW; canvas.height = CH;
  const g = canvas.getContext('2d');
  const css = (hex, a) => { const c = new THREE.Color(hex); return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`; };
  g.clearRect(0, 0, CW, CH);
  roundRect(g, 5, 5, CW - 10, CH - 10, 20);
  g.fillStyle = css(tc.dark, 0.78); g.fill();
  g.lineWidth = 5; g.strokeStyle = css(tc.light, 0.95); g.stroke();
  const font = (s) => `800 ${s}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  let fs = 60;
  g.font = font(fs);
  const label = String(name || '').toUpperCase().slice(0, 16);
  while (g.measureText(label).width > CW - 50 && fs > 26) { fs -= 2; g.font = font(fs); }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 5;
  g.fillText(label, CW / 2, CH * 0.4);
  g.shadowBlur = 0;
  roundRect(g, 34, CH - 30, CW - 68, 14, 7);
  g.fillStyle = 'rgba(0,0,0,0.6)'; g.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const cardMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const barMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc23a), transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  cardMat.forceSinglePass = true; barMat.forceSinglePass = true;
  const root = new THREE.Group();
  root.name = 'nameplate';
  const card = new THREE.Mesh(planeGeo, cardMat);
  card.scale.set(ASPECT, 1, 1);
  card.renderOrder = 50;
  const bx0 = (34 + 2) / CH - ASPECT / 2, bw = (CW - 72) / CH, by = 0.5 - (CH - 23) / CH;
  const bar = new THREE.Mesh(barGeo, barMat);
  bar.position.set(bx0, by, 0.001);
  bar.scale.set(bw, 10 / CH, 1);
  bar.renderOrder = 51;
  root.add(card, bar);
  root.frustumCulled = false; card.frustumCulled = false; bar.frustumCulled = false;
  root.visible = false;

  const anchor = new THREE.Vector3(), rel = new THREE.Vector3(), fwd = new THREE.Vector3(), camUp = new THREE.Vector3(), ndc = new THREE.Vector3();
  let lastBoost = -1;
  // this plate's record in the per-frame registry
  const rec = { root, d: 0, x: 0, y: 0, hw: 0, hh: 0, shift: 0, worldPerNdc: 0, apply: null };
  rec.apply = () => {
    root.position.copy(anchor).addScaledVector(camUp, (rec.hh + rec.shift) * rec.worldPerNdc);
  };

  return {
    object3d: root,
    // worldPos: car position (THREE.Vector3, metres); camera: PerspectiveCamera; frame: per-frame token
    update(worldPos, boost, camera, visible, frame) {
      if (!visible || !camera) { root.visible = false; return; }
      if (frame !== frameKey) { frameKey = frame; placed.length = 0; }
      camera.getWorldDirection(fwd);
      anchor.set(worldPos.x, worldPos.y + ANCHOR_UP, worldPos.z);
      rel.copy(anchor).sub(camera.position);
      const depth = rel.dot(fwd), dist = rel.length();
      if (depth < 0.5 || dist < NEAR_HIDE || dist > FAR_HIDE) { root.visible = false; return; }
      const alpha = Math.min(1, (dist - NEAR_HIDE) / (NEAR_FULL - NEAR_HIDE)) * Math.min(1, (FAR_HIDE - dist) / (FAR_HIDE - FAR_FULL));
      const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1);
      rec.worldPerNdc = depth * tanH;                 // world units per NDC unit at this depth
      ndc.copy(anchor).project(camera);
      rec.hh = H_FRAC; rec.hw = H_FRAC * ASPECT / (camera.aspect || 1.78);
      rec.x = ndc.x; rec.y = ndc.y + rec.hh; rec.d = dist; rec.shift = 0;
      if (Math.abs(rec.x) > 1 + rec.hw || Math.abs(rec.y) > 1 + rec.hh) { root.visible = false; return; }
      camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      // overlap resolution against the plates already placed this frame
      for (const o of placed) {
        if (!o.root.visible) continue;
        if (!(Math.abs(o.x - rec.x) < o.hw + rec.hw && Math.abs(o.y - rec.y) < o.hh + rec.hh)) continue;
        const far = rec.d > o.d ? rec : o, near = far === rec ? o : rec;
        const need = near.y + near.hh + far.hh - far.y + 0.004;   // put the far card above the near one
        if (need < 2.4 * far.hh) {
          far.y += need; far.shift += need;
          if (far !== rec) far.apply();
        } else if (far === rec) { root.visible = false; return; } else { far.root.visible = false; }
      }
      rec.apply();
      root.quaternion.copy(camera.quaternion);
      root.scale.setScalar(2 * H_FRAC * rec.worldPerNdc);
      cardMat.opacity = alpha; barMat.opacity = 0.95 * alpha;
      root.visible = true;
      placed.push(rec);
      const b = Math.max(0, Math.min(100, boost)) / 100;
      if (Math.abs(b - lastBoost) > 0.002) {
        lastBoost = b;
        bar.scale.x = Math.max(0.0001, bw * b);
        bar.visible = b > 0.003;
      }
    },
    dispose() { tex.dispose(); cardMat.dispose(); barMat.dispose(); },
  };
}
