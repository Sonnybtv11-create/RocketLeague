// Bot evaluation suite (Node, parallel workers).
//   node src/bots/tests/run-matches.mjs [--games=10] [--seconds=180] [--only=1v1|team] [--threads=4]
// (a) 1v1: All-Star vs Pro, Pro vs Rookie, All-Star vs Rookie (sides alternate)
// (b) 2v2 / 3v3 All-Star vs All-Star sanity (goals, stuck cars, double commits)
// (c) mechanics stats (kickoffs, aerials, flips, pads, demos), (d) per-tick timing
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

if (!isMainThread) {
  const { runGame } = await import('./harness.mjs');
  const S = runGame(workerData);
  parentPort.postMessage(S);
} else {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const games = +(args.games || 10), seconds = +(args.seconds || 180);
  const threads = +(args.threads || Math.max(1, os.cpus().length));
  const self = fileURLToPath(import.meta.url);
  const jobs = [];
  const pairings = [];
  if (!args.only || args.only === '1v1') {
    pairings.push({ label: 'All-Star vs Pro', a: ['allstar'], b: ['pro'] });
    pairings.push({ label: 'Pro vs Rookie', a: ['pro'], b: ['rookie'] });
    pairings.push({ label: 'All-Star vs Rookie', a: ['allstar'], b: ['rookie'] });
  }
  if (!args.only || args.only === 'team') {
    pairings.push({ label: '2v2 All-Star', a: ['allstar', 'allstar'], b: ['allstar', 'allstar'], games: Math.max(2, games / 2 | 0) });
    pairings.push({ label: '3v3 All-Star', a: ['allstar', 'allstar', 'allstar'], b: ['allstar', 'allstar', 'allstar'], games: Math.max(2, games / 2 | 0) });
  }
  if (args.only === 'custom') pairings.push({ label: `${args.a} vs ${args.b}`, a: args.a.split(','), b: args.b.split(',') });
  for (const p of pairings) {
    p.results = [];
    const n = p.games || games;
    for (let g = 0; g < n; g++) {
      const swap = g % 2 === 1; // alternate sides
      jobs.push({ p, swap, data: { blue: swap ? p.b : p.a, orange: swap ? p.a : p.b, seconds, seed: 1000 + g * 17 + pairings.indexOf(p) * 101 } });
    }
  }
  const t0 = Date.now();
  let next = 0;
  await new Promise((resolve) => {
    let running = 0;
    const launch = () => {
      while (running < threads && next < jobs.length) {
        const job = jobs[next++];
        running++;
        const w = new Worker(self, { workerData: job.data });
        w.on('message', (S) => { job.p.results.push({ swap: job.swap, S }); });
        w.on('error', (e) => { console.error('worker error', e); });
        w.on('exit', () => { running--; if (next >= jobs.length && running === 0) resolve(); else launch(); });
      }
    };
    launch();
  });
  const fmt = (x, d = 2) => (typeof x === 'number' ? x.toFixed(d) : x);
  for (const p of pairings) {
    let goalsA = 0, goalsB = 0, winsA = 0, winsB = 0, draws = 0;
    const agg = {};
    let waiting = 0, kick = 0, kickWinA = 0, kickWinB = 0, stuck = 0, maxStill = 0, dcEvents = 0, playMinutes = 0, msSum = 0, msN = 0, maxMs = 0, demos = 0;
    const stuckLog = [];
    for (const { swap, S } of p.results) {
      const a = swap ? 1 : 0, b = 1 - a;
      goalsA += S.goals[a]; goalsB += S.goals[b];
      if (S.goals[a] > S.goals[b]) winsA++; else if (S.goals[a] < S.goals[b]) winsB++; else draws++;
      kick += S.kickoffs; kickWinA += S.kickoffWins[a]; kickWinB += S.kickoffWins[b];
      stuck += S.stuckEvents; waiting += S.waitingEvents; maxStill = Math.max(maxStill, S.maxStationary); stuckLog.push(...S.stuckLog);
      dcEvents += S.doubleCommitEvents[0] + S.doubleCommitEvents[1];
      playMinutes += S.seconds / 60;
      msSum += S.msPerBotTick; msN++; maxMs = Math.max(maxMs, S.maxBotTickMs); demos += S.demos;
      for (const bt of S.bots) {
        const side = (bt.team === a) ? 'A' : 'B';
        const key = `${side}:${bt.diff}`;
        const g = agg[key] || (agg[key] = { n: 0 });
        g.n++;
        for (const k of ['flips', 'halfFlips', 'aerials', 'aerialTouches', 'jumpShots', 'doubleJumpShots', 'dodgeShots', 'kickoffs', 'speedFlips', 'demoAttempts', 'unstucks', 'touches', 'pads', 'bigPads', 'demos', 'goals'])
          g[k] = (g[k] || 0) + (bt[k] || 0);
      }
    }
    console.log(`\n=== ${p.label}: ${p.results.length} games x ${seconds}s`);
    console.log(`  wins A/B/draw: ${winsA}/${winsB}/${draws}   goals A ${goalsA} - B ${goalsB}  (A = ${p.a.join('+')})`);
    console.log(`  kickoffs ${kick}: won by A ${kickWinA}, by B ${kickWinB} (ball in the other half 2 s after the first touch)`);
    console.log(`  stuck (>5 s without moving, not intentionally waiting) events: ${stuck} [intentional waits ${waiting}], longest stationary ${fmt(maxStill, 1)} s; double-commit events: ${dcEvents} (${fmt(dcEvents / playMinutes)}/min); demos ${demos}`);
    console.log(`  bot tick: mean ${fmt(msSum / msN, 4)} ms, worst single tick ${fmt(maxMs, 2)} ms`);
    for (const [key, g] of Object.entries(agg)) {
      const per = (k) => fmt(g[k] / g.n, 1);
      console.log(`  ${key.padEnd(12)} per game: goals ${per('goals')} touches ${per('touches')} flips ${per('flips')} halfFlips ${per('halfFlips')} dodgeShots ${per('dodgeShots')} jumpShots ${per('jumpShots')}+${per('doubleJumpShots')}dbl aerials ${per('aerials')} (touch ${g.aerials ? fmt(100 * g.aerialTouches / g.aerials, 0) : '-'}%) pads ${per('pads')} (big ${per('bigPads')}) demos ${per('demos')} unstucks ${per('unstucks')}`);
    }
    if (stuckLog.length) console.log('  stuck samples:', JSON.stringify(stuckLog.slice(0, 4)));
  }
  console.log(`\n(total wall time ${((Date.now() - t0) / 1000).toFixed(0)} s, ${threads} threads)`);
}
