// TURBO PITCH — ATK kart sounds. Real recordings (CC0, BigSoundBank; credits in
// tools/sounds/kart/CREDITS.md), packed into kartSounds.js by tools/pack_sounds.mjs.
// A KartLayer rides on a car's CarVoice (same panner, so it is placed in 3D with the car):
//   * engine: a small ride-on tractor engine loop, pitched with the rpm model and louder with load
//     (the synthesised engine is turned down for karts)
//   * flag: fabric flapping, rising with speed (the whip flag on the back)
//   * cargo: metal rattles on landings and bumps, small clinks while driving fast
//   * charms: the plush tomato / burger squeak when the kart flips or lands hard
//   * horn: a beep-beep when the kart scores or demolishes someone
import { KART_SOUNDS } from './kartSounds.js';
import { tgt, clamp01 } from './synth.js';

// decode once per AudioContext (async); resolves to { engine_loop, flag_flap, horn, rattle1.., squeak }
const decoded = new WeakMap();
export function loadKartSounds(ac) {
  if (decoded.has(ac)) return decoded.get(ac);
  const p = Promise.all(Object.entries(KART_SOUNDS).map(([name, b64]) => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Promise((res, rej) => ac.decodeAudioData(bytes.buffer, res, rej)).then((buf) => [name, buf]);
  })).then((list) => Object.fromEntries(list));
  decoded.set(ac, p);
  return p;
}

const MAX_SHOTS = 5;   // per kart

export class KartLayer {
  constructor(ac, bufs, dest) {
    this.ac = ac; this.bufs = bufs; this.dest = dest;
    this.rattles = [bufs.rattle1, bufs.rattle2, bufs.rattle3].filter(Boolean);
    const loop = (buf) => {
      const s = ac.createBufferSource(); s.buffer = buf; s.loop = true;
      const g = ac.createGain(); g.gain.value = 0;
      s.connect(g); g.connect(dest);
      s.start(ac.currentTime, Math.random() * buf.duration);
      return { s, g };
    };
    this.engine = loop(bufs.engine_loop);
    this.flag = loop(bufs.flag_flap);
    this.shots = [];
    this.prevVz = 0; this.prevGround = true; this.lastSqueak = -9; this.lastRattle = -9; this.clink = 1 + Math.random() * 3;
  }

  shot(buf, t, gain, rate = 1) {
    if (!buf) return;
    this.shots = this.shots.filter((s) => s.end > t);
    if (this.shots.length >= MAX_SHOTS) return;
    const s = this.ac.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    const g = this.ac.createGain(); g.gain.value = gain;
    s.connect(g); g.connect(this.dest);
    s.start(t);
    s.onended = () => { try { s.disconnect(); g.disconnect(); } catch (e) { /* */ } };
    this.shots.push({ s, end: t + buf.duration / rate });
  }
  rattle(t, gain) {
    if (t - this.lastRattle < 0.12) return;
    this.lastRattle = t;
    const b = this.rattles[(Math.random() * this.rattles.length) | 0];
    this.shot(b, t, gain, 0.9 + Math.random() * 0.35);
  }
  squeak(t, gain) {
    if (t - this.lastSqueak < 0.9) return;
    this.lastSqueak = t;
    this.shot(this.bufs.squeak, t + 0.05 + Math.random() * 0.1, gain, 0.9 + Math.random() * 0.25);
  }
  horn(t) { this.shot(this.bufs.horn, t + 0.35, 0.55); }
  // landing (vertical impact speed, uu/s): the cargo bangs, the cooler lid slams, the charms bounce
  land(t, speed) {
    const k = clamp01((speed - 150) / 900);
    if (k <= 0) return;
    this.rattle(t, 0.15 + 0.55 * k);
    if (k > 0.35) this.shot(this.rattles[(Math.random() * this.rattles.length) | 0], t + 0.09 + Math.random() * 0.06, 0.12 + 0.25 * k, 1.2);
    if (k > 0.5) this.squeak(t, 0.12 + 0.1 * k);
  }

  // rpm / gear / load from CarVoice's engine model
  update(cv, rpm, gear, load, onGround, t, dt) {
    const vel = cv.vel || { x: 0, y: 0, z: 0 };
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    // engine: a small single-cylinder; pitch follows the rpm (and drops a touch at each shift)
    tgt(this.engine.s.playbackRate, 0.72 + rpm * 0.95 + gear * 0.035, t, 0.04);
    tgt(this.engine.g.gain, cv.isDemoed ? 0 : 0.23 + 0.36 * load + 0.14 * rpm, t, 0.06);
    // flag: flaps harder and faster with the airflow
    const air = clamp01((speed - 250) / 1700);
    tgt(this.flag.g.gain, cv.isDemoed ? 0 : 0.42 * air * air + 0.05 * air, t, 0.2);
    tgt(this.flag.s.playbackRate, 0.8 + 0.5 * air, t, 0.3);
    if (cv.isDemoed) { this.prevGround = false; return; }
    // bumps while driving: the vertical speed jumps
    if (onGround && this.prevGround) {
      const dvz = Math.abs((vel.z || 0) - this.prevVz);
      if (dvz > 220) this.rattle(t, clamp01(dvz / 900) * 0.4);
      // loose cargo clinks now and then at speed
      const fast = clamp01((speed - 600) / 1500);
      this.clink -= dt * fast;
      if (this.clink <= 0) { this.clink = 1.5 + Math.random() * 3.5; this.rattle(t, 0.05 + 0.07 * fast); }
    }
    this.prevVz = vel.z || 0; this.prevGround = onGround;
  }

  dispose(t) {
    for (const l of [this.engine, this.flag]) {
      try { l.g.gain.cancelScheduledValues(t); l.g.gain.setTargetAtTime(0, t, 0.03); l.s.stop(t + 0.2); } catch (e) { /* */ }
    }
    for (const s of this.shots) { try { s.s.stop(t + 0.2); } catch (e) { /* */ } }
    const ls = [this.engine, this.flag];
    setTimeout(() => { for (const l of ls) { try { l.s.disconnect(); l.g.disconnect(); } catch (e) { /* */ } } }, 400);
  }
}
