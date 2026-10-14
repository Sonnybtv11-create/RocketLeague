// OWNER: Match flow & replay agent.
// Soccar match flow: kickoff countdown, clock (paused until the first touch of
// each kickoff), goals with explosion blast + celebration + replay, zero-second
// rule, sudden-death overtime, stats & points, free play. Rules and sources:
// src/game/match/RULES.md.
//
// createMatch({ world, mode: 'exhibition'|'freeplay', teamSize, durationSec = 300, rng }) -> Match
// Match: {
//   state: 'countdown'|'playing'|'goal'|'replay'|'ended',
//   preTick(), postTick(worldEvents) -> events[] (contract EV events),
//   frameUpdate(frameDt)             real-time replay playback,
//   getView() -> MatchView           (cached object, updated in place),
//   getReplayView() -> { view, cameraHint } | null   (state === 'replay'),
//   skipReplay(), resetBall() (free play), recordFrame(frame) (every tick, captureFrame()),
//   isRunning(), isEnded(),
//   stats (per-player tracker), replay (ring buffer), setClock(sec) (debug/tests)
// }
// MatchView: see INTERFACES.md. Extra fields: isKickoffPause (clock waiting for
// the first touch), lastGoal.ownGoal.
import { EV } from '../contracts.js';
import * as K from '../sim/const.js';
import * as R from './match/rules.js';
import { createStats } from './match/stats.js';
import { createReplayBuffer } from './replay.js';

const TPS = K.TICK_RATE;
const NET_BACK_Y = 6000;

export function createMatch({ world, mode = 'exhibition', teamSize = 1, durationSec = 300, rng = Math.random } = {}) {
  const freeplay = mode === 'freeplay';
  const dt = world.dt || K.TICK_TIME;

  let state = freeplay ? 'playing' : 'countdown';
  let clock = durationSec;
  let isOvertime = false, overtimeSec = 0, regulationOver = false;
  let countdownT = 0, goShownT = 0, sinceGo = 0;
  const scores = [0, 0];
  let lastGoal = null, winner = null, mvpId = null;
  let ballHidden = false, waitingForBallToLand = false;
  let goalT = 0, goalTick = -1, goalInfo = null, afterGoal = 'kickoff';
  let fpRespawnT = 0;
  let playback = null, replayResult = null;

  // events produced outside postTick (frameUpdate / skipReplay) are flushed on the next postTick
  const queue = [];
  let sink = queue;
  const emit = (e) => { e.tick = world.tick; sink.push(e); };

  const stats = createStats({ world, emit });
  const replay = createReplayBuffer(R.REPLAY_BUFFER_SEC);

  const view = {
    mode, state, clockSec: freeplay ? 0 : clock, isOvertime: false, overtimeSec: 0, countdown: -1,
    scores, players: stats.players, lastGoal: null, winner: null, mvpId: null,
    replayActive: false, ballHidden: false, waitingForBallToLand: false, isKickoffPause: false,
  };

  // ------------------------------------------------------------------ helpers
  function enterCountdown() {
    world.resetKickoff();
    world.carsFrozen = true;
    state = 'countdown';
    countdownT = R.COUNTDOWN_SEC;
    goShownT = 0; sinceGo = 0;
    ballHidden = false; waitingForBallToLand = false;
    stats.onKickoff();
    replay.clear();
    emit({ type: EV.KICKOFF_COUNTDOWN, n: R.COUNTDOWN_SEC });
  }

  function ballOnFloor(worldEvents) {
    for (const e of worldEvents) if (e.type === EV.BALL_BOUNCE && e.normal && e.normal.z > R.FLOOR_NORMAL_Z) return true;
    const b = world.ball.body;
    return b.pos.z < R.ROLLING_Z && Math.abs(b.vel.z) < R.ROLLING_VZ;
  }

  // Ball out of play: park it, asleep, behind the back of the net it went into.
  // A sleeping ball is never integrated or collided, so it produces no events.
  function hideBall(pos) {
    const side = pos.y >= 0 ? 1 : -1;
    const x = Math.max(-700, Math.min(700, pos.x));
    const z = Math.max(K.BALL_REST_Z, Math.min(500, pos.z));
    world.ball.reset(x, side * (NET_BACK_Y + 400), z);
    ballHidden = true;
  }

  function applyBlast(pos) {
    for (const car of world.cars) {
      if (car.isDemoed) continue;
      const b = car.body;
      const dx = b.pos.x - pos.x, dy = b.pos.y - pos.y, dz = b.pos.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d >= R.BLAST_RADIUS) continue;
      const f = 1 - d / R.BLAST_RADIUS;
      let nx = 0, ny = 0, nz = 1;
      if (d > 1e-3) {
        nx = dx / d; ny = dy / d; nz = dz / d + R.BLAST_UP_BIAS;
        const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      }
      const sp = R.BLAST_MAX_SPEED * f;
      b.vel.x += nx * sp; b.vel.y += ny * sp; b.vel.z += nz * sp;
      const spin = R.BLAST_MAX_SPIN * f;
      b.angVel.x += (rng() * 2 - 1) * spin; b.angVel.y += (rng() * 2 - 1) * spin; b.angVel.z += (rng() * 2 - 1) * spin * 0.5;
    }
  }

  function nameOf(id) { const c = id >= 0 ? world.getCar(id) : null; return c ? c.name : null; }

  function handleGoal() {
    const team = world.goalScored.team;
    const bb = world.ball.body;
    const pos = bb.pos.clone();
    const ballSpeed = bb.vel.len();
    let scorerId = -1, assistId = -1, ownGoal = false;
    if (freeplay) {
      scorerId = world.lastTouch ? world.lastTouch.carId : -1;
      stats.onGoal(team, { enabled: false });
    } else {
      scores[team]++;
      ({ scorerId, assistId, ownGoal } = stats.onGoal(team, { overtime: isOvertime, enabled: true }));
    }
    const scorerName = nameOf(scorerId), assistName = nameOf(assistId);
    lastGoal = { team, scorerId, scorerName, assistId, assistName, ballSpeed, ownGoal };
    emit({ type: EV.GOAL, team, scorerId, assistId, pos, ballSpeed, scorerName, assistName, ownGoal });
    applyBlast(pos);
    hideBall(pos);
    waitingForBallToLand = false;
    goalTick = world.tick;
    goalInfo = { team, scorerId, pos };
    if (freeplay) { fpRespawnT = R.FREEPLAY_RESPAWN_SEC; return; }
    state = 'goal';
    goalT = R.CELEBRATION_SEC;
    if (isOvertime) afterGoal = 'end';
    else if (regulationOver) afterGoal = scores[0] !== scores[1] ? 'end' : 'overtime';
    else afterGoal = 'kickoff';
  }

  function startReplay() {
    // the frame recorded on the goal tick already has the ball parked out of play,
    // so the replay's goal moment (and ball freeze) is the tick before
    const gt = goalTick - 1;
    const pb = replay.startPlayback({
      fromTick: gt - Math.round(R.REPLAY_BEFORE_SEC * TPS),
      toTick: gt + Math.round(R.REPLAY_AFTER_SEC * TPS),
      goalTick: gt, scorerId: goalInfo ? goalInfo.scorerId : -1, goalTeam: goalInfo ? goalInfo.team : -1,
      freezeBallAfterTick: gt,
    });
    if (!pb) { afterReplay(); return; }
    playback = pb;
    state = 'replay';
    ballHidden = false;
    replayResult = playback.update(0);
    emit({ type: EV.REPLAY_START });
  }

  function finishReplay() {
    playback = null; replayResult = null;
    emit({ type: EV.REPLAY_END });
    afterReplay();
  }

  function afterReplay() {
    if (afterGoal === 'end') endMatch();
    else if (afterGoal === 'overtime') startOvertime();
    else enterCountdown();
  }

  function startOvertime() {
    isOvertime = true;
    overtimeSec = 0;
    regulationOver = true;
    emit({ type: EV.OVERTIME });
    enterCountdown();
  }

  function endMatch() {
    state = 'ended';
    waitingForBallToLand = false;
    winner = scores[0] > scores[1] ? 0 : scores[1] > scores[0] ? 1 : null;
    mvpId = winner == null ? null : stats.mvp(winner);
    world.carsFrozen = true;
    emit({ type: EV.MATCH_END, winner, mvpId, scores: [...scores] });
  }

  function respawnFreeplayBall() {
    world.ball.reset(0, 0, K.BALL_REST_Z + 300);
    world.ball.body.vel.set(0, 0, -1);
    world.goalScored = null;
    world.lastTouch = null;
    ballHidden = false;
    fpRespawnT = 0;
    stats.onKickoff();
  }

  // ------------------------------------------------------------------ per tick
  function tickPlaying(worldEvents) {
    if (freeplay) {
      if (fpRespawnT > 0) {
        fpRespawnT -= dt;
        if (fpRespawnT <= 0) respawnFreeplayBall();
        return;
      }
      stats.onTick(worldEvents, false);
      if (world.goalScored) handleGoal();
      return;
    }
    if (goShownT > 0) goShownT -= dt;
    stats.onTick(worldEvents, true);
    if (world.goalScored) { handleGoal(); return; }
    sinceGo += dt;
    const running = stats.kickoffTouched || sinceGo >= R.KICKOFF_CLOCK_FALLBACK_SEC;
    if (isOvertime) {
      if (running) overtimeSec += dt;
      return;
    }
    if (!regulationOver && running) {
      clock = Math.max(0, clock - dt);
      if (clock <= 1e-9) { clock = 0; regulationOver = true; waitingForBallToLand = true; }
    }
    if (waitingForBallToLand && ballOnFloor(worldEvents)) {
      waitingForBallToLand = false;
      if (scores[0] !== scores[1]) endMatch();
      else startOvertime();
    }
  }

  const m = {
    get state() { return state; },
    stats, replay,

    preTick() {
      world.carsFrozen = state === 'countdown' || state === 'ended';
    },

    postTick(worldEvents = world.events) {
      const out = queue.splice(0);
      sink = out;
      try {
        switch (state) {
          case 'countdown': {
            const before = Math.ceil(countdownT - 1e-9);
            countdownT -= dt;
            const now = Math.ceil(countdownT - 1e-9);
            if (countdownT <= 1e-9) {
              state = 'playing';
              world.carsFrozen = false;
              goShownT = R.GO_SHOWN_SEC;
              sinceGo = 0;
              emit({ type: EV.KICKOFF_GO });
            } else if (now !== before) emit({ type: EV.KICKOFF_COUNTDOWN, n: now });
            break;
          }
          case 'playing': tickPlaying(worldEvents); break;
          case 'goal':
            stats.onDemosOnly(worldEvents);
            goalT -= dt;
            if (goalT <= 1e-9) startReplay();
            break;
          default: break; // 'replay' (world not stepped by main) / 'ended'
        }
      } finally { sink = queue; }
      return out;
    },

    frameUpdate(frameDt) {
      if (state !== 'replay' || !playback) return;
      const res = playback.update(frameDt);
      if (res) replayResult = res;
      else finishReplay();
    },

    getReplayView() {
      return state === 'replay' && replayResult ? replayResult : null;
    },

    skipReplay() {
      if (state === 'replay') finishReplay();
    },

    resetBall() {
      if (!freeplay) return;
      respawnFreeplayBall();
    },

    recordFrame(frame) {
      if (state !== 'replay') replay.record(frame);
    },

    setClock(sec) { clock = Math.max(0, sec); },

    isRunning() { return state !== 'ended'; },
    isEnded() { return state === 'ended'; },

    getView() {
      view.state = state;
      view.clockSec = freeplay ? 0 : clock;
      view.isOvertime = isOvertime;
      view.overtimeSec = overtimeSec;
      view.countdown = state === 'countdown' ? Math.max(1, Math.ceil(countdownT - 1e-9)) : (state === 'playing' && goShownT > 0 ? 0 : -1);
      view.lastGoal = lastGoal;
      view.winner = winner;
      view.mvpId = mvpId;
      view.replayActive = state === 'replay';
      view.ballHidden = ballHidden && state !== 'replay';
      view.waitingForBallToLand = waitingForBallToLand;
      view.isKickoffPause = !freeplay && state === 'playing' && !stats.kickoffTouched && sinceGo < R.KICKOFF_CLOCK_FALLBACK_SEC;
      if (view.players.length !== world.cars.length) stats.syncPlayers();
      return view;
    },
  };

  if (!freeplay) enterCountdown();
  else { world.carsFrozen = false; stats.onKickoff(); }
  return m;
}
