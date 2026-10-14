// Test harness: drives World + Match exactly like src/main.js does.
import { World } from '../../sim/world.js';
import { Vec3, rotMatFromYPR, makeRng } from '../../sim/math.js';
import * as K from '../../sim/const.js';
import { makeControls, EV } from '../../contracts.js';
import { captureFrame } from '../view.js';
import { createMatch } from '../match.js';

export { EV, K, Vec3, makeControls };

let results = [];
export function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return !!cond;
}
export function takeResults() { const r = results; results = []; return r; }

export function setup({ blue = 1, orange = 1, mode = 'exhibition', durationSec = 300, seed = 7 } = {}) {
  const rng = makeRng(seed);
  const world = new World({ rng });
  const names = ['Ace', 'Blaze', 'Cobalt', 'Dash', 'Ember', 'Flint'];
  let n = 0;
  for (let i = 0; i < blue; i++) world.addCar({ team: 0, name: names[n++], isBot: true });
  for (let i = 0; i < orange; i++) world.addCar({ team: 1, name: names[n++], isBot: true });
  world.resetKickoff();
  const match = createMatch({ world, mode, teamSize: Math.max(blue, orange), durationSec, rng });
  const g = { world, match, events: [], frame: captureFrame(world, match), controls: null };
  return g;
}

// One physics tick, same order as main.js physicsTick()
export function tick(g, controlsFn) {
  const { world, match } = g;
  for (const car of world.cars) car.controls = (controlsFn && controlsFn(car, world, match)) || makeControls();
  match.preTick();
  world.step();
  const wev = world.events;
  if (g.injectAfterStep) { g.injectAfterStep(world); g.injectAfterStep = null; }
  const mev = match.postTick(world.events);
  g.frame = captureFrame(world, match);
  match.recordFrame(g.frame);
  const all = [...wev, ...mev];
  g.events.push(...all);
  return all;
}

// Run N physics ticks (no replay frame updates)
export function ticks(g, n, controlsFn) { const out = []; for (let i = 0; i < n; i++) out.push(...tick(g, controlsFn)); return out; }

// Real-time driver at 60 fps: frameUpdate, then 2 physics ticks unless replaying (main.js frame())
export function frames(g, seconds, controlsFn, fps = 60) {
  const out = [];
  const n = Math.round(seconds * fps);
  const per = 120 / fps;
  for (let i = 0; i < n; i++) {
    g.match.frameUpdate(1 / fps);
    if (g.match.state !== 'replay') for (let k = 0; k < per; k++) out.push(...tick(g, controlsFn));
  }
  return out;
}

export function runUntil(g, pred, maxTicks = 2400, controlsFn) {
  for (let i = 0; i < maxTicks; i++) {
    const ev = tick(g, controlsFn);
    if (pred(ev, g)) return i + 1;
  }
  return -1;
}

export function skipCountdown(g) { return runUntil(g, (ev) => ev.some((e) => e.type === EV.KICKOFF_GO), 600); }

// Place a car so it drives into the ball along `dir` (2D, normalized) at `speed`.
// Ball is placed at `ballPos` with velocity `ballVel`.
export function setupHit(world, car, ballPos, dir, speed, { dist = 190, ballVel = { x: 0, y: 0, z: 0 }, carZ = K.CAR_SPAWN_REST_Z, airborne = false } = {}) {
  const l = Math.hypot(dir.x, dir.y, dir.z || 0); const d = { x: dir.x / l, y: dir.y / l, z: (dir.z || 0) / l };
  world.ball.reset(ballPos.x, ballPos.y, ballPos.z);
  world.ball.body.vel.set(ballVel.x, ballVel.y, ballVel.z);
  const yaw = Math.atan2(d.y, d.x);
  car.setSpawn(ballPos.x - d.x * dist, ballPos.y - d.y * dist, airborne ? ballPos.z - d.z * dist - 20 : carZ, yaw);
  car.body.vel.set(d.x * speed, d.y * speed, d.z * speed);
  if (airborne) { car.isOnGround = false; car.numWheelsInContact = 0; car.hasJumped = true; }
}

export function park(world, car, x, y, yaw = Math.PI / 2) { car.setSpawn(x, y, K.CAR_SPAWN_REST_Z, yaw); }

export function stats(g, carId) { return g.match.getView().players.find((p) => p.carId === carId); }
export function statEvents(evs, kind, carId) { return evs.filter((e) => e.type === EV.STAT && (!kind || e.kind === kind) && (carId === undefined || e.carId === carId)); }

// Drive through celebration + replay at 60 fps until the state leaves 'goal'/'replay'
export function finishGoalSequence(g, maxSec = 20) {
  const out = [];
  for (let i = 0; i < maxSec * 60; i++) {
    g.match.frameUpdate(1 / 60);
    if (g.match.state !== 'replay') { out.push(...tick(g)); out.push(...tick(g)); }
    if (g.match.state !== 'goal' && g.match.state !== 'replay') break;
  }
  return out;
}

// Script: a car (team-side attacker) puts the ball into the goal of `defTeam`.
export function scoreGoal(g, car) {
  const s = car.team === 0 ? 1 : -1;
  setupHit(g.world, car, { x: 0, y: s * 4700, z: K.BALL_REST_Z }, { x: 0, y: s }, 1600);
  return runUntil(g, (ev) => ev.some((e) => e.type === EV.GOAL), 600);
}

// trivial ball-chaser bot: drive to a point behind the ball (relative to the opponent goal)
export function chaser(car, world, match, rng) {
  const c = makeControls();
  const mv = match.getView();
  if (mv.state === 'countdown' || mv.state === 'ended') return c;
  const b = world.ball.body.pos, p = car.body.pos;
  const goalY = car.team === 0 ? 5200 : -5200;
  const gx = -b.x, gy = goalY - b.y; const gl = Math.hypot(gx, gy) || 1;
  const tx = b.x - (gx / gl) * 150, ty = b.y - (gy / gl) * 150;
  const fwd = car.body.rot.forward, right = car.body.rot.right;
  const dx = tx - p.x, dy = ty - p.y;
  const lf = dx * fwd.x + dy * fwd.y, lr = dx * right.x + dy * right.y;
  const ang = Math.atan2(lr, lf);
  c.steer = Math.max(-1, Math.min(1, ang * 3));
  c.throttle = Math.abs(ang) > 2.2 && Math.hypot(dx, dy) < 600 ? -1 : 1;
  c.handbrake = Math.abs(ang) > 1.4 && car.forwardSpeed > 500;
  c.boost = Math.abs(ang) < 0.3 && car.boost > 0 && car.forwardSpeed < 2250;
  const dist = Math.hypot(b.x - p.x, b.y - p.y);
  if (dist < 300 && b.z > 200 && b.z < 450 && car.isOnGround && rng() < 0.3) c.jump = true;
  if (!car.isOnGround && car.hasJumped && car.airTimeSinceJump < 0.2) c.jump = true;
  if (car.body.rot.up.z < 0.2 && car.isOnGround) c.jump = rng() < 0.5;
  return c;
}
