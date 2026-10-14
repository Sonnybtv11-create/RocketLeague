// OWNER: Bots agent. STUB.
// createBot({ difficulty: 'rookie'|'pro'|'allstar', carId, team, rng }) -> { tick(world, matchView, dt) -> Controls, events: [] }
import { makeControls } from '../contracts.js';
export function createBot({ carId }) {
  return {
    events: [],
    tick(world) {
      const car = world.getCar(carId); const c = makeControls();
      if (!car || car.isDemoed) return c;
      const d = world.ball.body.pos.sub(car.body.pos);
      const local = car.body.rot.mulVecT(d);
      c.throttle = 1; c.steer = Math.max(-1, Math.min(1, Math.atan2(local.y, local.x) * 2));
      return c;
    },
  };
}
