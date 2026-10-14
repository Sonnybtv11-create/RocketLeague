// Per-tick timing of the bots: 3v3 All-Star (6 bots) for 60 s of play.
//   node src/bots/tests/perf.test.mjs [seconds] [diff]
// Reports mean / p99 / max ms per bot tick, and the shared prediction cost.
import { World } from '../../sim/world.js';
import { makeRng } from '../../sim/math.js';
import { createBot } from '../bot.js';

const secs = +(process.argv[2] || 60), diff = process.argv[3] || 'allstar';
const world = new World({ rng: makeRng(5) });
const bots = [];
for (let i = 0; i < 6; i++) {
  const car = world.addCar({ team: i % 2, isBot: true });
  bots.push({ car, bot: createBot({ difficulty: diff, carId: car.id, team: i % 2, rng: makeRng(i + 9) }) });
}
world.resetKickoff();
const samples = [];
let simMs = 0, frozen = 360;
for (let tick = 0; tick < secs * 120 + frozen; tick++) {
  world.carsFrozen = tick < frozen;
  const mv = { state: tick < frozen ? 'countdown' : 'playing' };
  for (const { car, bot } of bots) {
    const t0 = performance.now();
    car.controls = bot.tick(world, mv, 1 / 120);
    const el = performance.now() - t0;
    if (tick >= frozen) samples.push(el);
  }
  const t1 = performance.now();
  world.step();
  simMs += performance.now() - t1;
  if (world.goalScored) { world.resetKickoff(); }
}
samples.sort((a, b) => a - b);
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
const pct = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
console.log(`${diff} x6, ${secs}s: bot tick mean ${mean.toFixed(4)} ms, p50 ${pct(0.5).toFixed(4)}, p99 ${pct(0.99).toFixed(3)}, p99.9 ${pct(0.999).toFixed(3)}, max ${samples[samples.length - 1].toFixed(2)} ms`);
console.log(`per physics tick: all 6 bots ${(mean * 6).toFixed(3)} ms vs world.step ${(simMs / (secs * 120 + frozen)).toFixed(3)} ms`);
console.log(`budget: < 0.15 ms per bot per tick -> ${mean < 0.15 ? 'PASS' : 'FAIL'}`);
