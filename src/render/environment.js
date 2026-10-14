// OWNER: Arena & environment agent. STUB — replace with the full stadium.
// createEnvironment(ctx) -> { object3d, update(view, frameDt), setQuality(name), dispose() }
// Must also render boost pads from view.pads and own the scene lighting (incl. shadow-casting sun).
import * as THREE from 'three';
import { arenaRing, arenaProfile, ARENA_PARAMS } from '../sim/arena.js';

export function createEnvironment(ctx) {
  const g = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(81.92, 120), new THREE.MeshStandardMaterial({ color: 0x2f7d32 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; g.add(floor);
  for (const u of [0]) {
    const ring = arenaRing(u);
    const pts = ring.map((p) => new THREE.Vector3(p[0] / 100, 0.02, p[1] / 100));
    pts.push(pts[0]);
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff })));
  }
  g.add(new THREE.HemisphereLight(0xffffff, 0x334433, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(20, 60, 10); g.add(sun);
  const padMeshes = [];
  return {
    object3d: g,
    update(view) {
      if (!padMeshes.length && view.pads) for (const p of view.pads) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(p.isBig ? 1.6 : 1.2, p.isBig ? 1.6 : 1.2, 0.05, 16), new THREE.MeshBasicMaterial({ color: 0xffcc33 }));
        m.position.set(p.pos.x / 100, 0.03, p.pos.y / 100); g.add(m); padMeshes.push(m);
      }
      view.pads.forEach((p, i) => { padMeshes[i].visible = p.isActive; });
    },
    setQuality() {},
    dispose() {},
  };
}
