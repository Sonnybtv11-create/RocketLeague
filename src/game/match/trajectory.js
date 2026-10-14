// Ball trajectory cache for stat detection (shots / saves / clears / centres).
// Uses the sim's own ball-alone step (sim/ball.js stepBallAlone), so a free ball
// follows the predicted path exactly until something touches it.
import { Ball, stepBallAlone } from '../../sim/ball.js';
import * as K from '../../sim/const.js';

const GOAL_Y = K.SOCCAR_GOAL_SCORE_BASE_THRESHOLD_Y + K.BALL_RADIUS;

export function createTrajectory(horizonSec) {
  const ball = new Ball();
  const maxSteps = Math.round(horizonSec / K.TICK_TIME);
  const path = new Float32Array(maxSteps * 3);
  const pred = {
    valid: false,
    startTick: 0,          // world.tick at which the prediction was taken
    steps: 0,              // number of stored positions (path[i] = pos at startTick + i + 1)
    goalTeam: -1,          // scoring team if the ball goes in, else -1
    goalSteps: -1,         // ticks from startTick until the ball crosses the line
    sourceCarId: -1,       // car whose touch produced this trajectory (-1 = none / unknown)
    startPos: { x: 0, y: 0, z: 0 },
    sleeping: false,
  };

  function compute(world, sourceCarId) {
    const src = world.ball.body, b = ball.body;
    b.pos.copy(src.pos); b.vel.copy(src.vel); b.angVel.copy(src.angVel); b.rot = src.rot.clone();
    b.velCache.set(0, 0, 0); b.force.set(0, 0, 0); b.pushVel.set(0, 0, 0); b.turnVel.set(0, 0, 0);
    pred.valid = true;
    pred.startTick = world.tick;
    pred.sourceCarId = sourceCarId;
    pred.goalTeam = -1; pred.goalSteps = -1;
    pred.startPos.x = src.pos.x; pred.startPos.y = src.pos.y; pred.startPos.z = src.pos.z;
    pred.sleeping = ball.isSleeping();
    let n = 0;
    if (!pred.sleeping) {
      for (; n < maxSteps; n++) {
        stepBallAlone(ball, K.TICK_TIME);
        path[n * 3] = b.pos.x; path[n * 3 + 1] = b.pos.y; path[n * 3 + 2] = b.pos.z;
        if (Math.abs(b.pos.y) > GOAL_Y) { pred.goalTeam = b.pos.y > 0 ? 0 : 1; pred.goalSteps = n + 1; n++; break; }
        if (ball.isSleeping()) { n++; break; }
      }
    }
    pred.steps = n;
    return pred;
  }

  // Predicted ball position at world tick `tick` (or null outside the stored path).
  function posAt(tick, out) {
    if (!pred.valid) return null;
    const i = tick - pred.startTick - 1;
    if (i < 0) { out.x = pred.startPos.x; out.y = pred.startPos.y; out.z = pred.startPos.z; return out; }
    if (pred.steps === 0) { out.x = pred.startPos.x; out.y = pred.startPos.y; out.z = pred.startPos.z; return out; }
    const j = Math.min(i, pred.steps - 1);
    if (i >= pred.steps && pred.goalTeam >= 0) return null; // past the goal line
    out.x = path[j * 3]; out.y = path[j * 3 + 1]; out.z = path[j * 3 + 2];
    return out;
  }

  // Seconds from `tick` until the predicted goal (Infinity if no goal predicted / already past).
  function timeToGoal(tick, team) {
    if (!pred.valid || pred.goalTeam < 0 || (team !== undefined && pred.goalTeam !== team)) return Infinity;
    const left = pred.startTick + pred.goalSteps - tick;
    return left < 0 ? Infinity : left * K.TICK_TIME;
  }

  // First predicted time (s, from startTick) at which fn(x, y, z) holds within maxSec, else -1.
  function firstTime(maxSec, fn) {
    if (!pred.valid) return -1;
    const lim = Math.min(pred.steps, Math.round(maxSec / K.TICK_TIME));
    if (pred.steps === 0) return fn(pred.startPos.x, pred.startPos.y, pred.startPos.z) ? 0 : -1;
    for (let i = 0; i < lim; i++) if (fn(path[i * 3], path[i * 3 + 1], path[i * 3 + 2])) return (i + 1) * K.TICK_TIME;
    return -1;
  }

  function snapshot() {
    return { goalTeam: pred.goalTeam, goalSteps: pred.goalSteps, startTick: pred.startTick, sourceCarId: pred.sourceCarId, valid: pred.valid };
  }

  function invalidate() { pred.valid = false; pred.goalTeam = -1; pred.goalSteps = -1; pred.sourceCarId = -1; }

  return { pred, compute, posAt, timeToGoal, firstTime, snapshot, invalidate };
}
