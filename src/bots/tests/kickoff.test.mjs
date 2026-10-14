// Kickoff tests: solo time-to-ball per routine/spawn and head-to-head 50/50s.
//   node src/bots/tests/kickoff.test.mjs
import { World } from '../../sim/world.js';
import { makeRng } from '../../sim/math.js';
import { CAR_SPAWN_LOCATIONS } from '../../sim/const.js';
import { createBot } from '../bot.js';

function setup(diffs, spawnIdx, seed) {
  const world = new World({ rng: makeRng(seed) });
  const bots = [];
  diffs.forEach((d, t) => {
    if (!d) return;
    const car = world.addCar({ team: t, hitbox: 'OCTANE', isBot: true });
    bots.push({ car, bot: createBot({ difficulty: d, carId: car.id, team: t, rng: makeRng(seed + t) }) });
  });
  world.resetKickoff();
  // force the requested spawn (mirrored for orange)
  for (const { car } of bots) {
    const sp = CAR_SPAWN_LOCATIONS[spawnIdx];
    const s = car.team === 0 ? 1 : -1;
    car.setSpawn(sp.x * s, sp.y * s, 17, sp.yaw + (car.team === 0 ? 0 : Math.PI));
    car.kickoffSpawnIndex = spawnIdx;
  }
  return { world, bots };
}

function run(diffs, spawnIdx, seed = 1, after = 2.0) {
  const { world, bots } = setup(diffs, spawnIdx, seed);
  let first = null, tFirst = -1;
  for (let tick = 0; tick < 120 * 8; tick++) {
    for (const { car, bot } of bots) car.controls = bot.tick(world, { state: 'playing' }, 1 / 120);
    world.step();
    if (first === null) {
      for (const e of world.events) if (e.type === 'ballHit') { first = e.team; tFirst = (tick + 1) / 120; break; }
    } else if ((tick + 1) / 120 >= tFirst + after) {
      return { first, tFirst, ballY: world.ball.body.pos.y, goal: world.goalScored ? world.goalScored.team : null };
    }
    if (world.goalScored) return { first, tFirst, ballY: world.ball.body.pos.y, goal: world.goalScored.team };
  }
  return { first, tFirst, ballY: world.ball.body.pos.y, goal: null };
}

const names = ['diagL', 'diagR', 'offL', 'offR', 'back'];
console.log('Solo time to first touch (s):');
for (const d of (process.env.D||'rookie,pro,allstar').split(',')) {
  const row = names.map((n, i) => `${n} ${run([d, null], i).tFirst.toFixed(2)}`);
  console.log(`  ${d.padEnd(8)} ${row.join('  ')}`);
}
console.log('\nHead to head (blue vs orange, mirrored spawns, both sides): wins = ball in the other half 2 s after the first touch');
const pairs = [['allstar', 'pro'], ['allstar', 'rookie'], ['pro', 'rookie'], ['allstar', 'allstar'], ['pro', 'pro']];
for (const [a, b] of pairs) {
  let wa = 0, wb = 0, n = 0, ga = 0, gb = 0;
  for (let i = 0; i < 5; i++) for (const swap of [false, true]) for (const seed of [1, 2]) {
    const r = run(swap ? [b, a] : [a, b], i, seed);
    const ta = swap ? 1 : 0;
    n++;
    const winner = r.goal !== null ? r.goal : (Math.abs(r.ballY) < 300 ? -1 : (r.ballY > 0 ? 0 : 1));
    if (winner === ta) wa++; else if (winner === 1 - ta) wb++;
    if (r.goal === ta) ga++; else if (r.goal === 1 - ta) gb++;
  }
  console.log(`  ${a} vs ${b}: ${wa}-${wb} of ${n} (goals straight from kickoff ${ga}-${gb})`);
}
