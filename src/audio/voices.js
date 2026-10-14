// TURBO PITCH — continuous voices (owned by the audio agent).
// CarVoice: one persistent graph per car (engine, boost roar, supersonic wind,
// wall scrape, tyre squeal) feeding one PannerNode. CrowdBed: the stadium
// ambience (murmur + excited roar loops). No nodes are created per frame —
// update() only moves AudioParams with setTargetAtTime.
import { tgt, clamp, clamp01 } from './synth.js';

// gear-ish rpm model: rpm climbs through each speed band then drops at the "shift"
const GEARS = [0, 420, 950, 1500, 2050, 2400];
export function engineRpm(speed) {
  let g = 0;
  while (g < GEARS.length - 2 && speed >= GEARS[g + 1]) g++;
  const a = GEARS[g], b = GEARS[g + 1];
  const frac = clamp01((speed - a) / (b - a));
  const lo = g === 0 ? 0.12 : 0.42;
  return { gear: g, rpm: lo + (1 - lo) * frac };
}

export function setPannerPos(p, x, y, z, t, tau = 0.02) {
  if (p.positionX) { tgt(p.positionX, x, t, tau); tgt(p.positionY, y, t, tau); tgt(p.positionZ, z, t, tau); }
  else if (p.setPosition) p.setPosition(x, y, z);
}
export function makePanner(ac, model = 'equalpower') {
  const p = ac.createPanner();
  p.panningModel = model;
  p.distanceModel = 'inverse';
  p.refDistance = 7;
  p.maxDistance = 400;
  p.rolloffFactor = 1.15;
  p.coneInnerAngle = 360; p.coneOuterAngle = 360; p.coneOuterGain = 1;
  return p;
}

export class CarVoice {
  constructor(ac, lib, dest, revIn, seed = 0) {
    this.ac = ac;
    this.nodes = [];
    const G = (v = 0) => { const g = ac.createGain(); g.gain.value = v; this.nodes.push(g); return g; };
    const F = (type, f, q = 0.707) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; this.nodes.push(b); return b; };
    const O = (type, f) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; this.nodes.push(o); return o; };
    this.detune = 0.96 + ((seed * 0.6180339) % 1) * 0.09; // per-car voice variety
    this.panner = makePanner(ac, 'equalpower');
    this.nodes.push(this.panner);
    this.mix = G(0);
    this.mix.connect(this.panner);
    this.panner.connect(dest);
    if (revIn) { this.send = G(0.06); this.panner.connect(this.send); this.send.connect(revIn); }

    // ---- engine: two detuned saws + sub sine → lowpass, turbine whine sine
    this.o1 = O('sawtooth', 60); this.o2 = O('sawtooth', 60.4); this.sub = O('sine', 30); this.whine = O('sine', 400);
    this.engFilt = F('lowpass', 600, 1.4);
    this.engGain = G(0); this.subGain = G(0.55); this.o2Gain = G(0.7); this.whineGain = G(0);
    this.o1.connect(this.engFilt); this.o2.connect(this.o2Gain); this.o2Gain.connect(this.engFilt);
    this.sub.connect(this.subGain); this.subGain.connect(this.engFilt);
    this.engFilt.connect(this.engGain); this.engGain.connect(this.mix);
    this.whine.connect(this.whineGain); this.whineGain.connect(this.mix);

    // ---- one shared noise source feeding boost / wind / scrape / squeal
    this.noise = ac.createBufferSource();
    this.noise.buffer = lib.noise; this.noise.loop = true;
    this.nodes.push(this.noise);
    // boost roar: broadband + rumble, with a rocket flutter LFO
    this.boostLP = F('lowpass', 2600, 0.6); this.boostRumble = F('lowpass', 170, 0.9); this.rumbleGain = G(2.2);
    this.boostGain = G(0); this.boostAM = G(1);
    this.lfo = O('sine', 27 + seed % 5); this.lfoDepth = G(0.22);
    this.noise.connect(this.boostLP); this.noise.connect(this.boostRumble);
    this.boostRumble.connect(this.rumbleGain);
    this.boostLP.connect(this.boostAM); this.rumbleGain.connect(this.boostAM);
    this.lfo.connect(this.lfoDepth); this.lfoDepth.connect(this.boostAM.gain);
    this.boostAM.connect(this.boostGain); this.boostGain.connect(this.mix);
    // supersonic / speed wind
    this.windBP = F('bandpass', 1500, 0.7); this.windGain = G(0);
    this.noise.connect(this.windBP); this.windBP.connect(this.windGain); this.windGain.connect(this.mix);
    // wall / ceiling scrape
    this.scrapeBP = F('bandpass', 650, 1.3); this.scrapeHP = F('highpass', 200, 0.7); this.scrapeGain = G(0);
    this.noise.connect(this.scrapeBP); this.scrapeBP.connect(this.scrapeHP); this.scrapeHP.connect(this.scrapeGain); this.scrapeGain.connect(this.mix);
    // powerslide squeal: narrow band
    this.squealBP = F('bandpass', 2100, 9); this.squealGain = G(0);
    this.noise.connect(this.squealBP); this.squealBP.connect(this.squealGain); this.squealGain.connect(this.mix);

    const t = ac.currentTime;
    for (const o of [this.o1, this.o2, this.sub, this.whine, this.lfo]) o.start(t);
    this.noise.start(t, Math.random() * (lib.noise.duration - 0.1));

    this.rpm = 0.12; this.scrapeKick = 0; this.alive = true;
    this.panModel = 'equalpower';
  }

  setPanningModel(m) { if (m !== this.panModel) { this.panModel = m; try { this.panner.panningModel = m; } catch (e) { /* unsupported */ } } }
  setPos(x, y, z, t) { setPannerPos(this.panner, x, y, z, t); }

  // cv: CarView. isPlayer: listener's own car. t: audio time, dt: frame dt.
  update(cv, isPlayer, t, dt) {
    const c = cv.controls || {};
    const throttle = Math.abs(c.throttle || 0);
    const speed = Math.abs(cv.forwardSpeed || 0);
    const vel = cv.vel || { x: 0, y: 0, z: 0 };
    const totalSpeed = Math.hypot(vel.x, vel.y, vel.z);
    const onGround = !!cv.isOnGround && (cv.numWheelsInContact == null || cv.numWheelsInContact > 0);
    const up = cv.up || (cv.rot && cv.rot.up) || { z: 1 };

    // ---- rpm (smoothed; free-revs in the air)
    let target, gear = 0;
    if (onGround) { const r = engineRpm(speed); target = r.rpm; gear = r.gear; }
    else { target = 0.3 + 0.55 * throttle; gear = 2; }
    const k = 1 - Math.exp(-dt / (onGround ? 0.07 : 0.25));
    this.rpm += (target - this.rpm) * (isFinite(k) ? k : 1);
    const rpm = this.rpm, load = Math.max(throttle, cv.isBoosting ? 1 : 0);

    const f = (36 + rpm * 92 + gear * 6) * this.detune;
    tgt(this.o1.frequency, f, t, 0.03);
    tgt(this.o2.frequency, f * 1.0075, t, 0.03);
    tgt(this.sub.frequency, f * 0.5, t, 0.03);
    tgt(this.engFilt.frequency, 260 + rpm * 1100 * (0.45 + 0.55 * load) + speed * 0.15, t, 0.05);
    tgt(this.engGain.gain, 0.07 + 0.1 * load + 0.07 * rpm, t, 0.06);
    tgt(this.whine.frequency, (340 + speed * 0.78) * this.detune, t, 0.05);
    tgt(this.whineGain.gain, 0.006 + 0.022 * (speed / 2300) * (0.4 + 0.6 * load), t, 0.08);

    // ---- boost
    tgt(this.boostGain.gain, cv.isBoosting ? 0.45 : 0, t, cv.isBoosting ? 0.025 : 0.09);

    // ---- wind (speed rush, strong while supersonic)
    const ss = cv.isSupersonic ? 1 : 0;
    const rush = clamp01((totalSpeed - 1300) / 1500);
    tgt(this.windGain.gain, 0.05 * rush + 0.16 * ss, t, 0.15);
    tgt(this.windBP.frequency, 900 + totalSpeed * 0.6 + ss * 600, t, 0.2);

    // ---- wall / ceiling scrape (on a surface that is not the floor, coasting)
    let scrape = 0;
    if (onGround && up.z < 0.7 && totalSpeed > 300 && throttle < 0.3) scrape = clamp01((totalSpeed - 300) / 1400);
    this.scrapeKick = Math.max(0, this.scrapeKick - dt * 2.5);
    scrape = Math.max(scrape, this.scrapeKick);
    tgt(this.scrapeGain.gain, 0.32 * scrape, t, 0.06);
    tgt(this.scrapeBP.frequency, 450 + totalSpeed * 0.25, t, 0.1);

    // ---- powerslide / sideways tyre squeal
    let squeal = 0;
    if (onGround && cv.right) {
      const lat = Math.abs(vel.x * cv.right.x + vel.y * cv.right.y + vel.z * cv.right.z);
      const hb = cv.handbrakeVal || 0;
      squeal = clamp01((lat - 250) / 900) * (0.35 + 0.65 * hb);
      if (lat < 600 && hb < 0.2) squeal = 0;
    }
    tgt(this.squealGain.gain, 0.4 * squeal, t, 0.05);

    // ---- mix: player car louder, demoed cars silent
    const mix = cv.isDemoed ? 0 : (isPlayer ? 0.5 : 0.38);
    tgt(this.mix.gain, mix, t, cv.isDemoed ? 0.03 : 0.12);
  }

  dispose(t) {
    if (!this.alive) return;
    this.alive = false;
    try { this.mix.gain.cancelScheduledValues(t); this.mix.gain.setTargetAtTime(0, t, 0.03); } catch (e) { /* closed */ }
    const stopAt = t + 0.2;
    for (const n of this.nodes) if (n.stop) { try { n.stop(stopAt); } catch (e) { /* stopped */ } }
    const nodes = this.nodes;
    setTimeout(() => { for (const n of nodes) { try { n.disconnect(); } catch (e) { /* */ } } }, 400);
  }
}

export class CrowdBed {
  constructor(ac, lib, dest) {
    this.ac = ac;
    const mk = (buf) => {
      const s = ac.createBufferSource(); s.buffer = buf; s.loop = true;
      const g = ac.createGain(); g.gain.value = 0;
      s.connect(g); g.connect(dest);
      s.start(ac.currentTime, Math.random() * buf.duration * 0.9);
      return { s, g };
    };
    this.murmur = mk(lib.murmur);
    this.roar = mk(lib.roar);
  }
  // level: 0 = silent, 1 = match; excite/hype 0..1
  update(level, excite, hype, t) {
    tgt(this.murmur.g.gain, level * (0.26 + 0.12 * excite) * (1 - 0.35 * hype), t, 0.6);
    tgt(this.roar.g.gain, level * clamp(0.4 * excite + 1.0 * hype, 0, 1.1), t, hype > 0.5 ? 0.12 : 0.45);
  }
  dispose() {
    for (const v of [this.murmur, this.roar]) { try { v.s.stop(); } catch (e) { /* */ } try { v.g.disconnect(); } catch (e) { /* */ } }
  }
}
