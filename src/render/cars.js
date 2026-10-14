// OWNER: Car & ball models agent. STUB — replace with original low-poly bodies.
// createCarModel(ctx, { bodyId, hitbox, team, accent, name }) -> { object3d, update(carView, frameDt), dispose() }
// Model space: metres, +X forward, +Y up, +Z right; origin = car origin (centre of mass).
import * as THREE from 'three';
import { CAR_CONFIGS } from '../sim/carconfig.js';
import { TEAM_COLORS } from '../contracts.js';
import { applySimTransform } from './util.js';

export function createCarModel(ctx, opts) {
  const cfg = CAR_CONFIGS[opts.hitbox || 'OCTANE'];
  const g = new THREE.Group();
  const s = cfg.hitboxSize, o = cfg.hitboxOffset;
  const body = new THREE.Mesh(new THREE.BoxGeometry(s.x / 100, s.z / 100, s.y / 100), new THREE.MeshStandardMaterial({ color: TEAM_COLORS[opts.team].primary }));
  body.position.set(o.x / 100, o.z / 100, 0); body.castShadow = true; g.add(body);
  const wheels = [];
  return {
    object3d: g,
    update(cv) {
      g.visible = !cv.isDemoed;
      applySimTransform(g, cv.pos, cv.rot);
      if (!wheels.length) for (const w of cv.wheels) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(w.radius / 100, w.radius / 100, 0.08, 12), new THREE.MeshStandardMaterial({ color: 0x222222 }));
        m.rotation.x = Math.PI / 2; const p = new THREE.Group(); p.add(m); g.add(p); wheels.push(p);
      }
      cv.wheels.forEach((w, i) => wheels[i].position.set(w.offset.x / 100, (w.offset.z - w.suspLen) / 100, w.offset.y / 100));
    },
    dispose() {},
  };
}

// createBallModel(ctx) -> { object3d, update(ballView, frameDt), dispose() } (includes the floor shadow)
export function createBallModel(ctx) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.9125, 24, 16), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
  m.castShadow = true;
  return { object3d: m, update(bv) { applySimTransform(m, bv.pos, bv.rot); }, dispose() {} };
}
