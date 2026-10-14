// TURBO PITCH — offline audio render test (owned by the audio agent).
// Renders every sound through the real master chain with OfflineAudioContext and
// reports peak / RMS (dBFS), audible duration and NaN counts. Exposed as
// window.__audioTest() when the page is loaded with ?audiotest=1.
import { makeLibFull, buildMaster, Shot, RECIPES } from '../synth.js';
import { CarVoice, CrowdBed, makePanner } from '../voices.js';
import { Vec3 } from '../../sim/math.js';
import { createAudio } from '../audio.js';
import { EV } from '../../contracts.js';

const SR = 48000;
const db = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -999);

function OAC(len) {
  const C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  return new C(2, Math.ceil(len * SR), SR);
}

function analyze(buf, windows) {
  let peak = 0, nan = 0, last = 0, first = -1, sum = 0;
  const n = buf.length;
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  for (const d of chans) {
    for (let i = 0; i < n; i++) {
      const x = d[i];
      if (x !== x || !isFinite(x)) { nan++; continue; }
      const a = Math.abs(x);
      if (a > peak) peak = a;
      if (a > 0.001) { if (i > last) last = i; if (first < 0 || i < first) first = i; }
    }
  }
  // RMS over the audible region
  const a0 = Math.max(0, first), a1 = Math.max(a0 + 1, last);
  for (const d of chans) for (let i = a0; i < a1; i++) { const x = d[i]; if (x === x) sum += x * x; }
  const rms = Math.sqrt(sum / ((a1 - a0) * chans.length));
  // short-term loudness: max RMS over 50 ms windows (closer to perceived loudness of transients)
  const W = Math.floor(0.05 * SR);
  let st = 0;
  for (let s0 = 0; s0 + W <= n; s0 += W >> 1) {
    let ss = 0;
    for (const d of chans) for (let i = s0; i < s0 + W; i++) { const x = d[i]; if (x === x) ss += x * x; }
    st = Math.max(st, Math.sqrt(ss / (W * chans.length)));
  }
  const out = { peakDb: db(peak), rmsDb: db(rms), shortDb: db(st), audibleSec: first < 0 ? 0 : +((last - first) / SR).toFixed(2), nan, clip: peak >= 1 };
  if (windows) {
    out.windowsRmsDb = windows.map(([s, e]) => {
      let ss = 0, cnt = 0;
      for (const d of chans) for (let i = Math.floor(s * SR); i < Math.min(n, Math.floor(e * SR)); i++) { ss += d[i] * d[i]; cnt++; }
      return db(Math.sqrt(ss / Math.max(1, cnt)));
    });
  }
  return out;
}

function fakeCar(o) {
  const yaw = 0;
  const forward = new Vec3(Math.cos(yaw), Math.sin(yaw), 0), right = new Vec3(-Math.sin(yaw), Math.cos(yaw), 0);
  const up = o.up || new Vec3(0, 0, 1);
  const fs = o.speed || 0, lat = o.lat || 0;
  return {
    id: 0, pos: new Vec3(0, 0, 17), forward, right, up,
    vel: new Vec3(forward.x * fs + right.x * lat, forward.y * fs + right.y * lat, 0),
    forwardSpeed: fs, isOnGround: o.ground !== false, numWheelsInContact: o.ground !== false ? 4 : 0,
    isBoosting: !!o.boost, isSupersonic: !!o.ss, isDemoed: false, handbrakeVal: o.hb || 0,
    controls: { throttle: o.throttle || 0, handbrake: (o.hb || 0) > 0 },
  };
}

export async function runAudioTest({ raw = true } = {}) {
  const RAW = raw;
  const t0 = performance.now();
  const libCtx = OAC(0.1);
  const lib = makeLibFull(libCtx);
  const vol = { master: 0.8, sfx: 0.9, crowd: 0.7 };
  const results = [];

  async function render(name, len, setup, volume = vol, windows = null) {
    const ac = OAC(len);
    const bus = buildMaster(ac, lib, volume);
    const info = setup(ac, bus) || {};
    const buf = await ac.startRendering();
    const r = { name, ...analyze(buf, windows), ...info };
    if (RAW) {
      // same graph without compressor / soft clip: shows the un-limited mix level
      const ac2 = OAC(len);
      const bus2 = buildMaster(ac2, lib, volume, { raw: true });
      setup(ac2, bus2);
      const a2 = analyze(await ac2.startRendering(), windows);
      r.rawPeakDb = a2.peakDb; r.rawRmsDb = a2.rmsDb; r.rawShortDb = a2.shortDb; r.rawWindows = a2.windowsRmsDb;
    }
    results.push(r);
    return r;
  }
  function shotCase(name, recipe, p, opts = {}) {
    return render(name, opts.len || 3.5, (ac, bus) => {
      let dest = opts.crowd ? bus.crowdIn : bus.sfxIn;
      if (opts.dist) {
        const pn = makePanner(ac); pn.positionX.value = opts.dist * 0.6; pn.positionZ.value = -opts.dist * 0.8;
        pn.connect(dest); dest = pn;
      }
      const s = new Shot(ac, lib, dest, opts.crowd ? null : bus.revIn, opts.send || 0);
      const dur = RECIPES[recipe](s, 0.01, p);
      return { recipeDur: +dur.toFixed(2) };
    });
  }

  // ---- one-shots
  await shotCase('ballHit.soft(400)', 'ballHit', { impulse: 400 }, { send: 0.13 });
  await shotCase('ballHit.medium(1200)', 'ballHit', { impulse: 1200 }, { send: 0.2 });
  await shotCase('ballHit.big(3500)', 'ballHit', { impulse: 3500 }, { send: 0.35 });
  await shotCase('ballHit.big@40m', 'ballHit', { impulse: 3500 }, { send: 0.35, dist: 40 });
  await shotCase('ballBounce(600)', 'ballBounce', { speed: 600 }, { send: 0.12 });
  await shotCase('ballBounce(2000)', 'ballBounce', { speed: 2000 }, { send: 0.12 });
  await shotCase('jump', 'jump', {});
  await shotCase('doubleJump', 'doubleJump', {});
  await shotCase('dodge', 'dodge', {});
  await shotCase('land(300)', 'land', { speed: 300 });
  await shotCase('land(1200)', 'land', { speed: 1200 });
  await shotCase('padSmall', 'padSmall', {});
  await shotCase('padBig', 'padBig', {});
  await shotCase('carBump(1800)', 'carBump', { speed: 1800 }, { send: 0.12 });
  await shotCase('demo.explosion', 'explosion', { size: 0.75 }, { send: 0.4 });
  await shotCase('goal.explosion', 'explosion', { size: 1 }, { send: 0.5 });
  await shotCase('supersonic.whoosh', 'supersonic', {});
  await shotCase('countdown.beep', 'beep', {});
  await shotCase('countdown.go', 'go', {});
  await shotCase('goal.horn', 'horn', { len: 1.9 }, { send: 0.45, len: 4 });
  await shotCase('crowd.ooh', 'ooh', { v: 0.9 }, { crowd: true });
  await shotCase('crowd.cheer', 'cheer', { v: 1 }, { crowd: true, len: 4 });
  await shotCase('replayWhoosh', 'replayWhoosh', {});
  await shotCase('respawn', 'respawn', {});

  // ---- continuous: car voice under scripted states (player car, 3 m ahead)
  async function carCase(name, len, stateAt, windows) {
    return render(name, len, (ac, bus) => {
      const v = new CarVoice(ac, lib, bus.sfxIn, bus.revIn, 1);
      v.setPos(0, 0.5, -3, 0);
      const dt = 1 / 60;
      for (let t = 0; t < len; t += dt) v.update(stateAt(t), true, t, dt);
    }, vol, windows);
  }
  await carCase('engine.idle', 2, () => fakeCar({}));
  await carCase('engine.accel 0->2300 (+boost 1.5s+, ss)', 4, (t) => {
    const sp = Math.min(2300, t * 800);
    return fakeCar({ speed: sp, throttle: 1, boost: t > 1.5, ss: sp >= 2200 });
  }, [[0.2, 1.2], [1.6, 2.6], [3.0, 4.0]]);
  await carCase('engine.coast 1400', 2, () => fakeCar({ speed: 1400 }));
  await carCase('engine.air free-rev', 2, () => fakeCar({ speed: 1000, throttle: 1, ground: false }));
  await carCase('wallScrape (wall, 1200, coasting)', 2, () => fakeCar({ speed: 1200, up: new Vec3(1, 0, 0) }));
  await carCase('powerslide squeal', 2, () => fakeCar({ speed: 900, lat: 900, hb: 1, throttle: 1 }));

  // ---- crowd bed: calm -> excited -> goal hype
  await render('crowd.bed calm/excited/hype', 7.5, (ac, bus) => {
    const c = new CrowdBed(ac, lib, bus.crowdIn);
    for (let t = 0; t < 7.5; t += 1 / 30) {
      const ex = t < 2.5 ? 0 : 1, hype = t < 5 ? 0 : 1;
      c.update(1, ex, hype, t);
    }
  }, vol, [[1.5, 2.5], [4, 5], [6.5, 7.5]]);

  // ---- stress: everything at once, default and full volume
  const stress = (ac, bus) => {
    const add = (r, p, send = 0.3, crowd = false) => { const s = new Shot(ac, lib, crowd ? bus.crowdIn : bus.sfxIn, crowd ? null : bus.revIn, send); RECIPES[r](s, 0.02, p); };
    for (let i = 0; i < 6; i++) add('ballHit', { impulse: 4000 });
    add('explosion', { size: 1 }, 0.5); add('explosion', { size: 0.75 }, 0.4);
    add('horn', { len: 1.9 }, 0.45); add('cheer', { v: 1 }, 0, true); add('ooh', { v: 1 }, 0, true);
    for (let i = 0; i < 8; i++) add('carBump', { speed: 2000 });
    add('padBig', {}); add('go', {}); add('land', { speed: 1500 }); add('supersonic', {});
    const c = new CrowdBed(ac, lib, bus.crowdIn); c.update(1, 1, 1, 0);
    for (let k = 0; k < 6; k++) {
      const v = new CarVoice(ac, lib, bus.sfxIn, bus.revIn, k + 1); v.setPos(k - 3, 0.5, -3, 0);
      for (let t = 0; t < 3; t += 1 / 30) v.update(fakeCar({ speed: 2300, throttle: 1, boost: true, ss: true }), k === 0, t, 1 / 30);
    }
    return { shots: 23, carVoices: 6 };
  };
  await render('STRESS default volumes', 3, stress);
  await render('STRESS full volumes', 3, stress, { master: 1, sfx: 1, crowd: 1 });

  const coverage = await eventCoverage();
  const maxPeakDb = Math.max(...results.map((r) => r.peakDb));
  return {
    sampleRate: SR, libBakeMs: Object.fromEntries(Object.entries(lib.timings).map(([k, v]) => [k, +v.toFixed(1)])), totalMs: Math.round(performance.now() - t0),
    coverage,
    anyNaN: results.some((r) => r.nan > 0), anyClip: results.some((r) => r.clip), maxPeakDb,
    results: results.map((r) => `${r.name}: peak ${r.peakDb} dBFS, short ${r.shortDb}, rms ${r.rmsDb} dBFS, audible ${r.audibleSec}s${r.rawPeakDb != null ? ` [raw pk ${r.rawPeakDb}/st ${r.rawShortDb}/rms ${r.rawRmsDb}]` : ''}${r.recipeDur != null ? ` (recipe ${r.recipeDur}s)` : ''}${r.windowsRmsDb ? `, windows ${r.windowsRmsDb.join('/')} dB (raw ${r.rawWindows ? r.rawWindows.join('/') : '-'})` : ''}${r.nan ? `, NaN ${r.nan}` : ''}`),
  };
}

// Drives a second (silent) live engine with synthetic views/events: every event type,
// the replay ball-contact synthesis, the near-miss "ooh", pause/volume/dispose.
async function eventCoverage() {
  const settings = { audio: { master: 0, sfx: 1, crowd: 1 }, graphics: { quality: 'high' } };
  const A = createAudio({ settings, devHooks: false });
  A.unlock();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && (A._debugStats().state !== 'running' || !A._debugStats().crowdReady); i++) await wait(50);
  const errors = [];
  const cars = [0, 1, 2, 3, 4, 5].map((id) => ({ ...fakeCar({ speed: 1500, throttle: 1, boost: id % 2 === 0 }), id, team: id < 3 ? 0 : 1, pos: new Vec3(-2000 + id * 800, -1000, 17) }));
  const listener = { pos: { x: 0, y: 3, z: -12 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, playerCarId: 0 };
  const mkView = (ballPos, ballVel, extra = {}) => ({ time: 0, tick: 0, isReplay: false, ball: { pos: ballPos, vel: ballVel }, cars, pads: [],
    match: { mode: 'exhibition', state: 'playing', countdown: 0, ...extra.match }, ...extra });
  const step = async (view, n = 3) => { for (let i = 0; i < n; i++) { try { A.update(view, listener, 1 / 60); } catch (e) { errors.push('update: ' + e.message); } await wait(17); } };
  await step(mkView(new Vec3(0, 0, 93), new Vec3(0, 0, 0)), 5);
  // near miss (before the goal event, which suppresses "ooh" for 3 s): threatening ball (toward +Y goal) that turns away
  for (let i = 0; i < 6; i++) await step(mkView(new Vec3(0, 4500 + i * 60, 300), new Vec3(0, 1800, 0)), 1);
  await step(mkView(new Vec3(0, 4900, 300), new Vec3(0, -1500, 0)), 2);
  const p = new Vec3(100, 200, 50);
  const evs = [
    { type: EV.BALL_HIT, carId: 1, impulse: 2500, pos: p }, { type: EV.BALL_BOUNCE, pos: p, speed: 900 },
    { type: EV.CAR_BUMP, attackerId: 1, victimId: 2, pos: p, speed: 1500 }, { type: EV.DEMO, attackerId: 1, victimId: 3, pos: p },
    { type: EV.RESPAWN, carId: 3 }, { type: EV.JUMP, carId: 0, pos: p }, { type: EV.DOUBLE_JUMP, carId: 1, pos: p },
    { type: EV.DODGE, carId: 0, dir: { x: 1, y: 0 }, pos: p }, { type: EV.LAND, carId: 2, speed: 700, pos: p },
    { type: EV.WALL_SCRAPE, carId: 2, pos: p, speed: 900 }, { type: EV.SUPERSONIC_START, carId: 0 },
    { type: EV.BOOST_START, carId: 0 }, { type: EV.BOOST_END, carId: 0 },
    { type: EV.PAD_PICKUP, carId: 0, padIndex: 1, isBig: true, pos: p }, { type: EV.PAD_PICKUP, carId: 4, padIndex: 2, isBig: false, pos: p },
    { type: EV.KICKOFF_COUNTDOWN, n: 3 }, { type: EV.KICKOFF_GO }, { type: EV.OVERTIME }, { type: EV.STAT, carId: 1, kind: 'epicSave', points: 75 },
    { type: EV.QUICK_CHAT, carId: 1, text: 'Nice shot!' }, { type: EV.REPLAY_START }, { type: EV.REPLAY_END },
    { type: EV.GOAL, team: 0, scorerId: 1, pos: new Vec3(0, 5200, 300), ballSpeed: 2500 }, { type: EV.MATCH_END, winner: 0 },
  ];
  try { A.onEvents(evs, mkView(p, new Vec3(0, 0, 0))); } catch (e) { errors.push('onEvents: ' + e.message); }
  await step(mkView(p, new Vec3(0, 0, 0)), 5);
  // replay: ball velocity jump right next to car 0 -> synthesised ball hit
  const rcars = cars.map((c) => ({ ...c }));
  rcars[0].pos = new Vec3(0, -100, 17);
  const rv = (vel) => ({ ...mkView(new Vec3(0, 0, 93), vel, { match: { state: 'replay', countdown: 0 } }), isReplay: true, cars: rcars });
  await step(rv(new Vec3(0, 0, 0)), 2);
  await step(rv(new Vec3(0, 2500, 400)), 2);
  // demoed car + car leaving the session
  cars[3].isDemoed = true;
  await step({ ...mkView(new Vec3(0, 0, 93), new Vec3(0, 0, 0)), cars: cars.slice(0, 5) }, 2);
  try { A.setVolumes({ master: 0, sfx: 0.5, crowd: 0.5 }); A.setPaused(true); await wait(300); } catch (e) { errors.push('pause: ' + e.message); }
  const pausedState = A._debugStats().state;
  try { A.setPaused(false); for (let i = 0; i < 20 && A._debugStats().state !== 'running'; i++) await wait(50); } catch (e) { errors.push('resume: ' + e.message); }
  const st = A._debugStats();
  try { A.dispose(); A.update(mkView(p, p), listener, 0.016); A.onEvents(evs, null); } catch (e) { errors.push('after dispose: ' + e.message); }
  const expected = ['ballHit', 'ballBounce', 'carBump', 'explosion', 'respawn', 'jump', 'doubleJump', 'dodge', 'land', 'supersonic', 'padBig', 'padSmall', 'beep', 'go', 'horn', 'cheer', 'replayWhoosh', 'ooh'];
  const missing = expected.filter((k) => !st.byType[k]);
  return { ctx: st.state, pausedState, carVoices: st.carVoices, peakShots: st.peakShots, played: st.played, byType: st.byType, missing, errors };
}
