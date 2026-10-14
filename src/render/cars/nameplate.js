// TURBO PITCH — floating nameplate with boost bar (car agent).
// A camera-facing group (name card + boost bar fill) that keeps a roughly constant
// on-screen size. Drawn on top (no depth test) like RL's nameplates.
import * as THREE from 'three';
import { TEAM_COLORS } from '../../contracts.js';

const CW = 512, CH = 128;
const planeGeo = new THREE.PlaneGeometry(1, 1);
const barGeo = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0); // anchored at the left edge

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
  // card
  g.clearRect(0, 0, CW, CH);
  roundRect(g, 6, 6, CW - 12, CH - 12, 22);
  g.fillStyle = css(tc.dark, 0.72); g.fill();
  g.lineWidth = 5; g.strokeStyle = css(tc.light, 0.95); g.stroke();
  // name
  let fs = 50;
  g.font = `800 ${fs}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  const label = String(name || '').toUpperCase().slice(0, 16);
  while (g.measureText(label).width > CW - 60 && fs > 24) { fs -= 2; g.font = `800 ${fs}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`; }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 6;
  g.fillText(label, CW / 2, CH * 0.4);
  g.shadowBlur = 0;
  // boost bar track
  roundRect(g, 40, CH - 34, CW - 80, 14, 7);
  g.fillStyle = 'rgba(0,0,0,0.55)'; g.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  const cardMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const barMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc23a), transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const root = new THREE.Group();
  root.name = 'nameplate';
  const card = new THREE.Mesh(planeGeo, cardMat);
  card.scale.set(CW / CH, 1, 1);
  card.renderOrder = 50;
  // bar fill: track spans x in [40, CW-40], y centre at CH-27 (canvas px) -> plane units
  const bx0 = (40 + 2) / CH - (CW / CH) / 2, bw = (CW - 84) / CH, by = 0.5 - (CH - 27) / CH;
  const bar = new THREE.Mesh(barGeo, barMat);
  bar.position.set(bx0, by, 0.001);
  bar.scale.set(bw, 10 / CH, 1);
  bar.renderOrder = 51;
  root.add(card, bar);
  root.frustumCulled = false; card.frustumCulled = false; bar.frustumCulled = false;
  const tmp = new THREE.Vector3();
  let lastBoost = -1;
  return {
    object3d: root,
    // worldPos: THREE.Vector3 (car position, metres); camera: THREE.Camera
    update(worldPos, boost, camera, visible) {
      root.visible = visible;
      if (!visible) return;
      const d = tmp.copy(worldPos).sub(camera.position).length();
      const s = Math.min(Math.max(d * 0.034, 0.32), 3.2);
      root.position.set(worldPos.x, worldPos.y + 0.95 + s * 0.6, worldPos.z);
      root.quaternion.copy(camera.quaternion);
      root.scale.setScalar(s);
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
