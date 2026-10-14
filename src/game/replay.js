// OWNER: Match flow & replay agent.
// Goal replays: a 120 Hz ring buffer of captureFrame() frames and a real-time
// playback that interpolates them with interpolateFrames(), so cars and ball move
// exactly as they did live.
//
// createReplayBuffer(seconds = 12) -> {
//   record(frame), clear(), size, capacity,
//   range(fromTick, toTick) -> frames[] (contiguous, oldest first),
//   latestTick() -> tick of the newest frame (or -1),
//   startPlayback(opts) -> Playback | null
// }
//   opts: number (seconds back from the newest frame) or
//         { fromTick, toTick, goalTick, scorerId, goalTeam, freezeBallAfterTick }
//
// Playback: { update(frameDt) -> { view, cameraHint } | null when finished, skip(),
//             duration (s), frameCount, time (s), goalTime (s from start, or null) }
//   cameraHint = { mode: 'follow'|'wide'|'ball'|'goal', targetCarId, goalTeam, goalPos }
//   Auto-cut timeline relative to the goal: follow the scorer -> wide arena shot
//   (from 4.0 s before) -> ball chase (2.6 s before) -> goal view (0.7 s before).
import { interpolateFrames } from './view.js';
import { TICK_RATE } from '../sim/const.js';

export const CUT_WIDE_BEFORE = 4.0;
export const CUT_BALL_BEFORE = 2.6;
export const CUT_GOAL_BEFORE = 0.7;

export function createReplayBuffer(seconds = 12) {
  const capacity = Math.max(2, Math.round(seconds * TICK_RATE));
  const buf = new Array(capacity);
  let head = 0;   // next write slot
  let count = 0;

  function at(i) { return buf[(head - count + i + capacity * 2) % capacity]; } // i = 0 oldest

  const api = {
    capacity,
    get size() { return count; },
    record(frame) {
      if (!frame) return;
      // A frame older than / equal to the newest one means the timeline restarted.
      if (count && frame.tick <= at(count - 1).tick) { head = 0; count = 0; }
      buf[head] = frame;
      head = (head + 1) % capacity;
      if (count < capacity) count++;
    },
    clear() { for (let i = 0; i < capacity; i++) buf[i] = undefined; head = 0; count = 0; },
    latestTick() { return count ? at(count - 1).tick : -1; },
    range(fromTick, toTick) {
      const out = [];
      for (let i = 0; i < count; i++) {
        const f = at(i);
        if (f.tick >= fromTick && f.tick <= toTick) out.push(f);
      }
      return out;
    },
    startPlayback(opts = 6) {
      if (!count) return null;
      let o = opts;
      if (typeof opts === 'number') {
        const last = api.latestTick();
        o = { fromTick: last - Math.round(opts * TICK_RATE), toTick: last };
      }
      const frames = api.range(o.fromTick ?? -Infinity, o.toTick ?? Infinity);
      if (frames.length < 2) return null;
      return createPlayback(frames, o);
    },
  };
  return api;
}

export function createPlayback(srcFrames, opts = {}) {
  // Freeze the ball where it crossed the line once the goal has happened
  // (live, it explodes and is moved out of play).
  let frames = srcFrames;
  const freezeTick = opts.freezeBallAfterTick;
  if (freezeTick != null) {
    const ref = srcFrames.filter((f) => f.tick <= freezeTick).pop();
    if (ref) frames = srcFrames.map((f) => (f.tick > freezeTick ? { ...f, ball: ref.ball } : f));
  }
  const n = frames.length;
  const duration = (n - 1) / TICK_RATE;
  const startTick = frames[0].tick;
  const goalTime = opts.goalTick != null ? (opts.goalTick - startTick) / TICK_RATE : null;
  const goalFrame = opts.goalTick != null ? frames.filter((f) => f.tick <= opts.goalTick).pop() : null;
  const hint = {
    mode: 'wide', targetCarId: opts.scorerId ?? -1, goalTeam: opts.goalTeam ?? -1,
    goalPos: goalFrame ? goalFrame.ball.pos : frames[n - 1].ball.pos,
  };
  let t = 0, done = false;
  const result = { view: null, cameraHint: hint };

  function hintAt(time) {
    const hasScorer = hint.targetCarId != null && hint.targetCarId >= 0;
    if (goalTime == null) return hasScorer ? 'follow' : 'ball';
    const before = goalTime - time;
    if (before <= CUT_GOAL_BEFORE) return 'goal';
    if (before <= CUT_BALL_BEFORE) return 'ball';
    if (before <= CUT_WIDE_BEFORE) return 'wide';
    return hasScorer ? 'follow' : 'wide';
  }

  const pb = {
    duration, frameCount: n, goalTime,
    get time() { return t; },
    get done() { return done; },
    update(dt) {
      if (done) return null;
      t += Math.max(0, dt || 0);
      if (t > duration + 1e-6) { done = true; return null; }
      if (t > duration) t = duration;
      const f = t * TICK_RATE;
      const i = Math.min(Math.floor(f), n - 1);
      const a = frames[i], b = frames[Math.min(i + 1, n - 1)];
      const view = interpolateFrames(a, b, i + 1 < n ? f - i : 1);
      view.isReplay = true;
      hint.mode = hintAt(t);
      result.view = view;
      return result;
    },
    skip() { done = true; },
  };
  return pb;
}
