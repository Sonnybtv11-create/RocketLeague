// Debug trace of a bot game: node src/bots/tests/trace.mjs <blue> <orange> <fromSec> <toSec> [seed] [every ticks]
import { World } from '../../sim/world.js';
import { makeRng } from '../../sim/math.js';
import { createBot } from '../bot.js';

const [b = 'pro', o = 'rookie', from = '0', to = '20', seed = '1', every = '15', goalsOnly = ''] = process.argv.slice(2);
// goalsOnly=N: only print the last N lines before each goal
const ring = [];
const out = (l) => { if (goalsOnly) { ring.push(l); if (ring.length > +goalsOnly) ring.shift(); } else console.log(l); };
const rng = makeRng(+seed);
const world = new World({ rng });
const bots = [];
const diffs = [b.split(','), o.split(',')];
for (let t = 0; t < 2; t++) for (const d of diffs[t]) {
  // same hitbox draw as harness.mjs (so seeds reproduce harness games)
  const HB = ['OCTANE', 'DOMINUS', 'PLANK', 'BREAKOUT', 'HYBRID', 'MERC'];
  const hb = process.env.HB === 'octane' ? 'OCTANE' : HB[Math.floor(rng() * HB.length)];
  const car = world.addCar({ team: t, hitbox: hb, name: `${t ? 'O' : 'B'}-${d}-${hb}`, isBot: true });
  bots.push({ car, bot: createBot({ difficulty: d, carId: car.id, team: t, rng: makeRng(+seed * 31 + car.id * 7 + 1) }) });
}
world.resetKickoff();
let state = 'countdown', st = 3, time = 0;
const f0 = (v) => Math.round(v);
for (let tick = 0; tick < 120 * (+to + 3); tick++) {
  world.carsFrozen = state === 'countdown';
  const mv = { state };
  const ctl = [];
  for (const { car, bot } of bots) { car.controls = bot.tick(world, mv, 1 / 120); ctl.push(car.controls); }
  world.step();
  for (const e of world.events) if (e.type === 'ballHit' && time >= +from) out(`   HIT by ${world.getCar(e.carId).name} t=${time.toFixed(2)} ballVel=${f0(e.ballVel.x)},${f0(e.ballVel.y)},${f0(e.ballVel.z)}`);
  if (state === 'countdown') { st -= 1 / 120; if (st <= 0) state = 'playing'; continue; }
  time += 1 / 120;
  if (world.goalScored) { if (goalsOnly) { console.log(ring.join('\n')); ring.length = 0; } console.log(`GOAL team ${world.goalScored.team} t=${time.toFixed(2)}`); world.resetKickoff(); state = 'countdown'; st = 3; }
  if (time < +from || tick % +every) continue;
  const B = world.ball.body;
  let line = `t=${time.toFixed(2)} ball(${f0(B.pos.x)},${f0(B.pos.y)},${f0(B.pos.z)} v ${f0(B.vel.x)},${f0(B.vel.y)},${f0(B.vel.z)})`;
  bots.forEach(({ car, bot }, i) => {
    const c = ctl[i];
    const ic = bot.icpt.found ? `${bot.icpt.kind}@${bot.icpt.t.toFixed(2)}(${f0(bot.icpt.x)},${f0(bot.icpt.y)},${f0(bot.icpt.z)})[${bot.icpt.shotKind}]` : '-';
    line += `\n   ${car.name} p(${f0(car.body.pos.x)},${f0(car.body.pos.y)},${f0(car.body.pos.z)}) vf ${f0(car.forwardSpeed)} b${f0(car.boost)} ${bot.mode} ${bot.maneuver ? bot.maneuver.name : ''} ic ${ic} r${bot.role} | thr ${c.throttle.toFixed(2)} st ${c.steer.toFixed(2)} ${c.boost ? 'B' : ''}${c.jump ? 'J' : ''}${c.handbrake ? 'H' : ''}`;
  });
  out(line);
}
