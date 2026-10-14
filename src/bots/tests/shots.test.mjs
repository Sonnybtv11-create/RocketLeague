// Shooting drills (solo bot, no opponent): random ball/car setups in the
// attacking half; measures touch rate, time to touch, and how often the touch
// sends the ball into the opponent goal (checked with the ball predictor).
//   node src/bots/tests/shots.test.mjs [diff] [n] [seed]
import { World } from '../../sim/world.js';
import { BallPredictor } from '../../sim/ball.js';
import { makeRng } from '../../sim/math.js';
import { createBot } from '../bot.js';

const diff = process.argv[2] || 'allstar', N = +(process.argv[3] || 60), seed = +(process.argv[4] || 7);
const rng = makeRng(seed);
const pred = new BallPredictor();
const kinds = { still: [0, 0, 0, 0], rollingIn: [0, 0, 0, 0], crossing: [0, 0, 0, 0], bouncing: [0, 0, 0, 0] };
for (let k = 0; k < N; k++) {
  const kind = Object.keys(kinds)[k % 4];
  const world = new World({ rng: makeRng(k + 1) });
  const car = world.addCar({ team: 0, hitbox: 'OCTANE', isBot: true });
  const bot = createBot({ difficulty: diff, carId: car.id, team: 0, rng: makeRng(k + 3) });
  const bx = (rng() - 0.5) * 5000, by = 500 + rng() * 3200;
  const cx = (rng() - 0.5) * 6000, cy = -2500 + rng() * 2000;
  car.setSpawn(cx, cy, 17, Math.atan2(by - cy, bx - cx) + (rng() - 0.5) * 2, 50);
  car.body.vel.set(Math.cos(car.body.rot.m[0]) * 0, 0, 0);
  world.ball.reset(bx, by, 93.15);
  if (kind === 'rollingIn') world.ball.body.vel.set((rng() - 0.5) * 400, -600 - rng() * 800, 0);
  if (kind === 'crossing') world.ball.body.vel.set((bx > 0 ? -1 : 1) * (500 + rng() * 700), (rng() - 0.5) * 400, 0);
  if (kind === 'bouncing') { world.ball.body.pos.z = 400 + rng() * 500; world.ball.body.vel.set((rng() - 0.5) * 600, (rng() - 0.5) * 600, 300); }
  world.lastTouch = { carId: -1, team: -1, tick: -1 };
  let t = -1;
  for (let i = 0; i < 6 * 120 && t < 0; i++) {
    car.controls = bot.tick(world, { state: 'playing' }, 1 / 120);
    world.step();
    if (world.lastTouch.carId === car.id) t = (i + 1) / 120;
    if (process.env.VERBOSE == k && i % 12 === 0) {
      const B = world.ball.body.pos, P = car.body.pos, ic = bot.icpt;
      console.log(`k${k} ${kind} t=${(i / 120).toFixed(2)} ball(${B.x | 0},${B.y | 0},${B.z | 0}) car(${P.x | 0},${P.y | 0}) vf ${car.forwardSpeed | 0} b${car.boost | 0} ${bot.mode} ${bot.maneuver ? bot.maneuver.name : ''} ic ${ic.found ? ic.kind + '@' + ic.t.toFixed(2) + '(' + (ic.x | 0) + ',' + (ic.y | 0) + ')' + ic.shotKind : '-'} thr ${car.controls.throttle.toFixed(2)} st ${car.controls.steer.toFixed(2)}${car.controls.boost ? ' B' : ''}${car.controls.handbrake ? ' H' : ''}`);
    }
    if (world.goalScored) break;
  }
  const r = kinds[kind];
  r[0]++;
  if (process.env.LIST) console.log(k, kind, t.toFixed(2));
  if (t > 0) {
    r[1]++; r[2] += t;
    // let the hit finish (extra impulse lands next tick) then predict 4 s
    world.step();
    const b = world.ball.body;
    const path = pred.predict({ pos: b.pos, vel: b.vel, angVel: b.angVel }, 4, 2);
    if (path.some((s) => s.pos.y > 5120 + 91 && Math.abs(s.pos.x) < 893)) r[3]++;
  }
}
console.log(`${diff}: shooting drills (${N})`);
let tot = [0, 0, 0, 0];
for (const [k, r] of Object.entries(kinds)) {
  console.log(`  ${k.padEnd(10)} touched ${r[1]}/${r[0]}  mean time ${(r[2] / Math.max(1, r[1])).toFixed(2)} s  on target ${r[3]}/${r[1]}`);
  tot = tot.map((v, i) => v + r[i]);
}
console.log(`  total      touched ${tot[1]}/${tot[0]}  on target ${(100 * tot[3] / Math.max(1, tot[1])).toFixed(0)}%`);
