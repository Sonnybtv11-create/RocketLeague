// End-to-end headless match: World + match flow + replays + bots, driven exactly
// like main.js (fixed 120 Hz ticks inside simulated 60 fps frames).
// Usage: node tools/e2e-match.mjs [teamSize=3] [difficulty=allstar] [durationSec=300]
import { World } from '../src/sim/world.js';
import { createMatch } from '../src/game/match.js';
import { createBot } from '../src/bots/bot.js';
import { captureFrame, interpolateFrames } from '../src/game/view.js';
import { CAR_BODIES, EV } from '../src/contracts.js';
import * as K from '../src/sim/const.js';

const teamSize = Number(process.argv[2] || 3);
const diff = process.argv[3] || 'allstar';
const duration = Number(process.argv[4] || 300);
const w = new World();
const bots = new Map();
for (let t = 0; t < 2; t++) for (let i = 0; i < teamSize; i++) {
  const b = CAR_BODIES[(t * 3 + i) % CAR_BODIES.length];
  const car = w.addCar({ team: t, hitbox: b.hitbox, bodyId: b.id, name: `${t ? 'O' : 'B'}${i}`, isBot: true });
  bots.set(car.id, createBot({ difficulty: diff, carId: car.id, team: t, rng: Math.random }));
}
w.resetKickoff();
const m = createMatch({ world: w, mode: 'exhibition', teamSize, durationSec: duration, rng: Math.random });
let prev = captureFrame(w, m), cur = prev, acc = 0;
const counts = {};
let frames = 0, replayFrames = 0, ticks = 0, maxFrameMs = 0, chats = 0;
const t0 = performance.now();
const FRAME = 1 / 60;
while (!m.isEnded() && frames < 60 * 60 * 30) {
  frames++;
  const f0 = performance.now();
  m.frameUpdate(FRAME);
  if (m.state === 'replay') {
    const r = m.getReplayView();
    if (r) { replayFrames++; if (!r.view || !r.view.cars || !r.view.ball) throw new Error('bad replay view'); }
  } else {
    acc += FRAME;
    while (acc >= K.TICK_TIME) {
      const mv = m.getView();
      for (const [id, bot] of bots) {
        const car = w.getCar(id);
        car.controls = bot.tick(w, mv, w.dt);
        if (bot.events.length) { chats += bot.events.length; bot.events.length = 0; }
      }
      m.preTick();
      w.step();
      const ev = m.postTick(w.events) || [];
      for (const e of [...w.events, ...ev]) counts[e.type] = (counts[e.type] || 0) + 1;
      prev = cur; cur = captureFrame(w, m); m.recordFrame(cur);
      ticks++;
      acc -= K.TICK_TIME;
    }
    const v = interpolateFrames(prev, cur, acc / K.TICK_TIME);
    for (const c of v.cars) if (![c.pos.x, c.pos.y, c.pos.z].every(Number.isFinite)) throw new Error('NaN car pos');
    if (![v.ball.pos.x, v.ball.pos.y, v.ball.pos.z].every(Number.isFinite)) throw new Error('NaN ball pos');
  }
  maxFrameMs = Math.max(maxFrameMs, performance.now() - f0);
}
const mv = m.getView();
console.log(`${teamSize}v${teamSize} ${diff}: ended=${m.isEnded()} score ${mv.scores.join('-')} winner ${mv.winner} overtime ${mv.isOvertime} (+${(mv.overtimeSec || 0).toFixed(0)}s)`);
console.log(`sim ticks ${ticks} (${(ticks / 120 / 60).toFixed(1)} min), frames ${frames}, replay frames ${replayFrames}, quick chats ${chats}`);
console.log('events:', JSON.stringify(counts));
console.log('players:', mv.players.map((p) => `${p.name} ${p.score}pts g${p.goals} a${p.assists} sv${p.saves} sh${p.shots} d${p.demos}`).join(' | '), 'MVP', mv.mvpId);
console.log(`wall time ${((performance.now() - t0) / 1000).toFixed(1)} s, worst frame ${maxFrameMs.toFixed(1)} ms`);
process.exit(m.isEnded() ? 0 : 1);
