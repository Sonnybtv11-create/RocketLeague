// Headless match harness for the bots (Node). Uses the real World:
//   kickoff via world.resetKickoff(), 3 s countdown with world.carsFrozen,
//   goal detection via world.goalScored, reset to kickoff after a goal.
// runGame(opts) -> stats object (see bottom).
import { World } from '../../sim/world.js';
import { makeRng } from '../../sim/math.js';
import { EV } from '../../contracts.js';
import { createBot } from '../bot.js';

const HITBOXES = ['OCTANE', 'DOMINUS', 'PLANK', 'BREAKOUT', 'HYBRID', 'MERC'];

export function runGame({ blue = ['allstar'], orange = ['pro'], seconds = 180, seed = 1, countdown = 3, goalPause = 1, hitbox = null, log = null } = {}) {
  const rng = makeRng(seed);
  const world = new World({ rng });
  const bots = new Map();
  const cars = [];
  const teams = [blue, orange];
  for (let t = 0; t < 2; t++) {
    teams[t].forEach((diff, i) => {
      const hb = hitbox || HITBOXES[Math.floor(rng() * HITBOXES.length)];
      const car = world.addCar({ team: t, hitbox: hb, name: `${t ? "O" : "B"}${i}-${diff}-${hb}`, isBot: true });
      cars.push(car);
      bots.set(car.id, { bot: createBot({ difficulty: diff, carId: car.id, team: t, rng: makeRng(seed * 31 + car.id * 7 + 1) }), diff });
    });
  }
  world.resetKickoff();

  const S = {
    seed, seconds, goals: [0, 0], kickoffs: 0, kickoffWins: [0, 0], kickoffFirstTouch: [0, 0],
    perCar: new Map(), botTimeMs: 0, botTicks: 0, maxBotTickMs: 0, ticks: 0,
    doubleCommitEvents: [0, 0], doubleCommitTicks: [0, 0], stuckEvents: 0, waitingEvents: 0, maxStationary: 0, stuckLog: [],
    chats: [], demos: 0, goalsLog: [],
  };
  for (const car of cars) {
    S.perCar.set(car.id, { name: car.name, team: car.team, diff: bots.get(car.id).diff, touches: 0, pads: 0, bigPads: 0, demos: 0, demoed: 0, goals: 0,
      stationary: 0, lastPos: { x: car.body.pos.x, y: car.body.pos.y, z: car.body.pos.z }, stillT: 0 });
  }

  let state = 'countdown', stateT = countdown, clock = seconds;
  let kickoffPending = true, kickoffTouchT = -1, dcPrev = [false, false];
  const view = () => ({ mode: 'exhibition', state, clockSec: clock, isOvertime: false, countdown: Math.ceil(stateT), scores: [...S.goals], players: [], replayActive: false });

  const totalTicks = Math.round((seconds + 200) * 120);
  for (let tick = 0; tick < totalTicks; tick++) {
    const mv = view();
    world.carsFrozen = state === 'countdown';
    for (const [id, b] of bots) {
      const car = world.getCar(id);
      const t0 = performance.now();
      const c = b.bot.tick(world, mv, world.dt);
      const el = performance.now() - t0;
      if (state === 'playing') { S.botTimeMs += el; S.botTicks++; if (el > S.maxBotTickMs && tick > 600) S.maxBotTickMs = el; }
      car.controls = c;
      if (b.bot.events.length) { for (const e of b.bot.events) S.chats.push(e.text); b.bot.events.length = 0; }
    }
    world.step();
    S.ticks++;
    for (const e of world.events) {
      if (e.type === EV.BALL_HIT) {
        const pc = S.perCar.get(e.carId); pc.touches++;
        if (kickoffPending && state === 'playing') {
          kickoffPending = false; kickoffTouchT = 2.0;
          S.kickoffFirstTouch[e.team]++;
        }
      } else if (e.type === EV.PAD_PICKUP) { const pc = S.perCar.get(e.carId); pc.pads++; if (e.isBig) pc.bigPads++; }
      else if (e.type === EV.DEMO) { S.demos++; if (e.attackerId >= 0) S.perCar.get(e.attackerId).demos++; S.perCar.get(e.victimId).demoed++; }
    }
    if (state === 'countdown') {
      stateT -= world.dt;
      if (stateT <= 0) { state = 'playing'; kickoffPending = true; S.kickoffs++; }
    } else if (state === 'playing') {
      clock -= world.dt;
      if (kickoffTouchT > 0) {
        kickoffTouchT -= world.dt;
        if (kickoffTouchT <= 0) {
          const by = world.ball.body.pos.y;
          if (Math.abs(by) > 300) S.kickoffWins[by > 0 ? 0 : 1]++; // ball in the opponent half = won
        }
      }
      // double commits: two teammates within 300 uu of the ball
      for (let t = 0; t < 2; t++) {
        let n = 0;
        for (const car of cars) if (car.team === t && !car.isDemoed && car.body.pos.dist(world.ball.body.pos) < 300) n++;
        const dc = n >= 2;
        if (dc) S.doubleCommitTicks[t]++;
        if (dc && !dcPrev[t]) S.doubleCommitEvents[t]++;
        dcPrev[t] = dc;
      }
      // stuck tracking: a car that hasn't moved 120 uu for > 5 s
      if (tick % 12 === 0) {
        for (const car of cars) {
          const pc = S.perCar.get(car.id);
          if (car.isDemoed) { pc.stillT = 0; continue; }
          const d = car.body.pos.dist(pc.lastPos);
          if (d < 120) {
            pc.stillT += 0.1;
            if (pc.stillT > S.maxStationary) S.maxStationary = pc.stillT;
            if (pc.stillT > 5 && pc.stillT < 5.11) {
              const bt = bots.get(car.id).bot;
              // a goalie / shadow defender waiting on its wheels on purpose is not stuck
              const intentional = car.isOnGround && car.body.rot.m[8] > 0.9 && world.tick - (bt.settledTick ?? -1e9) < 60;
              if (intentional) { S.waitingEvents++; continue; }
              S.stuckEvents++;
              S.stuckLog.push({ car: car.name, pos: [car.body.pos.x | 0, car.body.pos.y | 0, car.body.pos.z | 0], upZ: +car.body.rot.m[8].toFixed(2), onGround: car.isOnGround, mode: bt.mode, t: +(seconds - clock).toFixed(1) });
            }
          } else { pc.stillT = 0; pc.lastPos = { x: car.body.pos.x, y: car.body.pos.y, z: car.body.pos.z }; }
        }
      }
      if (world.goalScored) {
        const team = world.goalScored.team;
        S.goals[team]++;
        const lt = world.lastTouch;
        if (lt) { const pc = S.perCar.get(lt.carId); if (pc && pc.team === team) pc.goals++; }
        S.goalsLog.push({ t: +(seconds - clock).toFixed(1), team, by: lt ? S.perCar.get(lt.carId).name : '?' });
        state = 'goal'; stateT = goalPause;
      } else if (clock <= 0) {
        if (world.ball.body.pos.z < 100 || clock < -15) break; // zero-second rule (approx.)
      }
    } else if (state === 'goal') {
      stateT -= world.dt;
      if (stateT <= 0) { world.resetKickoff(); state = 'countdown'; stateT = countdown; kickoffPending = false; kickoffTouchT = -1; }
    }
  }
  // collect bot stats
  S.bots = [];
  for (const [id, b] of bots) {
    const pc = S.perCar.get(id);
    S.bots.push({ ...b.bot.stats, name: pc.name, team: pc.team, diff: b.diff, touches: pc.touches, pads: pc.pads, bigPads: pc.bigPads, demos: pc.demos, demoed: pc.demoed, goals: pc.goals });
  }
  S.perCar = undefined;
  S.msPerBotTick = S.botTimeMs / Math.max(1, S.botTicks);
  return S;
}
