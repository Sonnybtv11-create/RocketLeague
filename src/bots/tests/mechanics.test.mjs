// Isolated mechanics checks in the real sim (no opponents):
//   node src/bots/tests/mechanics.test.mjs
//  * speed-flip kickoff from the diagonal reaches the ball in ~2.4 s or less
//  * half-flip turns the car around in ~1.2 s
//  * front flip adds ~500 uu/s at 1000 uu/s
//  * an All-Star bot aerials from z=0 and touches a ball hovering at z=800
//  * the bot recovers onto its wheels from a random tumble, and unsticks from the roof
//  * jump shot meets a ball at z=250
import { World } from '../../sim/world.js';
import { makeRng } from '../../sim/math.js';
import { CAR_SPAWN_LOCATIONS } from '../../sim/const.js';
import { makeControls } from '../../contracts.js';
import { createBot } from '../bot.js';
import { HalfFlip, Flip, recover } from '../mechanics.js';
import { carFwd, carUp, localTarget, steerPD } from '../util.js';

let fails = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); if (!ok) fails++; };

function soloWorld(team = 0) {
  const world = new World({ rng: makeRng(1) });
  const car = world.addCar({ team, hitbox: 'OCTANE', isBot: true });
  return { world, car };
}
const step = (world, car, c) => { car.controls = c; world.step(); };

// 1. speed-flip kickoff (bot routine) from both diagonals
for (const idx of [0, 1]) {
  const { world, car } = soloWorld();
  const bot = createBot({ difficulty: 'allstar', carId: car.id, team: 0, rng: makeRng(2) });
  world.resetKickoff();
  const sp = CAR_SPAWN_LOCATIONS[idx];
  car.setSpawn(sp.x, sp.y, 17, sp.yaw); car.kickoffSpawnIndex = idx;
  let t = -1;
  for (let i = 0; i < 600 && t < 0; i++) { step(world, car, bot.tick(world, { state: 'playing' }, 1 / 120)); if (world.lastTouch) t = (i + 1) / 120; }
  check(`speed-flip kickoff (diagonal ${idx ? 'right' : 'left'})`, t > 0 && t <= 2.45, `first touch at ${t.toFixed(2)} s, ball speed ${world.ball.body.vel.len().toFixed(0)}`);
}

// 2. half-flip: reversing at ~500 uu/s facing away, turn around
{
  const { world, car } = soloWorld();
  car.setSpawn(0, 0, 17, Math.PI / 2, 100);
  for (let i = 0; i < 20; i++) step(world, car, makeControls());
  for (let i = 0; i < 40; i++) { const c = makeControls(); c.throttle = -1; step(world, car, c); }
  const hf = new HalfFlip(); const fake = { stats: { flips: 0, halfFlips: 0 } };
  let done = false, t = -1;
  for (let i = 0; i < 300 && t < 0; i++) {
    const c = makeControls();
    if (!done) done = hf.step(fake, car, c, world); else { c.throttle = 1; }
    step(world, car, c);
    if (car.isOnGround && carFwd(car).y < -0.9 && i > 10) t = (i + 1) / 120;
  }
  check('half-flip turns around', t > 0 && t < 1.35, `facing the other way on the ground after ${t.toFixed(2)} s, vel.y ${car.body.vel.y.toFixed(0)}`);
}

// 3. front flip at 1000 uu/s
{
  const { world, car } = soloWorld();
  car.setSpawn(0, -4000, 17, Math.PI / 2, 100);
  for (let i = 0; i < 600 && car.body.vel.y < 1000; i++) { const c = makeControls(); c.throttle = 1; step(world, car, c); }
  const v0 = car.body.vel.y;
  const f = new Flip(1, 0, { jumpTicks: 4, gap: 2 }); const fake = { stats: { flips: 0 } };
  let vmax = 0;
  for (let i = 0; i < 40; i++) { const c = makeControls(); f.step(fake, car, c, world); step(world, car, c); vmax = Math.max(vmax, car.body.vel.y); }
  check('front flip speed gain', vmax - v0 > 430, `+${(vmax - v0).toFixed(0)} uu/s from ${v0.toFixed(0)}`);
}

// 4. aerial to a hovering ball (asleep at z=800) by the All-Star bot
for (const [bx, by, bz] of [[0, 0, 800], [600, 500, 1100]]) {
  const { world, car } = soloWorld();
  const bot = createBot({ difficulty: 'allstar', carId: car.id, team: 0, rng: makeRng(3) });
  car.setSpawn(0, -2200, 17, Math.PI / 2, 100);
  world.ball.reset(bx, by, bz); // zero velocity -> ball sleeps in the air until touched
  world.lastTouch = { carId: -1, team: -1, tick: -1 }; // not a kickoff
  let t = -1, aerials = 0;
  for (let i = 0; i < 720 && t < 0; i++) {
    step(world, car, bot.tick(world, { state: 'playing' }, 1 / 120));
    if (bot.maneuver && bot.maneuver.name === 'aerial') aerials = 1;
    if (world.lastTouch.carId === car.id) t = (i + 1) / 120;
  }
  check(`aerial touch on hovering ball z=${bz}`, t > 0 && aerials, `touched at ${t.toFixed(2)} s (aerial used: ${!!aerials}), car z ${car.body.pos.z.toFixed(0)}, boost left ${car.boost.toFixed(0)}`);
}

// 5. jump shot: ball hovering at z=250 in front of a Pro bot
{
  const { world, car } = soloWorld();
  const bot = createBot({ difficulty: 'pro', carId: car.id, team: 0, rng: makeRng(3) });
  car.setSpawn(0, -2000, 17, Math.PI / 2, 33);
  world.ball.reset(0, 0, 250);
  world.lastTouch = { carId: -1, team: -1, tick: -1 };
  let t = -1, z = 0, used = '';
  for (let i = 0; i < 600 && t < 0; i++) {
    step(world, car, bot.tick(world, { state: 'playing' }, 1 / 120));
    if (bot.maneuver) used = bot.maneuver.name;
    if (world.lastTouch.carId === car.id) { t = (i + 1) / 120; z = car.body.pos.z; }
  }
  check('jump shot meets a z=250 ball', t > 0 && z > 60, `touch at ${t.toFixed(2)} s with car z ${z.toFixed(0)} (${used})`);
}

// 6. recovery: tumbling car dropped from 600 uu lands on its wheels
{
  let ok = 0; const N = 8; const rng = makeRng(11);
  for (let k = 0; k < N; k++) {
    const { world, car } = soloWorld();
    car.setSpawn(0, 0, 600, rng() * 6.28);
    car.body.angVel.set((rng() - 0.5) * 8, (rng() - 0.5) * 8, (rng() - 0.5) * 4);
    car.body.vel.set((rng() - 0.5) * 800, (rng() - 0.5) * 800, 300);
    let landedUp = false;
    for (let i = 0; i < 360; i++) {
      const c = makeControls();
      if (!car.isOnGround) recover(car, c, null);
      step(world, car, c);
      if (car.numWheelsInContact >= 3) { landedUp = carUp(car).z > 0.9; break; }
    }
    if (landedUp) ok++;
  }
  check('air recovery lands on wheels', ok >= N - 1, `${ok}/${N} tumbles landed upright`);
}

// 7. upside-down car on the floor gets back on its wheels (bot)
{
  const { world, car } = soloWorld();
  const bot = createBot({ difficulty: 'rookie', carId: car.id, team: 0, rng: makeRng(3) });
  car.setSpawn(0, -1000, 40, Math.PI / 2);
  car.body.rot = car.body.rot.mul(new (car.body.rot.constructor)([1, 0, 0, 0, -1, 0, 0, 0, -1])); // roll 180°
  world.ball.reset(0, 2000, 93.15);
  world.lastTouch = { carId: -1, team: -1, tick: -1 };
  let t = -1;
  for (let i = 0; i < 600 && t < 0; i++) {
    step(world, car, bot.tick(world, { state: 'playing' }, 1 / 120));
    if (car.isOnGround && carUp(car).z > 0.9 && i > 30) t = (i + 1) / 120;
  }
  check('upside-down car recovers', t > 0 && t < 3, `back on wheels after ${t.toFixed(2)} s`);
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall mechanics checks passed');
process.exitCode = fails ? 1 : 0;
