// Runs the match / stats / replay tests in Node: node src/game/tests/run.mjs [--quick]
import * as H from './harness.mjs';
import * as M from './match.test.mjs';
import * as L from './longmatch.test.mjs';

const quick = process.argv.includes('--quick');
const suites = [...M.ALL, ...(quick ? [] : L.ALL)];
for (const fn of suites) {
  console.log(`\n# ${fn.name}`);
  try { fn(); } catch (e) { H.check(`${fn.name} threw`, false, e.stack); }
}
const res = H.takeResults();
const failed = res.filter((r) => !r.pass);
console.log(`\n${res.length - failed.length}/${res.length} passed${failed.length ? ' — FAILED: ' + failed.map((f) => f.name).join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
