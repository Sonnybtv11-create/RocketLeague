// Debug: trace a solo kickoff. node src/bots/tests/kotrace.mjs <diff> <spawnIdx> [team]
import { World } from '../../sim/world.js';
import { makeRng } from '../../sim/math.js';
import { CAR_SPAWN_LOCATIONS } from '../../sim/const.js';
import { createBot } from '../bot.js';
const [d = 'allstar', si = '0', team = '0'] = process.argv.slice(2);
const world = new World({ rng: makeRng(1) });
const car = world.addCar({ team: +team, hitbox: 'OCTANE', isBot: true });
const bot = createBot({ difficulty: d, carId: car.id, team: +team, rng: makeRng(+(process.argv[5] || 3)) });
world.resetKickoff();
const sp = CAR_SPAWN_LOCATIONS[+si]; const s = +team === 0 ? 1 : -1;
car.setSpawn(sp.x * s, sp.y * s, 17, sp.yaw + (+team === 0 ? 0 : Math.PI)); car.kickoffSpawnIndex = +si;
const r = (v) => Math.round(v);
for (let i = 0; i < 400; i++) {
  const c = bot.tick(world, { state: 'playing' }, 1 / 120); car.controls = c; world.step();
  if (i % 10 === 0 || world.lastTouch) console.log(((i + 1) / 120).toFixed(2), r(car.body.pos.x), r(car.body.pos.y), r(car.body.pos.z), 'v', r(car.body.vel.x), r(car.body.vel.y), 'up', car.body.rot.m[8].toFixed(2), bot.kickoff ? bot.kickoff.phase : '-', bot.kickoff && bot.kickoff.maneuver ? bot.kickoff.maneuver.name : '', `thr${c.throttle} st${c.steer.toFixed(2)} p${c.pitch.toFixed(2)} y${c.yaw.toFixed(2)} r${c.roll.toFixed(2)} ${c.boost ? 'B' : ''}${c.jump ? 'J' : ''}`);
  if (world.lastTouch) break;
}
