import { runAllAsync } from '../src/tests/selftest.js';
const phase = process.argv[2] ? Number(process.argv[2]) : null;
const res = await runAllAsync(phase);
process.exit(res.every((r) => r.pass) ? 0 : 1);
