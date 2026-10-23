// TURBO PITCH — audio engine (owned by the audio agent). Web Audio, everything synthesised except
// the kart skin's recorded sounds (kart.js) and the jeep driver's "oof".
// createAudio({ settings }) -> { unlock(), onEvents(events, view), update(view, listener, frameDt),
//                               setVolumes(audioSettings), setPaused(bool), dispose() }
// listener = { pos: THREE.Vector3 (three space, metres), quaternion: THREE.Quaternion, camera, playerCarId }
//
// Graph:  one-shots (Shot, ≤ MAX_SHOTS, optional PannerNode) ─┐
//         CarVoice per car (engine/boost/wind/scrape/squeal → PannerNode) ─┼─ sfxIn ─┐
//         reverb sends → convolver (generated stadium IR) → revOut ────────────────┤
//         CrowdBed (murmur + roar loops) + crowd one-shots ─ crowdIn ─────────────┴─ preMaster
//         preMaster → compressor → soft-clip waveshaper (|y| ≤ 0.97) → master vol → pause gain → out
//
// Dev hooks: window.__audioStats() (voice counts); with ?audiotest=1, window.__audioTest()
// renders every sound offline and returns peak/RMS per sound.
import { EV } from '../contracts.js';
import { simToThree } from '../render/util.js';
import { makeLib, bakeCrowdChannel, CROWD_SR, buildMaster, Shot, RECIPES, tgt, clamp01 } from './synth.js';
import { CarVoice, CrowdBed, makePanner } from './voices.js';
import { loadKartSounds, KartLayer, decodeSounds } from './kart.js';
import { JEEP_SOUNDS } from './jeepSounds.js';

const MAX_SHOTS = 24;

function urlParams() {
  try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(''); }
}

export function createAudio({ settings, devHooks = true } = {}) {
  const params = urlParams();
  const forceStart = params.has('audiotest') || params.get('audio') === '1';
  const vol = { master: 0.8, sfx: 0.9, crowd: 0.7, ...((settings && settings.audio) || {}) };

  let ac = null, lib = null, bus = null, crowd = null;
  let paused = false, disposed = false, pauseTimer = 0;
  const voices = new Map(); // carId -> CarVoice
  const shots = [];         // active one-shots {shot, end, prio}
  const lastKey = new Map();
  const stats = { played: 0, dropped: 0, stolen: 0, peakShots: 0, peakCarVoices: 0, updates: 0, byType: {} };
  let playerCarId = -1;
  // crowd / match state
  let excite = 0, hype = 0, threat = null, lastGoalT = -99, lastOohT = -99;
  let prevCountdown = null, prevState = null, lastBeep = { n: 0, t: -99 }, lastGoT = -99;
  let prevBallVel = null, lastReplayHitT = -99;
  const v3 = simToThree({ x: 0, y: 0, z: 0 });
  const seenIds = new Set();
  let kartBufs = null, kartLoading = false;   // kart recordings, decoded when the first kart appears
  let jeepBufs = null, jeepLoading = false;   // the jeep driver's "oof", decoded when the first jeep appears

  // ------------------------------------------------------------ context lifecycle
  function canStart() {
    if (forceStart) return true;
    const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
    return !ua || ua.hasBeenActive;
  }
  function unlock() {
    if (disposed) return;
    if (!ac) {
      if (!canStart()) return; // wait for a real gesture (avoids the autoplay warning)
      const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;
      try { ac = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ac = new AC(); } catch (e2) { ac = null; return; } }
      lib = makeLib(ac);
      bus = buildMaster(ac, lib, vol);
      if (paused) bus.pauseGain.gain.value = 0;
      bakeCrowdLater();
    }
    if (ac.state !== 'running' && !paused) { try { const p = ac.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* */ } }
  }
  // bake the crowd loops one channel per idle slot (4 small jobs instead of one long stall)
  function bakeCrowdLater() {
    const jobs = [['murmur', 0], ['murmur', 1], ['roar', 0], ['roar', 1]];
    const chans = { murmur: [], roar: [] };
    const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 40));
    const step = () => {
      if (disposed || !ac) return;
      const [kind, ch] = jobs.shift();
      const t0 = performance.now();
      chans[kind][ch] = bakeCrowdChannel(kind, ch);
      lib.timings[kind + ch] = performance.now() - t0;
      if (chans[kind].length === 2 && chans[kind][0] && chans[kind][1]) {
        const buf = ac.createBuffer(2, chans[kind][0].length, CROWD_SR);
        buf.getChannelData(0).set(chans[kind][0]); buf.getChannelData(1).set(chans[kind][1]);
        lib[kind] = buf;
      }
      if (jobs.length) idle(step);
      else crowd = new CrowdBed(ac, lib, bus.crowdIn);
    };
    idle(step);
  }
  const onGesture = () => { if (!ac || ac.state !== 'running') unlock(); };
  const GESTURES = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
  if (typeof window !== 'undefined') for (const g of GESTURES) window.addEventListener(g, onGesture, { capture: true, passive: true });

  function attachKart(v) {
    if (kartBufs) { v.attachKart(new KartLayer(ac, kartBufs, v.mix)); return; }
    if (kartLoading) return;
    kartLoading = true;
    loadKartSounds(ac).then((b) => { kartBufs = b; }).catch(() => { /* stay on the synth engine */ });
  }
  function loadJeep() {
    if (jeepLoading) return;
    jeepLoading = true;
    decodeSounds(ac, JEEP_SOUNDS).then((b) => { jeepBufs = b; }).catch(() => { /* no oof */ });
  }
  // a recorded one-shot at a sim position (null: non-spatial)
  function playBuffer(name, buf, pos, gain = 1, rate = 1) {
    if (!buf || !ready() || paused) return;
    const now = ac.currentTime;
    const s = ac.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    const g = ac.createGain(); g.gain.value = gain;
    s.connect(g);
    let p = null;
    if (pos) { p = makePanner(ac, 'equalpower'); setNodePos(p, pos); g.connect(p); p.connect(bus.sfxIn); } else g.connect(bus.sfxIn);
    s.start(now + 0.01);
    s.onended = () => { try { s.disconnect(); g.disconnect(); if (p) p.disconnect(); } catch (e) { /* */ } };
    stats.played++; stats.byType[name] = (stats.byType[name] || 0) + 1;
  }
  const kartOf = (id) => { const v = voices.get(id); return v && v.kart ? v.kart : null; };

  const ready = () => !!ac && !disposed && ac.state !== 'closed';

  // ------------------------------------------------------------ one-shot pool
  function cleanup(now) {
    for (let i = shots.length - 1; i >= 0; i--) if (shots[i].end < now) { shots[i].shot.dispose(); shots.splice(i, 1); }
  }
  function steal(entry, now) {
    const g = entry.shot.out.gain;
    try { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + 0.03); } catch (e) { /* */ }
    const s = entry.shot;
    setTimeout(() => s.dispose(), 90);
    stats.stolen++;
  }
  function setNodePos(p, pos) {
    simToThree(pos, v3);
    if (p.positionX) { p.positionX.value = v3.x; p.positionY.value = v3.y; p.positionZ.value = v3.z; }
    else if (p.setPosition) p.setPosition(v3.x, v3.y, v3.z);
  }
  // opts: {pos (sim) | null, prio 0..3, crowd bool, send, key, gap, gain, delay}
  function play(name, p, opts = {}) {
    if (!ready() || paused) return;
    const recipe = RECIPES[name];
    if (!recipe) return;
    if ((name === 'ooh' || name === 'cheer') && (!lib.murmur || !lib.roar)) return; // crowd not baked yet
    const now = ac.currentTime;
    if (opts.key) {
      const lk = lastKey.get(opts.key);
      if (lk !== undefined && now - lk < (opts.gap || 0.05)) return;
      lastKey.set(opts.key, now);
    }
    cleanup(now);
    const prio = opts.prio || 0;
    if (shots.length >= MAX_SHOTS) {
      let vi = -1;
      for (let i = 0; i < shots.length; i++) if (vi < 0 || shots[i].prio < shots[vi].prio || (shots[i].prio === shots[vi].prio && shots[i].start < shots[vi].start)) vi = i;
      if (shots[vi].prio > prio) { stats.dropped++; return; }
      steal(shots[vi], now);
      shots.splice(vi, 1);
    }
    let dest = opts.crowd ? bus.crowdIn : bus.sfxIn, panner = null;
    if (opts.pos) {
      panner = makePanner(ac, 'equalpower');
      setNodePos(panner, opts.pos);
      panner.connect(dest);
      dest = panner;
    }
    const shot = new Shot(ac, lib, dest, opts.crowd ? null : bus.revIn, opts.send || 0);
    if (panner) shot.nodes.push(panner);
    const t = now + 0.006 + (opts.delay || 0);
    let dur = 0.5;
    try { dur = recipe(shot, t, p || {}); } catch (e) { shot.dispose(); return; }
    if (opts.gain != null) shot.out.gain.value *= opts.gain;
    shots.push({ shot, end: t + dur + 0.15, prio, start: now });
    stats.played++;
    stats.byType[name] = (stats.byType[name] || 0) + 1;
    if (shots.length > stats.peakShots) stats.peakShots = shots.length;
  }

  // ------------------------------------------------------------ events
  function carById(view, id) {
    if (!view || !view.cars) return null;
    for (const c of view.cars) if (c.id === id) return c;
    return null;
  }
  // own car -> non spatial (null), others -> at event pos or car pos
  function carSoundPos(view, e, id) {
    if (id === playerCarId) return null;
    if (e && e.pos) return e.pos;
    const c = carById(view, id);
    return c ? c.pos : null;
  }
  function beep(n) {
    const now = ac.currentTime;
    if (lastBeep.n === n && now - lastBeep.t < 1.5) return;
    lastBeep = { n, t: now };
    play('beep', {}, { prio: 3 });
  }
  function goBeep() {
    const now = ac.currentTime;
    if (now - lastGoT < 1.5) return;
    lastGoT = now;
    play('go', {}, { prio: 3 });
  }

  function onEvents(events, view) {
    if (!ready() || !events || !events.length) return;
    for (const e of events) {
      switch (e.type) {
        case EV.BALL_HIT: {
          const k = clamp01((e.impulse || 0) / 3000);
          play('ballHit', { impulse: e.impulse }, { pos: e.pos, prio: 2, key: 'hit' + e.carId, gap: 0.06, send: 0.1 + 0.25 * k });
          break;
        }
        case EV.BALL_BOUNCE:
          play('ballBounce', { speed: e.speed }, { pos: e.pos, prio: 1, key: 'bounce', gap: 0.07, send: 0.12 });
          break;
        case EV.CAR_BUMP:
          for (const id of [e.attackerId, e.victimId]) if (kartOf(id)) kartOf(id).rattle(ac.currentTime, 0.2 + 0.4 * clamp01((e.speed || 0) / 2000));
          play('carBump', { speed: e.speed }, { pos: e.pos, prio: 2, key: 'bump' + Math.min(e.attackerId, e.victimId) + '_' + Math.max(e.attackerId, e.victimId), gap: 0.2, send: 0.12 });
          break;
        case EV.DEMO: {
          // the jeep's bacon-hair driver goes "oof" (Roblox death)
          const victim = carById(view, e.victimId);
          if (victim && victim.bodyId === 'jeep' && jeepBufs) playBuffer('oof', jeepBufs.oof, e.victimId === playerCarId ? null : e.pos, 0.9, 1.12);
          if (kartOf(e.attackerId)) kartOf(e.attackerId).horn(ac.currentTime);
          play('explosion', { size: 0.75 }, { pos: e.victimId === playerCarId ? null : e.pos, prio: 3, send: 0.4 });
          break;
        }
        case EV.RESPAWN:
          play('respawn', {}, { pos: carSoundPos(view, null, e.carId), prio: 0, gain: e.carId === playerCarId ? 1 : 0.7 });
          break;
        case EV.JUMP: case EV.DOUBLE_JUMP: case EV.DODGE: {
          const own = e.carId === playerCarId;
          if (e.type === EV.DODGE && kartOf(e.carId)) kartOf(e.carId).squeak(ac.currentTime, 0.16);
          play(e.type, {}, { pos: carSoundPos(view, e, e.carId), prio: own ? 1 : 0, gain: own ? 1 : 0.85, key: e.type + e.carId, gap: 0.05 });
          break;
        }
        case EV.LAND:
          if (kartOf(e.carId)) kartOf(e.carId).land(ac.currentTime, e.speed || 0);
          if ((e.speed || 0) > 160) play('land', { speed: e.speed }, { pos: carSoundPos(view, e, e.carId), prio: e.carId === playerCarId ? 1 : 0, key: 'land' + e.carId, gap: 0.2 });
          break;
        case EV.WALL_SCRAPE: {
          const v = voices.get(e.carId);
          if (v) v.scrapeKick = Math.max(v.scrapeKick, clamp01((e.speed || 800) / 1500));
          break;
        }
        case EV.SUPERSONIC_START:
          play('supersonic', {}, { pos: carSoundPos(view, null, e.carId), prio: 1, key: 'ss' + e.carId, gap: 0.8, gain: e.carId === playerCarId ? 1 : 0.8 });
          break;
        case EV.PAD_PICKUP: {
          const own = e.carId === playerCarId;
          play(e.isBig ? 'padBig' : 'padSmall', {}, { pos: own ? null : (e.pos || carSoundPos(view, null, e.carId)), prio: own ? 1 : 0, gain: own ? 1 : 0.6 });
          break;
        }
        case EV.GOAL:
          if (kartOf(e.scorerId)) kartOf(e.scorerId).horn(ac.currentTime + 0.4);
          hype = 1; lastGoalT = ac.currentTime; threat = null;
          play('explosion', { size: 1 }, { prio: 3, send: 0.5, gain: 0.9 });
          play('horn', { len: 1.9 }, { prio: 3, send: 0.45, delay: 0.25 });
          play('cheer', { v: 1 }, { crowd: true, prio: 2, delay: 0.1 });
          break;
        case EV.KICKOFF_COUNTDOWN:
          if (e.n >= 1 && e.n <= 3) beep(e.n);
          break;
        case EV.KICKOFF_GO:
          goBeep();
          break;
        case EV.MATCH_END:
          hype = Math.max(hype, 0.8);
          play('horn', { len: 3.0 }, { prio: 3, send: 0.45 });
          play('cheer', { v: 0.9 }, { crowd: true, prio: 2, delay: 0.3 });
          break;
        case EV.OVERTIME:
          hype = Math.max(hype, 0.5);
          play('horn', { len: 1.0 }, { prio: 3, send: 0.4 });
          break;
        case EV.STAT:
          if (e.kind === 'epicSave' || e.kind === 'save') {
            hype = Math.max(hype, e.kind === 'epicSave' ? 0.6 : 0.35);
            play('cheer', { v: e.kind === 'epicSave' ? 0.8 : 0.5 }, { crowd: true, prio: 1, key: 'cheer', gap: 1.5 });
          }
          break;
        case EV.REPLAY_START: case EV.REPLAY_END:
          play('replayWhoosh', {}, { prio: 1, key: 'replay', gap: 0.3 });
          break;
        default: break;
      }
    }
  }

  // ------------------------------------------------------------ listener
  function setListener(listener, t) {
    const L = ac.listener;
    const p = listener.pos, q = listener.quaternion;
    let fx = 0, fy = 0, fz = -1, ux = 0, uy = 1, uz = 0;
    if (q) {
      // forward = q·(0,0,-1), up = q·(0,1,0)  (v' = v + w·t + q×t, t = 2·q×v)
      let tx = -2 * q.y, ty = 2 * q.x, tz = 0; // t for v = (0,0,-1)
      fx = q.w * tx + (q.y * tz - q.z * ty);
      fy = q.w * ty + (q.z * tx - q.x * tz);
      fz = -1 + q.w * tz + (q.x * ty - q.y * tx);
      tx = -2 * q.z; ty = 0; tz = 2 * q.x; // t for v = (0,1,0)
      ux = q.w * tx + (q.y * tz - q.z * ty);
      uy = 1 + q.w * ty + (q.z * tx - q.x * tz);
      uz = q.w * tz + (q.x * ty - q.y * tx);
    }
    if (!p || !isFinite(p.x) || !isFinite(fx)) return;
    if (L.positionX) {
      tgt(L.positionX, p.x, t, 0.01); tgt(L.positionY, p.y, t, 0.01); tgt(L.positionZ, p.z, t, 0.01);
      tgt(L.forwardX, fx, t, 0.01); tgt(L.forwardY, fy, t, 0.01); tgt(L.forwardZ, fz, t, 0.01);
      tgt(L.upX, ux, t, 0.01); tgt(L.upY, uy, t, 0.01); tgt(L.upZ, uz, t, 0.01);
    } else {
      if (L.setPosition) L.setPosition(p.x, p.y, p.z);
      if (L.setOrientation) L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // ------------------------------------------------------------ crowd logic
  function updateCrowd(view, t, dt) {
    const m = view.match;
    const level = m ? (m.mode === 'freeplay' ? 0.45 : 1) : 0.22;
    let e = 0;
    const b = view.ball;
    if (m && b && b.pos && b.vel && !m.ballHidden) {
      const sgn = b.pos.y >= 0 ? 1 : -1;
      const ay = Math.abs(b.pos.y), toward = b.vel.y * sgn;
      const near = clamp01((ay - 3500) / 1500);
      const centred = Math.max(0.3, clamp01(1 - (Math.abs(b.pos.x) - 900) / 2500));
      e = near * centred * (toward > 150 ? 1 : 0.35);
      if (m.state === 'countdown') e *= 0.3;
      // near-miss "ooh": a threatening ball that turns away without a goal
      if (!view.isReplay && m.state === 'playing') {
        const threatening = ay > 4300 && toward > 500 && Math.abs(b.pos.x) < 1600 && b.pos.z < 1100;
        if (threatening) threat = { side: sgn, t };
        else if (threat && (threat.side !== sgn || toward < -200)) {
          if (t - threat.t < 1.2 && t - lastGoalT > 3 && t - lastOohT > 4) {
            lastOohT = t;
            play('ooh', { v: 0.9 }, { crowd: true, prio: 1 });
            hype = Math.max(hype, 0.25);
          }
          threat = null;
        } else if (threat && t - threat.t > 1.5) threat = null;
      }
    }
    const ke = 1 - Math.exp(-dt / 0.5);
    excite += (e - excite) * (isFinite(ke) ? ke : 1);
    // hype holds ~2 s after a goal, then decays
    const holding = t - lastGoalT < 2.2;
    if (!holding) hype *= Math.exp(-dt / 2.8);
    if (hype < 0.001) hype = 0;
    if (crowd) crowd.update(level, excite, hype, t);
  }

  // countdown beeps derived from the match view as a fallback for missed events
  function updateCountdown(view) {
    const m = view.match;
    if (!m || view.isReplay) { prevCountdown = null; prevState = m ? m.state : null; return; }
    if (m.state === 'countdown' && m.countdown >= 1 && m.countdown <= 3 && m.countdown !== prevCountdown) beep(m.countdown);
    if (prevState === 'countdown' && m.state === 'playing') goBeep();
    prevCountdown = m.state === 'countdown' ? m.countdown : null;
    prevState = m.state;
  }

  // replays emit no events: synthesise ball contacts from velocity jumps
  function updateReplayHits(view, t) {
    const b = view.ball;
    if (!view.isReplay || !b || !b.vel) { prevBallVel = null; return; }
    if (prevBallVel) {
      const dv = Math.hypot(b.vel.x - prevBallVel.x, b.vel.y - prevBallVel.y, b.vel.z - prevBallVel.z);
      if (dv > 450 && t - lastReplayHitT > 0.08) {
        lastReplayHitT = t;
        let nearCar = false;
        for (const c of view.cars) {
          if (c.isDemoed) continue;
          const dx = c.pos.x - b.pos.x, dy = c.pos.y - b.pos.y, dz = c.pos.z - b.pos.z;
          if (dx * dx + dy * dy + dz * dz < 330 * 330) { nearCar = true; break; }
        }
        if (nearCar) play('ballHit', { impulse: dv }, { pos: b.pos, prio: 2, send: 0.15 });
        else play('ballBounce', { speed: dv * 0.55 }, { pos: b.pos, prio: 1, send: 0.12 });
      }
    }
    prevBallVel = { x: b.vel.x, y: b.vel.y, z: b.vel.z };
  }

  // ------------------------------------------------------------ per frame
  function update(view, listener, dt) {
    if (!ready() || !view) return;
    if (settings && settings.audio) applyVolumes(settings.audio);
    if (paused || ac.state !== 'running') return;
    const t = ac.currentTime;
    dt = Math.min(Math.max(dt || 0.016, 0.001), 0.1);
    stats.updates++;
    if (listener) {
      playerCarId = listener.playerCarId != null ? listener.playerCarId : -1;
      setListener(listener, t);
    }
    // car voices
    const q = settings && settings.graphics && settings.graphics.quality;
    const panModel = q === 'high' || q === 'ultra' ? 'HRTF' : 'equalpower';
    const seen = seenIds; seen.clear();
    for (const cv of view.cars || []) {
      if (!cv || !cv.pos) continue;
      seen.add(cv.id);
      let v = voices.get(cv.id);
      if (!v) { v = new CarVoice(ac, lib, bus.sfxIn, bus.revIn, cv.id + 1); voices.set(cv.id, v); }
      if (cv.bodyId === 'kart' && !v.kart) attachKart(v);
      if (cv.bodyId === 'jeep' && !jeepBufs) loadJeep();
      v.setPanningModel(panModel);
      simToThree(cv.pos, v3);
      v.setPos(v3.x, v3.y, v3.z, t);
      v.update(cv, cv.id === playerCarId, t, dt);
    }
    for (const [id, v] of voices) if (!seen.has(id)) { v.dispose(t); voices.delete(id); }
    if (voices.size > stats.peakCarVoices) stats.peakCarVoices = voices.size;

    updateCountdown(view);
    updateReplayHits(view, t);
    updateCrowd(view, t, dt);
    cleanup(t);
  }

  // ------------------------------------------------------------ volumes / pause
  function applyVolumes(a) {
    if (!a) return;
    vol.master = clamp01(a.master ?? vol.master);
    vol.sfx = clamp01(a.sfx ?? vol.sfx);
    vol.crowd = clamp01(a.crowd ?? vol.crowd);
    if (!bus) return;
    const t = ac.currentTime;
    tgt(bus.masterVol.gain, vol.master, t, 0.05);
    tgt(bus.sfxIn.gain, vol.sfx, t, 0.05);
    tgt(bus.revOut.gain, vol.sfx * 0.9, t, 0.05);
    tgt(bus.crowdIn.gain, vol.crowd, t, 0.05);
  }
  function setVolumes(a) { applyVolumes(a); }

  function setPaused(b) {
    b = !!b;
    if (b === paused) return;
    paused = b;
    if (!ready()) return;
    const t = ac.currentTime;
    clearTimeout(pauseTimer);
    tgt(bus.pauseGain.gain, b ? 0 : 1, t, 0.04);
    if (b) {
      pauseTimer = setTimeout(() => { if (paused && ac && ac.state === 'running') { const p = ac.suspend(); if (p && p.catch) p.catch(() => {}); } }, 220);
    } else if (ac.state !== 'running') {
      const p = ac.resume(); if (p && p.catch) p.catch(() => {});
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(pauseTimer);
    if (typeof window !== 'undefined') for (const g of GESTURES) window.removeEventListener(g, onGesture, { capture: true });
    if (ac) {
      const t = ac.currentTime;
      for (const v of voices.values()) v.dispose(t);
      voices.clear();
      for (const s of shots) s.shot.dispose();
      shots.length = 0;
      crowd && crowd.dispose();
      try { const p = ac.close(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* */ }
    }
  }

  // ------------------------------------------------------------ dev hooks
  const debugStats = () => ({
    state: ac ? ac.state : 'none', shots: shots.length, peakShots: stats.peakShots, maxShots: MAX_SHOTS,
    carVoices: voices.size, kartVoices: [...voices.values()].filter((v) => v.kart).length, peakCarVoices: stats.peakCarVoices, played: stats.played, dropped: stats.dropped,
    stolen: stats.stolen, updates: stats.updates, byType: { ...stats.byType }, crowdReady: !!crowd, paused, excite: +excite.toFixed(3), hype: +hype.toFixed(3),
    bakeMs: lib ? Object.fromEntries(Object.entries(lib.timings).map(([k, v]) => [k, +v.toFixed(1)])) : null, sampleRate: ac ? ac.sampleRate : null,
  });
  if (devHooks && typeof window !== 'undefined') {
    window.__audioStats = debugStats;
    if (params.has('audiotest')) {
      window.__audioTest = async () => (await import('./tests/audiotest.js')).runAudioTest();
    }
  }

  unlock(); // no-op unless the page already had a user gesture (or ?audio=1)
  return { unlock, onEvents, update, setVolumes, setPaused, dispose, _debugStats: debugStats };
}
