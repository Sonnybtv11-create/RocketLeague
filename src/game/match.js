// OWNER: Match flow & replay agent. STUB — minimal kickoff/goal loop.
// createMatch({ world, mode: 'exhibition'|'freeplay', teamSize, durationSec, rng, players }) -> Match
// Match: {
//   state: 'countdown'|'playing'|'goal'|'replay'|'ended',
//   preTick(), postTick(worldEvents) -> events[] (contract EV events),
//   frameUpdate(frameDt) (real-time things like replay playback), getView() -> MatchView,
//   getReplayView() -> { view, cameraHint } | null (when state === 'replay'),
//   skipReplay(), resetBall() (free play), recordFrame(frame) (called every tick by main with captureFrame()),
//   isRunning(), isEnded()
// }
// MatchView: { mode, state, clockSec, isOvertime, countdown, scores:[b,o], players:[{carId,name,team,isBot,goals,assists,saves,shots,demos,score}],
//              lastGoal, winner, mvpId, replayActive, freeplay:{...} }
import { EV } from '../contracts.js';

export function createMatch({ world, mode = 'exhibition', durationSec = 300 }) {
  let state = 'countdown', countdownT = 3, clock = durationSec, scores = [0, 0], goalT = 0;
  const m = {
    get state() { return state; },
    preTick() { world.carsFrozen = state === 'countdown'; },
    postTick(ev) {
      const out = []; const dt = world.dt;
      if (state === 'countdown') {
        const before = Math.ceil(countdownT); countdownT -= dt;
        if (Math.ceil(countdownT) !== before && countdownT > 0) out.push({ type: EV.KICKOFF_COUNTDOWN, n: Math.ceil(countdownT) });
        if (countdownT <= 0) { state = 'playing'; out.push({ type: EV.KICKOFF_GO }); }
      } else if (state === 'playing') {
        if (mode !== 'freeplay' && world.lastTouch) clock = Math.max(0, clock - dt);
        if (world.goalScored) {
          const t = world.goalScored.team; scores[t]++; state = 'goal'; goalT = 3;
          const lt = world.lastTouch;
          out.push({ type: EV.GOAL, team: t, scorerId: lt ? lt.carId : -1, pos: world.ball.body.pos.clone(), ballSpeed: world.ball.body.vel.len() });
        }
      } else if (state === 'goal') {
        goalT -= dt;
        if (goalT <= 0) { world.resetKickoff(); state = 'countdown'; countdownT = 3; out.push({ type: EV.KICKOFF_COUNTDOWN, n: 3 }); }
      }
      return out;
    },
    frameUpdate() {},
    getView() { return { mode, state, clockSec: clock, isOvertime: false, countdown: Math.ceil(countdownT), scores: [...scores], players: [], replayActive: false }; },
    getReplayView() { return null; },
    skipReplay() {}, resetBall() { world.ball.reset(); }, recordFrame() {},
    isRunning() { return state !== 'ended'; }, isEnded() { return state === 'ended'; },
  };
  return m;
}
