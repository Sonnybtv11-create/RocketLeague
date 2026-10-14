// Match flow / stats / replay tests. Run: node src/game/tests/run.mjs
import * as H from './harness.mjs';
import { createReplayBuffer } from '../replay.js';
import * as R from '../match/rules.js';

const { EV, K, check } = H;
const types = (evs) => evs.map((e) => e.type);
const has = (evs, t) => evs.some((e) => e.type === t);

// park every car except the listed ones far from the action (side wall, midfield)
function parkOthers(g, keep = []) {
  let i = 0;
  for (const c of g.world.cars) {
    if (keep.includes(c)) continue;
    H.park(g.world, c, (i % 2 ? 1 : -1) * 3700, -300 + 300 * Math.floor(i / 2), 0);
    i++;
  }
}

function freshPlaying(opts) {
  const g = H.setup(opts);
  H.skipCountdown(g);
  return g;
}

// ===================================================================== countdown
export function testCountdown() {
  const g = H.setup();
  const car = g.world.cars[0];
  const p0 = car.body.pos.clone();
  const v0 = g.match.getView();
  check('countdown: initial state countdown, countdown=3, clock=300', v0.state === 'countdown' && v0.countdown === 3 && v0.clockSec === 300);
  const full = (c) => Object.assign(H.makeControls(), { throttle: 1, boost: true, jump: true });
  const evTicks = [];
  for (let i = 1; i <= 400; i++) {
    const ev = H.tick(g, full);
    for (const e of ev) if (e.type === EV.KICKOFF_COUNTDOWN || e.type === EV.KICKOFF_GO) evTicks.push([e.type === EV.KICKOFF_GO ? 'GO' : e.n, i]);
    if (i === 100) {
      check('countdown: cars frozen during countdown', g.world.carsFrozen === true && car.body.pos.dist(p0) < 3, `moved ${car.body.pos.dist(p0).toFixed(2)}`);
      check('countdown: MatchView.countdown=3 in first second', g.match.getView().countdown === 3);
    }
    if (i === 200) check('countdown: MatchView.countdown=2 in second second', g.match.getView().countdown === 2);
    if (i === 300) check('countdown: MatchView.countdown=1 in third second', g.match.getView().countdown === 1);
    if (i === 361) check('countdown: GO shown (countdown=0), state playing, cars unfrozen', g.match.getView().countdown === 0 && g.match.state === 'playing' && g.world.carsFrozen === false);
  }
  const want = [[3, 1], [2, 120], [1, 240], ['GO', 360]];
  check('countdown: 3,2,1,GO emitted at 0/1/2/3 s', JSON.stringify(evTicks) === JSON.stringify(want), JSON.stringify(evTicks));
  check('countdown: car moves after GO', car.body.pos.dist(p0) > 20, `moved ${car.body.pos.dist(p0).toFixed(1)}`);
  H.ticks(g, 120);
  check('countdown: GO overlay gone after 1 s (countdown=-1)', g.match.getView().countdown === -1);
}

// ===================================================================== clock
export function testClockFirstTouch() {
  const g = freshPlaying();
  H.ticks(g, 360); // 3 s idle after GO
  const v = g.match.getView();
  check('clock: does not run before the first touch', v.clockSec === 300 && v.isKickoffPause === true, `clock ${v.clockSec}`);
  const [blue, orange] = g.world.cars;
  parkOthers(g, [blue]);
  H.setupHit(g.world, blue, { x: 0, y: 0, z: K.BALL_KICKOFF_Z }, { x: 0, y: 1 }, 800);
  const evs = H.ticks(g, 120);
  const ft = H.statEvents(evs, 'firstTouch');
  check('clock: first touch stat emitted once for the toucher', ft.length === 1 && ft[0].carId === blue.id && ft[0].points === R.POINTS.firstTouch);
  const c = g.match.getView().clockSec;
  check('clock: runs after the first touch', c < 300 && c > 298.9, `clock ${c.toFixed(3)}`);
  check('clock: isKickoffPause false after touch', g.match.getView().isKickoffPause === false);

  const g2 = freshPlaying();
  H.ticks(g2, Math.round((R.KICKOFF_CLOCK_FALLBACK_SEC + 1) * 120));
  const c2 = g2.match.getView().clockSec;
  check('clock: starts anyway after the no-touch fallback', Math.abs(c2 - 299) < 0.02, `clock ${c2.toFixed(3)}`);
}

// ===================================================================== goal flow + replay
export function testGoalFlow() {
  const g = freshPlaying({ blue: 1, orange: 1 });
  const [blue, orange] = g.world.cars;
  H.ticks(g, 6 * 120 + 30); // > 6 s of frames so the full replay window exists (clock runs via fallback)
  parkOthers(g, [blue]);
  H.park(g.world, orange, 400, 4950, -Math.PI / 2); // a defender near the post, out of the ball's path
  H.ticks(g, 2);
  const oVel0 = orange.body.vel.len();
  const clockBefore = g.match.getView().clockSec;
  const n = H.scoreGoal(g, blue);
  const goalEv = g.events.filter((e) => e.type === EV.GOAL).pop();
  check('goal: scored', n > 0 && !!goalEv);
  if (!goalEv) return;
  const v = g.match.getView();
  check('goal: EV.goal team/scorer', goalEv.team === 0 && goalEv.scorerId === blue.id && goalEv.assistId === -1 && goalEv.ballSpeed > 500, `team ${goalEv.team} scorer ${goalEv.scorerId}`);
  check('goal: score 1-0, state goal, ballHidden', v.scores[0] === 1 && v.scores[1] === 0 && v.state === 'goal' && v.ballHidden === true);
  check('goal: lastGoal has names', v.lastGoal && v.lastGoal.scorerName === blue.name && v.lastGoal.assistName === null);
  const sp = H.stats(g, blue.id);
  check('goal: scorer stats goals=1 shots=1 score>=110', sp.goals === 1 && sp.shots === 1 && sp.score >= R.POINTS.goal + R.POINTS.shot, JSON.stringify(sp));
  check('goal: blast pushes nearby defender', orange.body.vel.len() > oVel0 + 500, `defender speed ${orange.body.vel.len().toFixed(0)}`);
  const bp = g.world.ball.body.pos;
  check('goal: ball parked out of play, asleep', Math.abs(bp.y) > 6000 && g.world.ball.isSleeping());
  // celebration
  let ticksToReplay = 0, evs = [], clockDuring = null, ballEvents = 0;
  while (g.match.state === 'goal' && ticksToReplay < 1000) {
    const ev = H.tick(g, () => Object.assign(H.makeControls(), { throttle: 1, boost: true }));
    evs.push(...ev);
    ballEvents += ev.filter((e) => e.type === EV.BALL_HIT || e.type === EV.GOAL).length;
    ticksToReplay++;
    clockDuring = g.match.getView().clockSec;
  }
  check('goal: ~3 s celebration then replayStart', Math.abs(ticksToReplay - R.CELEBRATION_SEC * 120) <= 1 && has(evs, EV.REPLAY_START), `${ticksToReplay} ticks`);
  check('goal: clock stopped during celebration', Math.abs(clockDuring - g.match.getView().clockSec) < 1e-9 && clockDuring <= clockBefore);
  check('goal: no ball events / extra goals during celebration', ballEvents === 0);
  // replay
  const rv = g.match.getReplayView();
  const mv = g.match.getView();
  check('replay: state replay, replayActive, ball visible', g.match.state === 'replay' && mv.replayActive && mv.ballHidden === false);
  check('replay: getReplayView gives an interpolated replay view', rv && rv.view && rv.view.isReplay === true && rv.view.cars.length === 2 && rv.cameraHint);
  const modes = [];
  let t = 0, lastBallY = null, follows = 0;
  while (g.match.state === 'replay' && t < 20) {
    g.match.frameUpdate(1 / 60); t += 1 / 60;
    const r = g.match.getReplayView();
    if (r) {
      if (modes[modes.length - 1] !== r.cameraHint.mode) modes.push(r.cameraHint.mode);
      if (r.cameraHint.mode === 'follow' && r.cameraHint.targetCarId === blue.id) follows++;
      lastBallY = r.view.ball.pos.y;
    }
  }
  const expectDur = R.REPLAY_BEFORE_SEC + R.REPLAY_AFTER_SEC;
  check('replay: real-time duration ≈ before+after window', Math.abs(t - expectDur) < 0.05, `${t.toFixed(3)} s vs ${expectDur}`);
  check('replay: camera cuts follow -> wide -> ball -> goal', JSON.stringify(modes) === JSON.stringify(['follow', 'wide', 'ball', 'goal']) && follows > 0, modes.join(','));
  check('replay: ball frozen in the net after the goal (not out of play)', lastBallY > 5124 && lastBallY < 5800, `y ${lastBallY && lastBallY.toFixed(0)}`);
  const after = H.ticks(g, 1);
  check('replay: replayEnd then kickoff countdown (n=3)', g.match.state === 'countdown' && types(after).indexOf(EV.REPLAY_END) >= 0 && after.some((e) => e.type === EV.KICKOFF_COUNTDOWN && e.n === 3) && types(after).indexOf(EV.REPLAY_END) < types(after).indexOf(EV.KICKOFF_COUNTDOWN));
  const b = g.world.ball.body.pos;
  check('kickoff after goal: ball at centre, cars at spawns, boost 33.33', Math.hypot(b.x, b.y) < 1 && g.world.cars.every((c) => Math.abs(Math.abs(c.body.pos.y) - 2560) < 5 || Math.abs(Math.abs(c.body.pos.y) - 3840) < 5 || Math.abs(Math.abs(c.body.pos.y) - 4608) < 5) && g.world.cars.every((c) => Math.abs(c.boost - 33.33) < 0.1));
  check('kickoff after goal: ballHidden false', g.match.getView().ballHidden === false);
}

export function testReplaySkip() {
  const g = freshPlaying();
  const [blue] = g.world.cars;
  H.ticks(g, 240);
  parkOthers(g, [blue]);
  H.scoreGoal(g, blue);
  H.runUntil(g, (ev) => has(ev, EV.REPLAY_START), 500);
  check('skip: in replay', g.match.state === 'replay');
  for (let i = 0; i < 30; i++) g.match.frameUpdate(1 / 60);
  g.match.skipReplay();
  check('skip: skipReplay leaves replay immediately', g.match.state === 'countdown' && g.match.getReplayView() === null);
  const ev = H.ticks(g, 1);
  check('skip: replayEnd + kickoffCountdown delivered on next tick', has(ev, EV.REPLAY_END) && has(ev, EV.KICKOFF_COUNTDOWN));
  g.match.skipReplay(); // no-op outside replay
  check('skip: no-op outside replay', g.match.state === 'countdown');
}

// replay buffer unit test
export function testReplayBuffer() {
  const rb = createReplayBuffer(R.REPLAY_BUFFER_SEC);
  const mk = (tick) => ({ tick, time: tick / 120, ball: { pos: new H.Vec3(0, tick, 93), vel: new H.Vec3(0, 120, 0), angVel: new H.Vec3(), rot: { m: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), clone() { return this; } } }, cars: [], pads: [] });
  for (let t = 1; t <= 3000; t++) rb.record(mk(t));
  check('buffer: ring keeps capacity frames (>= 8 s)', rb.size === rb.capacity && rb.capacity >= 8 * 120 && rb.latestTick() === 3000);
  const r = rb.range(2000, 2100);
  check('buffer: range returns contiguous frames', r.length === 101 && r[0].tick === 2000 && r[100].tick === 2100);
  const pb = rb.startPlayback(6);
  check('buffer: playback of 6 s has 721 frames, 6.0 s', pb && pb.frameCount === 721 && Math.abs(pb.duration - 6) < 1e-9);
  const res = pb.update(0.5 + 0.5 / 120);
  check('buffer: playback interpolates between ticks', res && Math.abs(res.view.ball.pos.y - (3000 - 720 + 60.5)) < 1e-6, `${res && res.view.ball.pos.y}`);
  pb.skip();
  check('buffer: skip ends playback', pb.update(0.01) === null);
  const pb2 = rb.startPlayback(1);
  let n = 0; while (pb2.update(1 / 60)) n++;
  check('buffer: 1 s playback lasts 60 frames at 60 fps', n === 60, `${n}`);
}

// ===================================================================== zero-second rule
function launchBallUp(g, z = 1200, vz = 900) {
  g.world.ball.reset(-2000, -1000, z);
  g.world.ball.body.vel.set(0, 0, vz);
}

export function testZeroSecondEnds() {
  const g = freshPlaying();
  const [blue, orange] = g.world.cars;
  parkOthers(g, [blue]);
  H.scoreGoal(g, blue); // 1-0
  H.finishGoalSequence(g);
  H.skipCountdown(g);
  parkOthers(g, [blue]);
  H.setupHit(g.world, blue, { x: 0, y: 0, z: K.BALL_KICKOFF_Z }, { x: 1, y: 0 }, 500); // first touch -> clock runs
  H.ticks(g, 30);
  park(g, blue, orange);
  g.match.setClock(0.25);
  launchBallUp(g);
  let zeroTick = -1, endTick = -1, waiting = false;
  for (let i = 0; i < 1200; i++) {
    const ev = H.tick(g);
    const v = g.match.getView();
    if (zeroTick < 0 && v.clockSec === 0) { zeroTick = i; waiting = v.waitingForBallToLand && v.state === 'playing'; }
    if (has(ev, EV.MATCH_END)) { endTick = i; break; }
  }
  const v = g.match.getView();
  check('zero-second: at 0:00 with ball in the air, match continues (waitingForBallToLand)', zeroTick >= 0 && waiting);
  check('zero-second: match ends only when the ball lands', endTick - zeroTick > 120 && v.state === 'ended' && v.winner === 0, `waited ${((endTick - zeroTick) / 120).toFixed(2)} s`);
  check('zero-second: ball was on the floor at the end', g.world.ball.body.pos.z < 140, `z ${g.world.ball.body.pos.z.toFixed(1)}`);
  check('match end: MVP is the top scorer of the winning team, cars frozen', v.mvpId === blue.id && g.world.carsFrozen === true);
  check('match end: isEnded / isRunning', g.match.isEnded() && !g.match.isRunning());
}
function park(g, ...cars) { cars.forEach((c, i) => H.park(g.world, c, 3700 * (i ? 1 : -1), 0, 0)); }

export function testZeroSecondGoalCounts() {
  const g = freshPlaying();
  const [blue, orange] = g.world.cars;
  parkOthers(g, [blue]);
  // blue touches the ball high toward the orange goal (lob), clock runs out while it flies
  H.setupHit(g.world, blue, { x: 0, y: 3000, z: K.BALL_REST_Z }, { x: 0, y: 1 }, 600);
  H.ticks(g, 20);
  g.world.ball.reset(0, 3600, 500);
  g.world.ball.body.vel.set(0, 1500, 350);
  park(g, blue, orange);
  g.match.setClock(0.2);
  let sawWaiting = false, goal = null;
  for (let i = 0; i < 600 && !goal; i++) {
    const ev = H.tick(g);
    if (g.match.getView().waitingForBallToLand) sawWaiting = true;
    goal = ev.find((e) => e.type === EV.GOAL);
  }
  check('zero-second: goal scored while waiting for the ball counts', sawWaiting && goal && goal.team === 0 && g.match.getView().scores[0] === 1);
  const ev = H.finishGoalSequence(g);
  const v = g.match.getView();
  check('zero-second: replay shown, then match ends with the winner', has(ev, EV.REPLAY_START) && has(ev, EV.MATCH_END) && v.state === 'ended' && v.winner === 0, `state ${v.state}`);
  const me = ev.find((e) => e.type === EV.MATCH_END);
  check('zero-second: EV.matchEnd winner payload', me && me.winner === 0);
}

export function testOvertime() {
  const g = freshPlaying();
  const [blue, orange] = g.world.cars;
  parkOthers(g, [blue]);
  H.setupHit(g.world, blue, { x: 0, y: 0, z: K.BALL_KICKOFF_Z }, { x: 1, y: 0 }, 300);
  H.ticks(g, 30);
  park(g, blue, orange);
  g.world.ball.reset(0, 0, K.BALL_REST_Z); g.world.ball.body.vel.set(200, 0, 0); // rolling on the floor
  g.match.setClock(0.1);
  const ev = H.ticks(g, 30);
  const v = g.match.getView();
  check('overtime: tie at 0:00 with ball on the floor -> EV.overtime + kickoff countdown', has(ev, EV.OVERTIME) && v.isOvertime && v.state === 'countdown' && !has(ev, EV.MATCH_END));
  H.skipCountdown(g);
  H.ticks(g, 240);
  check('overtime: OT clock waits for the first touch', g.match.getView().overtimeSec === 0);
  parkOthers(g, [orange]);
  H.setupHit(g.world, orange, { x: 0, y: 0, z: K.BALL_KICKOFF_Z }, { x: 1, y: 0 }, 300);
  H.ticks(g, 240);
  const ot = g.match.getView().overtimeSec;
  check('overtime: clock counts up after the touch', ot > 1.8 && ot < 2.0, `+${ot.toFixed(2)}`);
  H.scoreGoal(g, orange);
  const ge = g.events.filter((e) => e.type === EV.GOAL).pop();
  check('overtime: goal', ge && ge.team === 1);
  const otGoal = H.statEvents(g.events, 'overtimeGoal', orange.id);
  check('overtime: overtime-goal bonus awarded', otGoal.length === 1 && otGoal[0].points === R.POINTS.overtimeGoal);
  const ev2 = H.finishGoalSequence(g);
  const v2 = g.match.getView();
  check('overtime: first goal wins (replay, then ended)', has(ev2, EV.REPLAY_START) && v2.state === 'ended' && v2.winner === 1 && v2.mvpId === orange.id);
}

// ===================================================================== stats
export function testShot() {
  const g = freshPlaying();
  const [blue] = g.world.cars;
  parkOthers(g, [blue]);
  H.setupHit(g.world, blue, { x: 0, y: 1500, z: K.BALL_REST_Z }, { x: 0, y: 1 }, 1800);
  const ev = H.ticks(g, 60);
  const shots = H.statEvents(ev, 'shot', blue.id);
  check('shot: touch toward the goal is a shot (+points)', shots.length === 1 && shots[0].points === R.POINTS.shot && H.stats(g, blue.id).shots === 1);
  // touch it again on the way (same possession) -> no second shot
  const b = g.world.ball.body;
  H.setupHit(g.world, blue, { x: b.pos.x, y: b.pos.y, z: K.BALL_REST_Z }, { x: 0, y: 1 }, 2200, { ballVel: { x: 0, y: b.vel.y * 0.5, z: 0 } });
  const ev2 = H.ticks(g, 30);
  check('shot: only one shot per possession', H.statEvents(ev2, 'shot').length === 0 && H.stats(g, blue.id).shots === 1);
  // a wide touch is not a shot
  const g2 = freshPlaying();
  const [b2] = g2.world.cars;
  parkOthers(g2, [b2]);
  H.setupHit(g2.world, b2, { x: 0, y: 0, z: K.BALL_REST_Z }, { x: 1, y: 0.15 }, 1500);
  const ev3 = H.ticks(g2, 60);
  check('shot: a touch toward the side wall is not a shot', H.statEvents(ev3, 'shot').length === 0);
}

export function testSave() {
  const g = freshPlaying();
  const [blue, orange] = g.world.cars;
  parkOthers(g, []);
  // orange shoots toward the blue goal, blue defender blocks
  H.setupHit(g.world, orange, { x: 0, y: -2500, z: K.BALL_REST_Z }, { x: 0, y: -1 }, 2000);
  const ev0 = H.ticks(g, 20);
  check('save: attacker credited a shot', H.statEvents(ev0, 'shot', orange.id).length === 1);
  H.park(g.world, orange, 3700, 0, 0);
  g.world.ball.reset(0, -3000, K.BALL_REST_Z); g.world.ball.body.vel.set(0, -2200, 0); // ground shot
  H.park(g.world, blue, 0, -4200, Math.PI / 2);
  blue.body.vel.set(0, 300, 0);
  const ev = H.ticks(g, 120);
  const saves = H.statEvents(ev).filter((e) => e.kind === 'save' || e.kind === 'epicSave');
  check('save: defender blocking a goal-bound ball gets a save', saves.length === 1 && saves[0].carId === blue.id && saves[0].kind === 'save' && H.stats(g, blue.id).saves === 1, saves.map((s) => s.kind).join(','));
  check('save: no goal', g.match.getView().scores[1] === 0);

  // epic save: ball almost over the line
  const g2 = freshPlaying();
  const [b2, o2] = g2.world.cars;
  parkOthers(g2, []);
  H.setupHit(g2.world, o2, { x: 0, y: -4000, z: K.BALL_REST_Z }, { x: 0, y: -1 }, 2000);
  H.ticks(g2, 12);
  H.park(g2.world, o2, 3700, 0, 0);
  g2.world.ball.reset(0, -4300, K.BALL_REST_Z); g2.world.ball.body.vel.set(0, -1800, 0);
  H.ticks(g2, 12);
  const bb = g2.world.ball.body;
  H.ticks(g2, Math.max(0, Math.floor((bb.pos.y + 4950) / (-bb.vel.y) * 120) - 2));
  // defender arrives on the line at the last moment
  H.park(g2.world, b2, bb.pos.x, -5050, Math.PI / 2);
  b2.body.vel.set(0, 600, 0);
  const ev2 = H.ticks(g2, 120);
  const es = H.statEvents(ev2, 'epicSave', b2.id);
  check('save: last-moment block on the line is an EPIC save (+75)', es.length === 1 && es[0].points === R.POINTS.epicSave && H.stats(g2, b2.id).saves === 1 && g2.match.getView().scores[1] === 0,
    `${H.statEvents(ev2).map((e) => e.kind).join(',')} score ${g2.match.getView().scores}`);
}

export function testClearCentreAerial() {
  const g = freshPlaying();
  const [blue] = g.world.cars;
  parkOthers(g, [blue]);
  H.setupHit(g.world, blue, { x: 300, y: -4200, z: K.BALL_REST_Z }, { x: 0.15, y: 1 }, 2200);
  const ev = H.ticks(g, 60);
  check('clear: hard touch out of the defensive third is a clear (+20)', H.statEvents(ev, 'clear', blue.id).length === 1 && H.statEvents(ev, 'clear')[0].points === R.POINTS.clear);

  const g2 = freshPlaying();
  const [b2] = g2.world.cars;
  parkOthers(g2, [b2]);
  H.setupHit(g2.world, b2, { x: 2900, y: 3900, z: K.BALL_REST_Z }, { x: -1, y: 0.05 }, 1700);
  const ev2 = H.ticks(g2, 60);
  check('centre: pass from the corner across the goal mouth is a centre (+10)', H.statEvents(ev2, 'centre', b2.id).length === 1 && H.statEvents(ev2, 'shot').length === 0,
    H.statEvents(ev2).map((e) => e.kind).join(','));

  const g3 = freshPlaying();
  const [b3] = g3.world.cars;
  parkOthers(g3, [b3]);
  H.setupHit(g3.world, b3, { x: 0, y: -1000, z: 900 }, { x: 0, y: 1, z: 0.2 }, 1200, { airborne: true, ballVel: { x: 0, y: 0, z: 0 } });
  const ev3 = H.ticks(g3, 30);
  const ah = H.statEvents(ev3, 'aerialHit', b3.id);
  check('aerial: touch while airborne above goal height is an aerial hit', ah.length === 1 && ah[0].points === R.POINTS.aerialHit);
  const g4 = freshPlaying();
  const [b4] = g4.world.cars;
  parkOthers(g4, [b4]);
  H.setupHit(g4.world, b4, { x: 0, y: -1000, z: K.BALL_REST_Z }, { x: 0, y: 1 }, 1200);
  check('aerial: a ground touch is not an aerial hit', H.statEvents(H.ticks(g4, 30), 'aerialHit').length === 0);
}

export function testAssist() {
  const g = freshPlaying({ blue: 2, orange: 1 });
  const [a, b, o] = g.world.cars;
  parkOthers(g, [a]);
  H.setupHit(g.world, a, { x: -1500, y: 2500, z: K.BALL_REST_Z }, { x: 0.3, y: 1 }, 1000);
  H.ticks(g, 40);
  check('assist: passer touched the ball', g.world.lastTouch && g.world.lastTouch.carId === a.id);
  H.park(g.world, a, -3700, 0, 0);
  H.ticks(g, 60);
  H.scoreGoal(g, b);
  const ge = g.events.filter((e) => e.type === EV.GOAL).pop();
  check('assist: EV.goal assistId = passer, scorerId = finisher', ge && ge.scorerId === b.id && ge.assistId === a.id);
  check('assist: assist stat (+50) and MatchView.lastGoal.assistName', H.stats(g, a.id).assists === 1 && H.statEvents(g.events, 'assist', a.id)[0].points === R.POINTS.assist && g.match.getView().lastGoal.assistName === a.name);
  // a pass longer ago than the window is not an assist
  H.finishGoalSequence(g);
  H.skipCountdown(g);
  parkOthers(g, [a]);
  H.setupHit(g.world, a, { x: -1500, y: 0, z: K.BALL_KICKOFF_Z }, { x: 0, y: 1 }, 600);
  H.ticks(g, 30);
  H.park(g.world, a, -3700, 0, 0);
  H.ticks(g, Math.round((R.ASSIST_WINDOW_SEC + 0.5) * 120));
  H.scoreGoal(g, b);
  const ge2 = g.events.filter((e) => e.type === EV.GOAL).pop();
  check('assist: no assist when the pass is older than the window', ge2 && ge2.scorerId === b.id && ge2.assistId === -1);
  // own goal: orange last touch into its own net -> credited to last blue toucher, flagged ownGoal
  H.finishGoalSequence(g);
  H.skipCountdown(g);
  parkOthers(g, [b]);
  H.setupHit(g.world, b, { x: 0, y: 0, z: K.BALL_KICKOFF_Z }, { x: 0, y: 1 }, 400);
  H.ticks(g, 30);
  H.park(g.world, b, 3700, 0, 0);
  H.setupHit(g.world, o, { x: 0, y: 4600, z: K.BALL_REST_Z }, { x: 0, y: 1 }, 1500);
  H.runUntil(g, (ev) => has(ev, EV.GOAL), 400);
  const ge3 = g.events.filter((e) => e.type === EV.GOAL).pop();
  check('own goal: credited to the last attacker, flagged ownGoal', ge3 && ge3.team === 0 && ge3.scorerId === b.id && ge3.ownGoal === true);
}

export function testDemoStat() {
  const g = freshPlaying({ blue: 2, orange: 1 });
  const [a, mate, o] = g.world.cars;
  g.injectAfterStep = (w) => w.demolish(o, a);
  const ev = H.ticks(g, 1);
  check('demo: EV.demo by an opponent credits a demolition stat', H.stats(g, a.id).demos === 1 && H.statEvents(ev, 'demo', a.id).length === 1);
  g.injectAfterStep = (w) => w.demolish(mate, a);
  H.ticks(g, 1);
  check('demo: team-kill does not count', H.stats(g, a.id).demos === 1);
  for (let i = 0; i < 6; i++) { H.ticks(g, 400); g.injectAfterStep = (w) => w.demolish(o, a); H.ticks(g, 1); }
  check('demo: extermination bonus at 7 demos', H.stats(g, a.id).demos === 7 && H.statEvents(g.events, 'extermination', a.id).length === 1);
}

// ===================================================================== free play
export function testFreeplay() {
  const g = H.setup({ blue: 1, orange: 0, mode: 'freeplay' });
  const [car] = g.world.cars;
  car.setSpawn(0, -2500, K.CAR_SPAWN_REST_Z, Math.PI / 2, 100);
  const v = g.match.getView();
  check('freeplay: state playing, no countdown, mode freeplay', v.state === 'playing' && v.mode === 'freeplay' && v.countdown === -1 && !g.world.carsFrozen);
  const ev0 = H.ticks(g, 10);
  check('freeplay: no countdown events', !has(ev0, EV.KICKOFF_COUNTDOWN) && !has(ev0, EV.KICKOFF_GO));
  H.setupHit(g.world, car, { x: 0, y: 4600, z: K.BALL_REST_Z }, { x: 0, y: 1 }, 1500);
  H.runUntil(g, (ev) => has(ev, EV.GOAL), 400);
  const carPos = car.body.pos.clone();
  const v1 = g.match.getView();
  check('freeplay: goal explodes ball (ballHidden), no score, still playing', v1.ballHidden && v1.state === 'playing' && v1.scores[0] === 0);
  const ev = H.ticks(g, Math.round(R.FREEPLAY_RESPAWN_SEC * 120) + 2);
  const b = g.world.ball.body.pos;
  check('freeplay: ball respawns at centre from z≈393 after ~2 s', !g.match.getView().ballHidden && Math.hypot(b.x, b.y) < 1 && b.z > 300 && b.z < 400, `${b.x.toFixed(0)},${b.y.toFixed(0)},${b.z.toFixed(0)}`);
  check('freeplay: car not reset, no replay/stat events', car.body.pos.dist(carPos) > 1 && Math.abs(car.body.pos.y + 2500) > 100 && !has(ev, EV.REPLAY_START) && !has(g.events, EV.STAT));
  H.setupHit(g.world, car, { x: 0, y: 4600, z: K.BALL_REST_Z }, { x: 0, y: 1 }, 1500);
  check('freeplay: a second goal works', H.runUntil(g, (e) => has(e, EV.GOAL), 400) > 0);
  g.match.resetBall();
  check('freeplay: resetBall respawns immediately', !g.match.getView().ballHidden && Math.hypot(g.world.ball.body.pos.x, g.world.ball.body.pos.y) < 1);
  check('freeplay: clock 0 / not overtime', g.match.getView().clockSec === 0 && !g.match.getView().isOvertime);
}

// ===================================================================== MatchView contract
export function testViewContract() {
  const g = H.setup({ blue: 2, orange: 2 });
  const v = g.match.getView();
  const keys = ['mode', 'state', 'clockSec', 'isOvertime', 'overtimeSec', 'countdown', 'scores', 'players', 'lastGoal', 'winner', 'mvpId', 'replayActive', 'ballHidden', 'waitingForBallToLand'];
  check('view: has every documented MatchView field', keys.every((k) => k in v), keys.filter((k) => !(k in v)).join(','));
  const pk = ['carId', 'name', 'team', 'isBot', 'goals', 'assists', 'saves', 'shots', 'demos', 'score'];
  check('view: players have every documented field', v.players.length === 4 && v.players.every((p) => pk.every((k) => k in p)));
  check('view: cached object (same reference each call)', g.match.getView() === v);
}

export const ALL = [
  testCountdown, testClockFirstTouch, testGoalFlow, testReplaySkip, testReplayBuffer,
  testZeroSecondEnds, testZeroSecondGoalCounts, testOvertime,
  testShot, testSave, testClearCentreAerial, testAssist, testDemoStat,
  testFreeplay, testViewContract,
];
