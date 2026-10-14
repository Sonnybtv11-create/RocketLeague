// Allocation + timing profile of the bots: 3v3 All-Star, 60 s of play.
//   node --expose-gc src/bots/tests/alloc.test.mjs [seconds]
// Allocation is estimated from heapUsed deltas around each call (calls during
// which a scavenge ran show a negative delta and are skipped, so the numbers
// are slight under-estimates). Also reports per-bot tick p99 / max and the
// cost of the shared ball-prediction fill.
import { World } from '../../sim/world.js';
import { makeRng } from '../../sim/math.js';
import { createBot } from '../bot.js';

const secs = +(process.argv[2] || 60);
const world = new World({ rng: makeRng(5) });
const bots = [];
for (let i = 0; i < 6; i++) {
  const car = world.addCar({ team: i % 2, isBot: true });
  bots.push({ car, bot: createBot({ difficulty: 'allstar', carId: car.id, team: i % 2, rng: makeRng(i + 9) }) });
}
world.resetKickoff();
const frozen = 360, warm = 1200;
let botBytes = 0, botN = 0, simBytes = 0, simN = 0;
const times = [], firstBot = [];
const mu = () => process.memoryUsage().heapUsed;
for (let tick = 0; tick < secs * 120 + frozen + warm; tick++) {
  const measure = tick >= frozen + warm; // after JIT warm-up
  world.carsFrozen = tick < frozen;
  const mv = { state: tick < frozen ? 'countdown' : 'playing' };
  for (let i = 0; i < bots.length; i++) {
    const { car, bot } = bots[i];
    const h0 = measure ? mu() : 0;
    const t0 = performance.now();
    car.controls = bot.tick(world, mv, 1 / 120);
    const el = performance.now() - t0;
    if (measure) {
      const d = mu() - h0; if (d >= 0) { botBytes += d; botN++; }
      times.push(el); if (i === 0) firstBot.push(el);
    }
  }
  const h1 = measure ? mu() : 0;
  world.step();
  if (measure) { const d = mu() - h1; if (d >= 0) { simBytes += d; simN++; } }
  if (world.goalScored) world.resetKickoff();
}
const stats = (a) => {
  a.sort((x, y) => x - y);
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const p = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
  return `mean ${m.toFixed(4)} ms, p99 ${p(0.99).toFixed(3)}, p99.9 ${p(0.999).toFixed(3)}, max ${a[a.length - 1].toFixed(2)} ms`;
};
console.log(`bots: ~${(botBytes / botN).toFixed(0)} B allocated per bot tick (~${(botBytes / botN * 6 * 120 / 1e6).toFixed(2)} MB/s for 6 bots @120 Hz)`);
console.log(`sim:  ~${(simBytes / simN / 1024).toFixed(1)} KB per world.step (~${(simBytes / simN * 120 / 1e6).toFixed(1)} MB/s)`);
console.log(`bot tick (all): ${stats(times)}`);
console.log(`first bot each tick (pays the shared prediction): ${stats(firstBot)}`);
