// Quick single game: node src/bots/tests/smoke.mjs <blue diffs> <orange diffs> [seconds] [seed]
// e.g. node src/bots/tests/smoke.mjs allstar,allstar pro,pro 120 3
import { runGame } from './harness.mjs';
const [b = 'allstar', o = 'pro', secs = '60', seed = '1'] = process.argv.slice(2);
const S = runGame({ blue: b.split(','), orange: o.split(','), seconds: +secs, seed: +seed });
console.log(JSON.stringify({ goals: S.goals, goalsLog: S.goalsLog, kick: [S.kickoffs, S.kickoffWins, S.kickoffFirstTouch], ms: S.msPerBotTick.toFixed(4), maxMs: S.maxBotTickMs.toFixed(2), stuck: S.stuckEvents, stuckLog: S.stuckLog.slice(0, 5), maxStill: S.maxStationary.toFixed(1), dc: S.doubleCommitEvents, demos: S.demos, chats: S.chats.slice(0, 8) }));
for (const x of S.bots) console.log(JSON.stringify(x));
