// Long simulated match: 2v2 (and 3v3) of trivial ball-chasers at 60 fps through
// countdowns, goals, replays, the zero-second rule and overtime. Checks for
// exceptions and invariants.
import * as H from './harness.mjs';
import { makeRng } from '../../sim/math.js';

const { EV, check } = H;

export function runLongMatch({ size = 2, seed = 11, durationSec = 300, capSec = 900 } = {}) {
  const g = H.setup({ blue: size, orange: size, durationSec, seed });
  const rng = makeRng(seed * 31 + 1);
  const bot = (car, world, match) => H.chaser(car, world, match, rng);
  const counts = {};
  let error = null, simSec = 0, frames = 0, replays = 0, replayFramesNull = 0, viewErrors = 0;
  const t0 = performance.now();
  try {
    while (!g.match.isEnded() && simSec < capSec) {
      g.match.frameUpdate(1 / 60);
      const inReplay = g.match.state === 'replay';
      if (!inReplay) { for (let k = 0; k < 2; k++) { for (const e of H.tick(g, bot)) counts[e.type] = (counts[e.type] || 0) + 1; } simSec += 1 / 60; }
      else {
        const r = g.match.getReplayView();
        if (!r || !r.view || !r.view.isReplay) replayFramesNull++;
      }
      const v = g.match.getView();
      if (v.ballHidden && v.state === 'replay') viewErrors++;
      if (v.state === 'replay' && !v.replayActive) viewErrors++;
      if (v.clockSec < 0 || v.clockSec > durationSec) viewErrors++;
      frames++;
      g.events.length = 0;
    }
  } catch (e) { error = e; }
  const ms = performance.now() - t0;
  const v = g.match.getView();
  const goals = counts[EV.GOAL] || 0;
  const teamGoals = [0, 1].map((t) => v.players.filter((p) => p.team === t).reduce((s, p) => s + p.goals, 0));
  return { g, v, counts, error, simSec, frames, ms, goals, teamGoals, replayFramesNull, viewErrors };
}

export function testLongMatch() {
  for (const [size, seed] of [[2, 11], [3, 5], [1, 3]]) {
    const r = runLongMatch({ size, seed });
    const v = r.v;
    const tag = `${size}v${size} seed ${seed}`;
    check(`long match ${tag}: no exceptions`, !r.error, r.error ? r.error.stack.split('\n').slice(0, 3).join(' | ') : '');
    check(`long match ${tag}: reached the end`, v.state === 'ended', `state ${v.state} after ${r.simSec.toFixed(0)} sim-s, score ${v.scores.join('-')}${v.isOvertime ? ' OT +' + v.overtimeSec.toFixed(0) : ''}`);
    check(`long match ${tag}: goals == scores, replays == goals`, r.goals === v.scores[0] + v.scores[1] && (r.counts[EV.REPLAY_START] || 0) === r.goals && (r.counts[EV.REPLAY_END] || 0) === r.goals,
      `goals ${r.goals} replays ${r.counts[EV.REPLAY_START] || 0}`);
    check(`long match ${tag}: per-player goals <= team score`, r.teamGoals[0] <= v.scores[0] && r.teamGoals[1] <= v.scores[1]);
    check(`long match ${tag}: view invariants hold every frame`, r.viewErrors === 0 && r.replayFramesNull === 0);
    check(`long match ${tag}: winner & MVP set`, v.winner === (v.scores[0] > v.scores[1] ? 0 : 1) && v.players.some((p) => p.carId === v.mvpId && p.team === v.winner));
    console.log(`      ${tag}: ${v.scores.join('-')}${v.isOvertime ? ' (OT +' + v.overtimeSec.toFixed(1) + 's)' : ''}, ${r.simSec.toFixed(0)} sim-s in ${(r.ms / 1000).toFixed(1)} s wall, ` +
      `stats ${JSON.stringify(v.players.map((p) => [p.name, p.score, p.goals, p.assists, p.saves, p.shots, p.demos]))}, stat events ${r.counts[EV.STAT] || 0}`);
  }
}

export const ALL = [testLongMatch];
