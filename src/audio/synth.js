// TURBO PITCH — audio synthesis library (owned by the audio agent).
// Everything here is generated in code: noise buffers, a stadium impulse
// response, baked crowd loops, the master bus and every one-shot "recipe".
// Shared by the live engine (audio.js) and the offline render test
// (tests/audiotest.js). Only factory methods (ac.createGain() …) are used so
// that old Safari (webkitAudioContext) works.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
const EPS = 0.0001;

// ------------------------------------------------------------------ rng
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ JS biquad (RBJ) for baking
function biquadCoefs(type, f, q, sr) {
  const w0 = (2 * Math.PI * clamp(f, 10, sr * 0.45)) / sr;
  const cs = Math.cos(w0), sn = Math.sin(w0), alpha = sn / (2 * q);
  let b0, b1, b2;
  const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
  if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
  else if (type === 'highpass') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; } // bandpass, 0 dB peak
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
// in-place filter of a Float32Array
function filterInPlace(data, type, f, q, sr) {
  const [b0, b1, b2, a1, a2] = biquadCoefs(type, f, q, sr);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    data[i] = y;
  }
  return data;
}
// smooth value noise in [0,1]: random knots every 1/rate seconds, cosine interpolated
function valueNoise(rng, n, sr, rate) {
  const step = Math.max(1, Math.round(sr / rate));
  const knots = new Float32Array(Math.ceil(n / step) + 2);
  for (let i = 0; i < knots.length; i++) knots[i] = rng();
  const w = new Float32Array(step);
  for (let j = 0; j < step; j++) w[j] = (1 - Math.cos((j / step) * Math.PI)) * 0.5;
  const out = new Float32Array(n);
  for (let k = 0, i = 0; i < n; k++) {
    const a = knots[k], d = knots[k + 1] - a;
    for (let j = 0; j < step && i < n; j++, i++) out[i] = a + d * w[j];
  }
  return out;
}
function rmsOf(d) { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / Math.max(1, d.length)); }

// equal-power loop crossfade: data has L+F samples, result has L samples looping seamlessly
function loopCrossfade(data, L, F) {
  const out = new Float32Array(L);
  out.set(data.subarray(0, L));
  for (let i = 0; i < F; i++) {
    const a = i / F;
    out[i] = data[i] * Math.sin(a * Math.PI * 0.5) + data[L + i] * Math.cos(a * Math.PI * 0.5);
  }
  return out;
}

// ------------------------------------------------------------------ buffers
export function makeNoiseBuffer(ac, seconds = 2, seed = 1) {
  const sr = ac.sampleRate, n = Math.floor(seconds * sr);
  const buf = ac.createBuffer(1, n, sr);
  const d = buf.getChannelData(0), rng = mulberry32(seed);
  for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  // tiny fade at the loop point is unnecessary for white noise (no DC, uncorrelated)
  return buf;
}

// Stadium-ish impulse response: early reflections + exponentially decaying
// diffuse tail that darkens over time.
export function makeImpulseResponse(ac, seconds = 1.7, seed = 7) {
  const sr = ac.sampleRate, n = Math.floor(seconds * sr);
  const buf = ac.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch), rng = mulberry32(seed + ch * 101);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 3.6) * (t < 0.012 ? t / 0.012 : 1);
      const k = 0.55 - 0.45 * Math.min(1, t / seconds); // darker over time
      lp += k * ((rng() * 2 - 1) - lp);
      d[i] = lp * env;
    }
    // early reflections (stands / roof)
    const refl = [0.019, 0.031, 0.047, 0.066, 0.083, 0.11];
    for (const r of refl) {
      const idx = Math.floor((r + rng() * 0.004) * sr);
      if (idx < n) d[idx] += (rng() < 0.5 ? -1 : 1) * (0.5 - r * 2.5);
    }
    // energy-normalise: sum of squares = 1, so the wet level equals the send level
    const e = rmsOf(d) * Math.sqrt(n);
    for (let i = 0; i < n; i++) d[i] /= Math.max(e, 1e-9);
  }
  return buf;
}

// Crowd loops, baked at a low sample rate (cheap; crowd content sits below ~8 kHz).
// kind 'murmur': many-talker babble; kind 'roar': excited cheering with clap texture.
export const CROWD_SR = 22050;
export const CROWD_SPECS = { murmur: { seconds: 7, seed: 3 }, roar: { seconds: 6, seed: 4 } };
export function bakeCrowd(ac, kind) {
  const L = Math.floor(CROWD_SPECS[kind].seconds * CROWD_SR);
  const buf = ac.createBuffer(2, L, CROWD_SR);
  for (let ch = 0; ch < 2; ch++) buf.getChannelData(ch).set(bakeCrowdChannel(kind, ch));
  return buf;
}
// one channel of a crowd loop (Float32Array at CROWD_SR)
export function bakeCrowdChannel(kind, ch) {
  const sr = CROWD_SR, { seconds, seed } = CROWD_SPECS[kind];
  const L = Math.floor(seconds * sr), F = Math.floor(0.6 * sr), N = L + F;
  const bands = kind === 'roar'
    ? [{ f: 420, q: 1.1, a: 0.8, r: 1.3, d: 0.35 }, { f: 900, q: 1.3, a: 1.0, r: 2.2, d: 0.45 },
       { f: 1600, q: 1.6, a: 0.75, r: 3.1, d: 0.5 }, { f: 2700, q: 2.0, a: 0.4, r: 4.0, d: 0.55 }, { f: 230, q: 0.9, a: 0.5, r: 0.7, d: 0.3 }]
    : [{ f: 260, q: 1.4, a: 0.9, r: 3.5, d: 0.5 }, { f: 520, q: 2.2, a: 0.8, r: 4.5, d: 0.6 },
       { f: 800, q: 2.5, a: 0.6, r: 5.5, d: 0.65 }, { f: 1250, q: 2.8, a: 0.4, r: 6.0, d: 0.7 }, { f: 2200, q: 3.0, a: 0.18, r: 7.0, d: 0.7 }, { f: 140, q: 0.8, a: 0.4, r: 1.0, d: 0.3 }];
  {
    const rng = mulberry32(seed * 977 + ch * 31 + (kind === 'roar' ? 5000 : 0));
    const mix = new Float32Array(N);
    const tmp = new Float32Array(N);
    for (const b of bands) {
      for (let i = 0; i < N; i++) tmp[i] = rng() * 2 - 1;
      filterInPlace(tmp, 'bandpass', b.f * (0.95 + rng() * 0.1), b.q, sr);
      const env = valueNoise(rng, N, sr, b.r);
      const env2 = valueNoise(rng, N, sr, b.r * 2.7);
      for (let i = 0; i < N; i++) mix[i] += tmp[i] * b.a * (1 - b.d + b.d * (0.6 * env[i] + 0.4 * env2[i]));
    }
    if (kind === 'roar') {
      // clap / stomp texture: sparse decaying clicks, band-limited
      tmp.fill(0);
      const rate = 260; // clicks per second
      let i = 0;
      while (i < N) {
        i += Math.floor((-Math.log(1 - rng() * 0.999) / rate) * sr);
        const amp = 0.4 + rng() * 0.6, len = Math.floor(sr * (0.003 + rng() * 0.004));
        for (let k = 0; k < len && i + k < N; k++) tmp[i + k] += (rng() * 2 - 1) * amp * (1 - k / len);
      }
      filterInPlace(tmp, 'bandpass', 2100, 1.2, sr);
      const swell = valueNoise(rng, N, sr, 0.5);
      for (let k = 0; k < N; k++) mix[k] += tmp[k] * 0.9 * (0.5 + 0.5 * swell[k]);
      // slow overall swell
      for (let k = 0; k < N; k++) mix[k] *= 0.8 + 0.2 * swell[k];
    }
    const out = loopCrossfade(mix, L, F);
    const r = rmsOf(out), g = 0.18 / Math.max(r, 1e-6);
    for (let k = 0; k < L; k++) out[k] = Math.max(-1, Math.min(1, out[k] * g));
    return out;
  }
}

// Soft clip curve on the domain [-2, 2] (input is pre-scaled by 0.5):
// near unity gain for small signals, asymptotically limited to ±0.97.
export function softClipCurve(n = 2048) {
  const c = new Float32Array(n), k = Math.tanh(2);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    c[i] = (0.97 * Math.tanh(x)) / k;
  }
  return c;
}
export function driveCurve(amount = 2.5, n = 1024) {
  const c = new Float32Array(n), k = Math.tanh(amount);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * amount) / k; }
  return c;
}

// ------------------------------------------------------------------ library + master bus
const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);
// cheap buffers needed immediately (noise, reverb IR, shaper curves)
export function makeLib(ac) {
  const t0 = now();
  const lib = {
    noise: makeNoiseBuffer(ac, 2.5, 11),
    ir: makeImpulseResponse(ac, 1.7, 7),
    drive: driveCurve(2.2),
    softclip: softClipCurve(),
    murmur: null, roar: null,
    timings: {},
  };
  lib.timings.core = now() - t0;
  return lib;
}
// crowd loops (heavier): the live engine bakes them one channel per idle slot
// (see audio.js) so neither the unlock gesture nor a single frame takes the hit.
export function bakeCrowdInto(lib, ac, which) {
  const t0 = now();
  lib[which] = bakeCrowd(ac, which);
  lib.timings[which] = now() - t0;
}
export function makeLibFull(ac) {
  const lib = makeLib(ac);
  bakeCrowdInto(lib, ac, 'murmur');
  bakeCrowdInto(lib, ac, 'roar');
  return lib;
}

// preMaster → compressor → (×0.5) → soft clip → master volume → pause gain → destination
// buses: sfxIn (×sfx vol), crowdIn (×crowd vol), revIn → convolver → revOut (×sfx vol)
export function buildMaster(ac, lib, vol = { master: 0.8, sfx: 0.9, crowd: 0.7 }, opts = {}) {
  const g = (v) => { const n = ac.createGain(); n.gain.value = v; return n; };
  const preMaster = g(1);
  const comp = ac.createDynamicsCompressor();
  // gentle bus compression: only the loud moments (goals, big hits, demos) reach the threshold
  comp.threshold.value = -8; comp.knee.value = 8; comp.ratio.value = 3;
  comp.attack.value = 0.005; comp.release.value = 0.2;
  const pre = g(0.5);
  const clip = ac.createWaveShaper();
  clip.curve = lib.softclip; clip.oversample = '2x';
  const masterVol = g(clamp01(vol.master));
  const pauseGain = g(1);
  if (opts.raw) preMaster.connect(masterVol); // test only: measure the un-limited mix
  else { preMaster.connect(comp); comp.connect(pre); pre.connect(clip); clip.connect(masterVol); }
  masterVol.connect(pauseGain);
  pauseGain.connect(ac.destination);

  const sfxIn = g(clamp01(vol.sfx));
  const crowdIn = g(clamp01(vol.crowd));
  sfxIn.connect(preMaster); crowdIn.connect(preMaster);
  const revIn = g(1);
  const conv = ac.createConvolver();
  conv.normalize = false; conv.buffer = lib.ir;
  const revOut = g(clamp01(vol.sfx) * 0.9);
  revIn.connect(conv); conv.connect(revOut); revOut.connect(preMaster);
  // the crowd also gets a touch of the stadium reverb
  const crowdRev = g(0.25);
  crowdIn.connect(crowdRev); crowdRev.connect(revIn);
  return { preMaster, comp, clip, masterVol, pauseGain, sfxIn, crowdIn, revIn, revOut, conv };
}

// ------------------------------------------------------------------ param helpers
// setTargetAtTime that skips redundant updates (keeps the automation timeline small)
export function tgt(param, v, t, tau) {
  if (!isFinite(v)) return;
  const last = param._tp;
  if (last !== undefined && Math.abs(last - v) <= 1e-4 * (1 + Math.abs(v))) return;
  param.setTargetAtTime(v, t, tau);
  param._tp = v;
}
// attack / exponential decay envelope starting from silence
export function envAD(param, t, a, peak, d) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.exponentialRampToValueAtTime(EPS, t + a + d);
  param.setValueAtTime(0, t + a + d + 0.001);
}
// attack / hold / linear release
export function envAHR(param, t, a, peak, hold, rel) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setValueAtTime(peak, t + a + hold);
  param.linearRampToValueAtTime(0, t + a + hold + rel);
}
function sweep(param, t, from, to, dur) {
  param.setValueAtTime(from, t);
  param.exponentialRampToValueAtTime(Math.max(to, 1), t + dur);
}

// ------------------------------------------------------------------ one-shot builder
// A Shot owns every node of one one-shot sound; its `out` gain feeds `dest`
// and optionally the reverb send.
export class Shot {
  constructor(ac, lib, dest, revIn = null, send = 0) {
    this.ac = ac; this.lib = lib; this.nodes = []; this.sources = [];
    this.out = this.gain(1);
    this.out.connect(dest);
    if (revIn && send > 0) { const s = this.gain(send); this.out.connect(s); s.connect(revIn); }
  }
  _n(n) { this.nodes.push(n); return n; }
  gain(v = 0) { const g = this.ac.createGain(); g.gain.value = v; return this._n(g); }
  osc(type, f, t, dur) {
    const o = this.ac.createOscillator(); o.type = type; o.frequency.value = f;
    o.start(t); o.stop(t + dur); this.sources.push(o); return this._n(o);
  }
  noise(t, dur, rate = 1, buffer = null) {
    const s = this.ac.createBufferSource();
    s.buffer = buffer || this.lib.noise; s.loop = true; s.playbackRate.value = rate;
    const off = Math.random() * Math.max(0, s.buffer.duration - 0.5);
    s.start(t, off); s.stop(t + dur); this.sources.push(s); return this._n(s);
  }
  filt(type, f, q = 0.707) {
    const b = this.ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return this._n(b);
  }
  shaper(curve) { const w = this.ac.createWaveShaper(); w.curve = curve; return this._n(w); }
  chain(...ns) { for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]); return ns[ns.length - 1]; }
  dispose() {
    for (const n of this.nodes) { try { n.disconnect(); } catch (e) { /* already */ } }
    this.nodes.length = 0; this.sources.length = 0;
  }
}

// ------------------------------------------------------------------ recipes
// Each recipe(shot, t, p) schedules nodes from time t and returns its duration (s).
// p.v is a generic 0..1 intensity when meaningful.
function thump(s, t, f0, f1, dropT, peak, d, type = 'sine') {
  const o = s.osc(type, f0, t, d + 0.05);
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dropT);
  const g = s.gain(); envAD(g.gain, t, 0.002, peak, d);
  s.chain(o, g, s.out);
  return o;
}
function noiseHit(s, t, type, f, q, peak, a, d, rate = 1) {
  const n = s.noise(t, a + d + 0.05, rate), fl = s.filt(type, f, q), g = s.gain();
  envAD(g.gain, t, a, peak, d);
  s.chain(n, fl, g, s.out);
  return fl;
}

export const RECIPES = {
  // p.impulse (uu/s Δv on the ball)
  ballHit(s, t, p) {
    const k = clamp01((p.impulse || 0) / 3000), big = (p.impulse || 0) > 1500;
    s.out.gain.value = 0.12 + 0.55 * Math.pow(k, 0.8);
    const f0 = 140 + 70 * k;
    thump(s, t, f0 * 1.25, f0 * 0.62, 0.07, 0.95, 0.2 + 0.12 * k);
    // hollow shell resonance (inharmonic partials)
    const r1 = s.osc('sine', f0 * 2.31, t, 0.3), r2 = s.osc('triangle', f0 * 3.62, t, 0.3);
    const rg = s.gain(); envAD(rg.gain, t, 0.002, 0.22 + 0.1 * k, 0.12 + 0.08 * k);
    r1.connect(rg); r2.connect(rg); rg.connect(s.out);
    // contact click, brighter for harder hits
    noiseHit(s, t, 'highpass', 900 + 3200 * k, 0.8, 0.25 + 0.45 * k, 0.001, 0.025 + 0.035 * k);
    if (big) {
      thump(s, t, 95, 36, 0.18, 0.6 * k, 0.35);
      noiseHit(s, t, 'bandpass', 3600, 1.1, 0.55 * k, 0.001, 0.07);
    }
    return big ? 0.55 : 0.4;
  },
  // p.speed (normal impact speed)
  ballBounce(s, t, p) {
    const k = clamp01((p.speed || 0) / 2400);
    s.out.gain.value = 0.12 + 0.6 * Math.pow(k, 0.8);
    thump(s, t, 125, 72, 0.06, 0.9, 0.16 + 0.08 * k);
    const r = s.osc('sine', 260, t, 0.2), rg = s.gain(); envAD(rg.gain, t, 0.002, 0.15, 0.08);
    s.chain(r, rg, s.out);
    noiseHit(s, t, 'lowpass', 700 + 1200 * k, 0.9, 0.35, 0.001, 0.04);
    return 0.3;
  },
  jump(s, t) {
    s.out.gain.value = 0.42;
    const f = noiseHit(s, t, 'bandpass', 500, 1.2, 0.6, 0.006, 0.14);
    sweep(f.frequency, t, 500, 1700, 0.12);
    thump(s, t, 120, 52, 0.08, 0.55, 0.1);
    return 0.22;
  },
  doubleJump(s, t) {
    s.out.gain.value = 0.36;
    const f = noiseHit(s, t, 'bandpass', 750, 1.4, 0.6, 0.005, 0.12);
    sweep(f.frequency, t, 750, 2300, 0.1);
    thump(s, t, 160, 80, 0.06, 0.4, 0.08);
    return 0.2;
  },
  dodge(s, t) {
    s.out.gain.value = 0.45;
    const f = noiseHit(s, t, 'bandpass', 2400, 0.9, 0.65, 0.025, 0.24);
    sweep(f.frequency, t, 2600, 650, 0.24);
    thump(s, t, 140, 70, 0.07, 0.35, 0.09);
    return 0.32;
  },
  // p.speed (vertical impact speed)
  land(s, t, p) {
    const k = clamp01((p.speed || 0) / 1200);
    s.out.gain.value = 0.12 + 0.42 * k;
    thump(s, t, 85, 42, 0.1, 1.0, 0.14 + 0.12 * k);
    noiseHit(s, t, 'lowpass', 450, 0.8, 0.45, 0.002, 0.07 + 0.05 * k);
    // suspension clunk
    noiseHit(s, t + 0.012, 'bandpass', 1300, 3, 0.18 * k, 0.001, 0.03);
    return 0.35;
  },
  padSmall(s, t) {
    s.out.gain.value = 0.4;
    const notes = [1318.5, 1760];
    notes.forEach((f, i) => {
      const o = s.osc('triangle', f, t + i * 0.045, 0.16), g = s.gain();
      envAD(g.gain, t + i * 0.045, 0.004, 0.35, 0.11);
      s.chain(o, g, s.out);
    });
    noiseHit(s, t, 'highpass', 6000, 0.7, 0.12, 0.002, 0.07);
    return 0.25;
  },
  padBig(s, t) {
    s.out.gain.value = 0.5;
    const sw = s.osc('sine', 300, t, 0.4), sg = s.gain();
    sweep(sw.frequency, t, 300, 1250, 0.26);
    envAD(sg.gain, t, 0.05, 0.3, 0.3);
    s.chain(sw, sg, s.out);
    const notes = [880, 1108.7, 1318.5, 1760];
    notes.forEach((f, i) => {
      const tt = t + 0.04 + i * 0.05;
      const o = s.osc('triangle', f, tt, 0.5), o2 = s.osc('sine', f * 2.002, tt, 0.5), g = s.gain();
      envAD(g.gain, tt, 0.006, 0.28, 0.38);
      o.connect(g); o2.connect(g); g.connect(s.out);
    });
    const f = noiseHit(s, t, 'bandpass', 800, 1.5, 0.35, 0.08, 0.35);
    sweep(f.frequency, t, 800, 4500, 0.4);
    return 0.75;
  },
  // explosion: demo / goal. p.size 0..1
  explosion(s, t, p) {
    const size = p.size == null ? 1 : p.size;
    s.out.gain.value = 0.42 + 0.25 * size;
    const n = s.noise(t, 1.6, 0.8), dr = s.shaper(s.lib.drive), lp = s.filt('lowpass', 4000, 0.8), g = s.gain();
    sweep(lp.frequency, t, 4500, 160, 0.9);
    envAD(g.gain, t, 0.004, 0.9, 1.1 + 0.3 * size);
    s.chain(n, dr, lp, g, s.out);
    thump(s, t, 110, 30, 0.5, 1.0, 0.9 + 0.3 * size);
    noiseHit(s, t, 'bandpass', 1500, 2, 0.55, 0.002, 0.13);
    // debris
    const rng = mulberry32((Math.random() * 1e9) | 0);
    const nd = 5 + Math.floor(size * 5);
    for (let i = 0; i < nd; i++) {
      const tt = t + 0.12 + rng() * 0.8;
      noiseHit(s, tt, 'bandpass', 1400 + rng() * 4200, 2.5 + rng() * 3, (0.1 + rng() * 0.2) * (1 - (tt - t) * 0.6), 0.001, 0.025 + rng() * 0.05);
    }
    return 1.7;
  },
  // p.speed (closing speed)
  carBump(s, t, p) {
    const k = clamp01((p.speed || 0) / 2000);
    s.out.gain.value = 0.18 + 0.45 * k;
    noiseHit(s, t, 'bandpass', 900, 1.4, 0.75, 0.002, 0.1 + 0.05 * k);
    const m1 = s.osc('square', 412, t, 0.2), m2 = s.osc('square', 617, t, 0.2);
    const bp = s.filt('bandpass', 1600, 3), mg = s.gain(); envAD(mg.gain, t, 0.002, 0.18, 0.12);
    m1.connect(bp); m2.connect(bp); s.chain(bp, mg, s.out);
    thump(s, t, 95, 48, 0.08, 0.85, 0.13);
    return 0.3;
  },
  supersonic(s, t) {
    s.out.gain.value = 0.65;
    const f = noiseHit(s, t, 'bandpass', 500, 1.5, 0.75, 0.12, 0.5);
    sweep(f.frequency, t, 450, 3600, 0.45);
    const z = s.osc('sine', 900, t, 0.6), zg = s.gain();
    sweep(z.frequency, t, 900, 1900, 0.4);
    envAD(zg.gain, t, 0.08, 0.06, 0.4);
    s.chain(z, zg, s.out);
    return 0.7;
  },
  beep(s, t) {
    s.out.gain.value = 0.32;
    const o = s.osc('triangle', 587.3, t, 0.3), o2 = s.osc('square', 587.3, t, 0.3);
    const lp = s.filt('lowpass', 2400, 0.7), g2 = s.gain(0.18), g = s.gain();
    o2.connect(g2); g2.connect(lp); o.connect(lp);
    envAHR(g.gain, t, 0.006, 0.8, 0.15, 0.06);
    s.chain(lp, g, s.out);
    return 0.25;
  },
  go(s, t) {
    s.out.gain.value = 0.36;
    const lp = s.filt('lowpass', 3500, 0.7), g = s.gain();
    for (const [f, a] of [[1174.7, 0.8], [1760, 0.45], [587.3, 0.35]]) {
      const o = s.osc('triangle', f, t, 0.75), og = s.gain(a); s.chain(o, og, lp);
    }
    const sq = s.osc('square', 1174.7, t, 0.75), sqg = s.gain(0.1); s.chain(sq, sqg, lp);
    envAHR(g.gain, t, 0.008, 0.8, 0.38, 0.28);
    s.chain(lp, g, s.out);
    return 0.7;
  },
  // stadium horn, p.len seconds of sustain
  horn(s, t, p) {
    const len = p.len || 1.8;
    s.out.gain.value = 0.52;
    const lp = s.filt('lowpass', 500, 1.2), dr = s.shaper(s.lib.drive), g = s.gain();
    lp.frequency.setValueAtTime(450, t);
    lp.frequency.linearRampToValueAtTime(1900, t + 0.12);
    lp.frequency.setTargetAtTime(1300, t + 0.12, 0.4);
    const vib = s.osc('sine', 5.3, t, len + 1), vg = s.gain(1.1);
    vib.connect(vg);
    for (const [f, a] of [[110, 0.9], [138.6, 0.6], [164.8, 0.7], [220, 0.45], [110.6, 0.5]]) {
      const o = s.osc('sawtooth', f, t, len + 0.9), og = s.gain(a * 0.3);
      vg.connect(o.frequency);
      s.chain(o, og, lp);
    }
    s.chain(lp, dr, g, s.out);
    envAHR(g.gain, t, 0.07, 0.8, len, 0.55);
    return len + 0.7;
  },
  // crowd "ooh" (uses the murmur buffer through vowel formants; routed to the crowd bus)
  ooh(s, t, p) {
    s.out.gain.value = 0.9 * (p.v == null ? 1 : p.v);
    const src = s.noise(t, 2.2, 1.06, s.lib.murmur);
    src.playbackRate.setValueAtTime(1.08, t); src.playbackRate.linearRampToValueAtTime(0.9, t + 1.6);
    const f1 = s.filt('bandpass', 360, 3), f2 = s.filt('bandpass', 820, 4), g1 = s.gain(1), g2 = s.gain(0.6), g = s.gain();
    src.connect(f1); src.connect(f2); s.chain(f1, g1, g); s.chain(f2, g2, g);
    const src2 = s.noise(t, 2.2, 1.0, s.lib.roar), f3 = s.filt('bandpass', 600, 2.5), g3 = s.gain(0.5);
    s.chain(src2, f3, g3, g);
    g.connect(s.out);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(2.2, t + 0.35);
    g.gain.setValueAtTime(2.2, t + 0.6);
    g.gain.exponentialRampToValueAtTime(EPS, t + 2.0);
    return 2.1;
  },
  // short cheer burst (saves / goals), routed to the crowd bus
  cheer(s, t, p) {
    s.out.gain.value = p.v == null ? 1 : p.v;
    const src = s.noise(t, 3.2, 1.0, s.lib.roar), hp = s.filt('highpass', 250, 0.7), g = s.gain();
    s.chain(src, hp, g, s.out);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.6, t + 0.25);
    g.gain.setTargetAtTime(0, t + 0.9, 0.6);
    g.gain.setValueAtTime(0, t + 3.1);
    return 3.1;
  },
  replayWhoosh(s, t) {
    s.out.gain.value = 0.28;
    const f = noiseHit(s, t, 'bandpass', 300, 1.1, 0.8, 0.25, 0.4);
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.28);
    f.frequency.exponentialRampToValueAtTime(400, t + 0.65);
    return 0.7;
  },
  respawn(s, t) {
    s.out.gain.value = 0.2;
    const o = s.osc('triangle', 600, t, 0.4), g = s.gain();
    sweep(o.frequency, t, 520, 1240, 0.3);
    envAD(g.gain, t, 0.03, 0.5, 0.3);
    s.chain(o, g, s.out);
    noiseHit(s, t, 'highpass', 5000, 0.7, 0.12, 0.05, 0.2);
    return 0.4;
  },
};
