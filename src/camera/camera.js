// OWNER: Camera & input agent. STUB.
// createCameraController(ctx) -> { update(view, opts, frameDt), shake(amount), dispose() }
// opts = { mode: 'car'|'replay'|'menu'|'fixed', targetCarId, ballCam, look:{x,y}, hint, fixed:{pos,target} (sim units) }
import * as THREE from 'three';
import { simToThree } from '../render/util.js';
export function createCameraController(ctx) {
  const cam = ctx.camera;
  return {
    update(view, opts) {
      if (opts.mode === 'fixed' && opts.fixed) {
        simToThree(opts.fixed.pos, cam.position); cam.lookAt(simToThree(opts.fixed.target));
        return;
      }
      const car = view.cars.find((c) => c.id === opts.targetCarId) || view.cars[0];
      if (!car) { cam.position.set(0, 30, -60); cam.lookAt(0, 0, 0); return; }
      const f = car.forward;
      const p = { x: car.pos.x - f.x * 270, y: car.pos.y - f.y * 270, z: car.pos.z + 100 };
      simToThree(p, cam.position); cam.lookAt(simToThree(car.pos));
      cam.fov = ctx.settings.camera.fov * 0.6; cam.updateProjectionMatrix();
    },
    shake() {}, dispose() {},
  };
}
