// OWNER: VFX agent.
// createVFX(ctx) -> { onEvents(events, view), update(view, frameDt, camera), setQuality(name), clear(), dispose() }
//
// GPU-cheap by construction: every system is ONE draw call over a preallocated
// pool and is animated in its vertex shader from spawn records (no per-frame
// CPU work per particle, no per-frame allocations):
//   particles (additive)  — boost fire, sparks, glows, flashes, glints
//   particles (alpha)     — smoke & dust
//   flames                — boost flame cones for every nozzle of every car
//   streaks               — supersonic wind streaks
//   ribbons               — supersonic contrails (CPU strip, a few hundred verts)
//   skids                 — powerslide tyre marks (instanced segments)
//   rings + shells        — shockwaves
//   debris                — demolition body panels (InstancedMesh, lit)
// + one PointLight (always present so no shader recompiles) for explosion flashes.
//
// Time base: VFX advance with the view's time (so they freeze while paused and
// follow slow-motion replays) and fall back to frame dt across discontinuities.
import * as THREE from 'three';
import * as carsMod from './cars.js';
import { EV, TEAM_COLORS, QUALITY, BALL_RADIUS } from '../contracts.js';
import { simRotToQuat } from './util.js';
import { ParticlePool, SHAPE } from './vfx/particles.js';
import { BoostFlames, MAX_CARS } from './vfx/flames.js';
import { SupersonicStreaks } from './vfx/streaks.js';
import { Ribbons } from './vfx/ribbons.js';
import { SkidMarks } from './vfx/skids.js';
import { Shocks } from './vfx/shocks.js';
import { Debris } from './vfx/debris.js';

const ADD_CAP = 12000;
const SMOKE_CAP = 7000;
const U = 0.01; // uu -> m
const rand = Math.random;
const rr = (a, b) => a + (b - a) * rand();

// ---- colours (linear, HDR) ----------------------------------------------------
const C = {
  fire0: [1.9, 0.8, 0.2, 0.42], fire1: [0.8, 0.07, 0.012, 0.0],
  fireSS0: [2.3, 1.3, 0.42, 0.45], fireSS1: [0.9, 0.16, 0.03, 0.0],
  ember0: [6.0, 3.6, 1.2, 1.0], ember1: [2.4, 0.5, 0.08, 0.0],
  smoke0: [0.1, 0.095, 0.09, 0.5], smoke1: [0.2, 0.195, 0.19, 0.0],
  dust0: [0.24, 0.23, 0.21, 0.22], dust1: [0.3, 0.29, 0.27, 0.0],
  white0: [7, 7, 7, 1], white1: [2.5, 2.4, 2.2, 0],
  hitSpark0: [6.0, 5.0, 3.2, 1.0], hitSpark1: [2.4, 0.9, 0.2, 0.0],
  landSpark0: [6.0, 3.8, 1.4, 1.0], landSpark1: [2.0, 0.45, 0.06, 0.0],
  padGlow0: [5.0, 2.8, 0.6, 1.0], padGlow1: [2.0, 0.7, 0.1, 0.0],
  demoFire0: [2.2, 0.85, 0.16, 0.6], demoFire1: [0.7, 0.08, 0.015, 0.0],
  demoSmoke0: [0.05, 0.045, 0.042, 0.62], demoSmoke1: [0.13, 0.125, 0.12, 0.0],
};
function linColor(hex) { return new THREE.Color(hex); } // sRGB hex -> linear (ColorManagement)
function teamPalette(team) {
  const tc = TEAM_COLORS[team] || TEAM_COLORS[0];
  const p = linColor(tc.primary), l = linColor(tc.light), d = linColor(tc.dark), g = linColor(tc.glow);
  return { p, l, d, g, hex: tc.primary };
}

export function createVFX(ctx) {
  const scene = ctx.scene;
  const root = new THREE.Group();
  root.name = 'vfx';
  scene.add(root);

  // shared per-car uniform arrays (flames & streaks)
  const carMats = Array.from({ length: MAX_CARS }, () => new THREE.Matrix4().makeScale(0, 0, 0));
  const carK = Array.from({ length: MAX_CARS }, () => new THREE.Vector4());

  const add = new ParticlePool(ADD_CAP, true, 20);
  const smoke = new ParticlePool(SMOKE_CAP, false, 12);
  const flames = new BoostFlames(carMats, carK);
  const streaks = new SupersonicStreaks(carMats, carK);
  const ribbons = new Ribbons(MAX_CARS * 2, { life: 0.4, width: 0.032, color: [1.0, 1.04, 1.12], alpha: 0.3 });
  const skids = new SkidMarks(2400, 7);
  const shocks = new Shocks();
  const debris = new Debris(48);
  for (const o of [skids.mesh, smoke.mesh, ribbons.mesh, add.mesh, flames.mesh, streaks.mesh, shocks.rings.mesh, shocks.shells.mesh, debris.mesh]) root.add(o);

  const light = new THREE.PointLight(0xffffff, 0, 60, 2);
  light.castShadow = false;
  root.add(light);
  const flash = { t: 0, life: 1, peak: 0, color: new THREE.Color() };

  let density = (ctx.quality && ctx.quality.particles) || 1;
  let ribbonsOn = true;
  let time = 0, lastViewTime = -1, step = 0;
  let lastView = null;

  // ---- scratch (no per-frame allocations) ------------------------------------
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  const _q = new THREE.Quaternion(), _one = new THREE.Vector3(1, 1, 1);
  const _fw = new THREE.Vector3(), _rt = new THREE.Vector3(), _up = new THREE.Vector3(), _cv = new THREE.Vector3();
  const _col1 = [0, 0, 0, 0];
  const _c = new THREE.Color(), _cw = new THREE.Color(1, 1, 1);

  // ---- per-car state --------------------------------------------------------------
  const cars = new Map(); // carId -> state
  let slotsDirty = true;

  function nozzlesFor(bodyId, hitbox) {
    if (typeof carsMod.getBoostNozzles === 'function') {
      try {
        const r = carsMod.getBoostNozzles(bodyId);
        if (r && r.length) return r.map((v) => new THREE.Vector3(v.x, v.y, v.z));
      } catch (e) { /* fall back to the hitbox */ }
    }
    const cfg = ctx.carConfigs[hitbox] || ctx.carConfigs.OCTANE;
    const s = cfg.hitboxSize, o = cfg.hitboxOffset;
    const x = (o.x - s.x / 2) / 100, y = (o.z - s.z / 2 + 0.4 * s.z) / 100, w = (0.15 * s.y) / 100;
    return [new THREE.Vector3(x, y, -w), new THREE.Vector3(x, y, w)];
  }

  function carState(cv) {
    let st = cars.get(cv.id);
    if (st && (st.bodyId !== cv.bodyId || st.hitbox !== cv.hitbox)) { cars.delete(cv.id); st = null; }
    if (!st) {
      const cfg = ctx.carConfigs[cv.hitbox] || ctx.carConfigs.OCTANE;
      const noz = nozzlesFor(cv.bodyId, cv.hitbox);
      st = {
        id: cv.id, bodyId: cv.bodyId, hitbox: cv.hitbox, cfg, slot: -1, seen: 0,
        nozzles: noz, last: noz.map(() => new THREE.Vector3()), acc: noz.map(() => 0), hasLast: false,
        boost: 0, ss: 0, streak: 0, scale: noz.length >= 2 ? 1 : 1.3,
        rear: [
          new THREE.Vector3((cfg.hitboxOffset.x - cfg.hitboxSize.x / 2) / 100 + 0.04, (cfg.hitboxOffset.z + cfg.hitboxSize.z * 0.15) / 100, -cfg.hitboxSize.y * 0.43 / 100),
          new THREE.Vector3((cfg.hitboxOffset.x - cfg.hitboxSize.x / 2) / 100 + 0.04, (cfg.hitboxOffset.z + cfg.hitboxSize.z * 0.15) / 100, cfg.hitboxSize.y * 0.43 / 100),
        ],
        skid: [false, false], skidLast: [new THREE.Vector3(), new THREE.Vector3()],
      };
      cars.set(cv.id, st);
      slotsDirty = true;
    }
    return st;
  }

  function rebuildSlots(view) {
    const used = new Set();
    for (const st of cars.values()) if (st.slot >= 0 && st.slot < MAX_CARS) used.add(st.slot);
    for (const st of cars.values()) {
      if (st.slot >= 0) continue;
      for (let s = 0; s < MAX_CARS; s++) if (!used.has(s)) { st.slot = s; used.add(s); break; }
    }
    const slots = [];
    for (const st of cars.values()) if (st.slot >= 0) slots.push({ slot: st.slot, nozzles: st.nozzles, cfg: st.cfg });
    flames.setCars(slots);
    streaks.setCars(slots);
    slotsDirty = false;
  }

  // ---- helpers ---------------------------------------------------------------------
  const S = (v, out) => out.set(v.x * U, v.z * U, v.y * U);          // sim pos -> three
  const SD = (x, y, z, out) => out.set(x, z, y);                         // sim dir -> three
  function carBasis(cv) {
    const m = cv.rot.m;
    _fw.set(m[0], m[6], m[3]); _rt.set(m[1], m[7], m[4]); _up.set(m[2], m[8], m[5]);
  }
  function randDir(out) {
    const z = rr(-1, 1), a = rand() * 6.2832, r = Math.sqrt(1 - z * z);
    return out.set(r * Math.cos(a), z, r * Math.sin(a));
  }
  function scaled(c, k, a, out) { out[0] = c.r * k; out[1] = c.g * k; out[2] = c.b * k; out[3] = a; return out; }
  const cnt = (n) => { const x = n * density; const i = Math.floor(x); return i + (rand() < x - i ? 1 : 0); };
  function startFlash(pos, color, peak, life) {
    const cur = flash.peak * Math.max(0, 1 - flash.t / flash.life);
    if (peak < cur) return;
    light.position.copy(pos);
    flash.color.copy(color); flash.peak = peak; flash.life = life; flash.t = 0;
  }
  function findCar(view, id) {
    if (!view) return null;
    for (const c of view.cars) if (c.id === id) return c;
    return null;
  }
  // world contact point of wheel i (three space) -> out
  function wheelContact(cv, i, out) {
    const w = cv.wheels[i], m = cv.rot.m;
    const lx = w.offset.x, ly = w.offset.y, lz = w.offset.z - w.suspLen - w.radius;
    const sx = cv.pos.x + m[0] * lx + m[1] * ly + m[2] * lz;
    const sy = cv.pos.y + m[3] * lx + m[4] * ly + m[5] * lz;
    const sz = cv.pos.z + m[6] * lx + m[7] * ly + m[8] * lz;
    return out.set(sx * U, sz * U, sy * U);
  }

  // ---- continuous effects -------------------------------------------------------------
  function emitBoostTrail(cv, st, carVel) {
    const n = st.nozzles.length;
    const ss = st.ss > 0.5;
    const back = _v3.copy(_fw).multiplyScalar(-1);
    for (let j = 0; j < n; j++) {
      const cur = _v.copy(st.nozzles[j]).applyMatrix4(carMats[st.slot]);
      const last = st.last[j];
      if (!st.hasLast) last.copy(cur);
      let dist = cur.distanceTo(last);
      if (dist > 5) { last.copy(cur); dist = 0; }
      st.acc[j] += (dist / 0.12 + step * 60) * density;
      let k = Math.floor(st.acc[j]);
      st.acc[j] -= k;
      if (k > 60) k = 60;
      for (let i = 0; i < k; i++) {
        const u = (i + rand()) / k;
        const px = last.x + (cur.x - last.x) * u, py = last.y + (cur.y - last.y) * u, pz = last.z + (cur.z - last.z) * u;
        const birth = time - (1 - u) * step;
        // fire
        const sp = rr(3.0, 5.5);
        const off = rr(0.25, 0.5) * st.scale; // particles take over where the flame cone thins out
        add.style(ss ? C.fireSS0 : C.fire0, ss ? C.fireSS1 : C.fire1, 3.5, 0, SHAPE.GLOW, 0, 0.04);
        add.emit(px + back.x * off, py + back.y * off, pz + back.z * off,
          back.x * sp + rr(-0.6, 0.6) + carVel.x * 0.1, back.y * sp + rr(-0.6, 0.6) + carVel.y * 0.1, back.z * sp + rr(-0.6, 0.6) + carVel.z * 0.1,
          rr(0.2, 0.3) * (ss ? 1.3 : 1), rr(0.1, 0.13) * st.scale, rr(0.24, 0.38) * st.scale, birth);
        // smoke
        if (rand() < 0.5) {
          smoke.style(C.smoke0, C.smoke1, 2.2, -0.35, SHAPE.SMOKE, 0, 0.12);
          smoke.emit(px - _fw.x * 0.25, py - _fw.y * 0.25, pz - _fw.z * 0.25,
            back.x * 1.6 + rr(-0.5, 0.5), back.y * 1.6 + rr(-0.3, 0.6), back.z * 1.6 + rr(-0.5, 0.5),
            rr(0.8, 1.3), rr(0.1, 0.16) * st.scale, rr(0.45, 0.7) * st.scale, birth);
        }
        // sparkle
        if (rand() < 0.08) {
          add.style(C.ember0, C.ember1, 1.5, 3.0, SHAPE.SPARK, 0.012, 0);
          add.emit(px, py, pz, back.x * rr(3, 7) + rr(-2, 2), back.y * rr(3, 7) + rr(-1, 2.5), back.z * rr(3, 7) + rr(-2, 2),
            rr(0.2, 0.45), 0.014, 0.006, birth);
        }
      }
      last.copy(cur);
    }
    st.hasLast = true;
  }

  function updateSkids(cv, st, carVelSim) {
    const m = cv.rot.m;
    for (let k = 0; k < 2; k++) {
      const wi = 2 + k;
      const w = cv.wheels[wi];
      let on = false, strength = 0;
      if (w && w.contact && !cv.isDemoed) {
        // velocity of the contact point: v + w x r (sim)
        const lx = w.offset.x, ly = w.offset.y, lz = w.offset.z - w.suspLen - w.radius;
        const rx = m[0] * lx + m[1] * ly + m[2] * lz, ry = m[3] * lx + m[4] * ly + m[5] * lz, rz = m[6] * lx + m[7] * ly + m[8] * lz;
        const av = cv.angVel || { x: 0, y: 0, z: 0 };
        const vx = carVelSim.x + av.y * rz - av.z * ry, vy = carVelSim.y + av.z * rx - av.x * rz, vz = carVelSim.z + av.x * ry - av.y * rx;
        const lat = Math.abs(vx * m[1] + vy * m[4] + vz * m[7]);
        const hb = cv.handbrakeVal || 0;
        if ((hb > 0.3 && lat > 140) || lat > 750) { on = true; strength = Math.min(1, Math.max(0.3, (lat - 80) / 650)) * (hb > 0.3 ? 1 : 0.7); }
      }
      if (on) {
        const cur = wheelContact(cv, wi, _v2);
        const last = st.skidLast[k];
        if (!st.skid[k]) { last.copy(cur); st.skid[k] = true; }
        else {
          const d = cur.distanceTo(last);
          if (d > 2.5) last.copy(cur);
          else if (d > 0.14) {
            skids.add(last.x, last.y, last.z, cur.x, cur.y, cur.z, _up.x, _up.y, _up.z, 0.105, strength, time);
            last.copy(cur);
            // a little tyre smoke
            if (rand() < 0.35 * density) {
              smoke.style(C.dust0, C.dust1, 2.0, -0.4, SHAPE.SMOKE, 0, 0.15);
              smoke.emit(cur.x, cur.y + 0.08, cur.z, rr(-0.4, 0.4), rr(0.2, 0.7), rr(-0.4, 0.4), rr(0.5, 0.9), 0.14, rr(0.45, 0.7));
            }
          }
        }
      } else st.skid[k] = false;
    }
  }

  // ---- event effects ------------------------------------------------------------------
  function ballHit(e, view) {
    const s = Math.min(1, Math.max(0, (e.impulse - 150) / 2200));
    if (e.impulse < 60) return;
    const bp = S(e.pos, _v);
    const car = findCar(view, e.carId);
    const n = _v2.set(0, 1, 0);
    if (car) { S(car.pos, n); n.subVectors(bp, n).normalize(); }
    const cp = _v3.copy(bp).addScaledVector(n, -BALL_RADIUS * U);
    add.style(C.white0, C.white1, 0, 0, SHAPE.GLOW, 0, 0);
    add.emit(cp.x, cp.y, cp.z, 0, 0, 0, 0.12 + 0.1 * s, 0.35 + 1.2 * s, 1.0 + 2.2 * s);
    const k = cnt(4 + 30 * s);
    add.style(C.hitSpark0, C.hitSpark1, 3.0, 5.0, SHAPE.SPARK, 0.035, 0);
    for (let i = 0; i < k; i++) {
      randDir(_cv).addScaledVector(n, 0.9).normalize();
      const sp = rr(4, 8 + 16 * s);
      add.emit(cp.x, cp.y, cp.z, _cv.x * sp, _cv.y * sp, _cv.z * sp, rr(0.22, 0.5), rr(0.025, 0.045), 0.012);
    }
    if (s > 0.2) shocks.ring(cp.x, cp.y, cp.z, n.x, n.y, n.z, 0.24, 0.3, 1.2 + 2.6 * s, 0.14, 1.3 * s, [3, 3, 3.3], 2.5);
  }

  function ballBounce(e) {
    if (e.speed < 450) return;
    const s = Math.min(1, (e.speed - 450) / 2000);
    const n = SD(e.normal.x, e.normal.y, e.normal.z, _v2);
    const cp = S(e.pos, _v).addScaledVector(n, -BALL_RADIUS * U * 0.92);
    const k = cnt(3 + 8 * s);
    smoke.style(C.dust0, C.dust1, 2.5, -0.2, SHAPE.SMOKE, 0, 0.1);
    for (let i = 0; i < k; i++) {
      randDir(_cv); const d = _cv.dot(n); _cv.addScaledVector(n, -d).normalize(); // tangent
      const sp = rr(1.5, 3.5 + 3 * s);
      smoke.emit(cp.x + n.x * 0.1, cp.y + n.y * 0.1, cp.z + n.z * 0.1, _cv.x * sp + n.x * 0.4, _cv.y * sp + n.y * 0.4, _cv.z * sp + n.z * 0.4,
        rr(0.5, 0.9), rr(0.15, 0.25), rr(0.5, 0.9 + 0.5 * s));
    }
  }

  function land(e, view) {
    const car = findCar(view, e.carId);
    if (!car || e.speed < 220) return;
    const s = Math.min(1, (e.speed - 220) / 900);
    carBasis(car);
    for (let wi = 0; wi < 4; wi++) {
      const p = wheelContact(car, wi, _v);
      const k = cnt(2 + 4 * s);
      smoke.style(C.dust0, C.dust1, 3.0, -0.25, SHAPE.SMOKE, 0, 0.1);
      for (let i = 0; i < k; i++) {
        randDir(_cv); const d = _cv.dot(_up); _cv.addScaledVector(_up, -d).normalize();
        const sp = rr(1.0, 2.5 + 3 * s);
        smoke.emit(p.x + _up.x * 0.08, p.y + _up.y * 0.08, p.z + _up.z * 0.08, _cv.x * sp, _cv.y * sp, _cv.z * sp, rr(0.45, 0.8), 0.1, rr(0.35, 0.6 + 0.4 * s));
      }
      if (e.speed > 520) {
        const ks = cnt(3 + 10 * s);
        add.style(C.landSpark0, C.landSpark1, 2.5, 7.0, SHAPE.SPARK, 0.03, 0);
        for (let i = 0; i < ks; i++) {
          randDir(_cv); const d = _cv.dot(_up); _cv.addScaledVector(_up, -d * 0.7).normalize();
          const sp = rr(3, 6 + 8 * s);
          add.emit(p.x, p.y + 0.03, p.z, _cv.x * sp, _cv.y * sp + 1.5, _cv.z * sp, rr(0.2, 0.45), 0.025, 0.01);
        }
      }
    }
  }

  function jumpPuff(e, view, air) {
    const car = findCar(view, e.carId);
    if (!car) return;
    carBasis(car);
    if (!air) {
      for (let wi = 0; wi < 4; wi++) {
        const p = wheelContact(car, wi, _v);
        const k = cnt(2);
        smoke.style(C.dust0, C.dust1, 3.0, -0.2, SHAPE.SMOKE, 0, 0.1);
        for (let i = 0; i < k; i++) {
          randDir(_cv); const d = _cv.dot(_up); _cv.addScaledVector(_up, -d).normalize();
          smoke.emit(p.x, p.y + 0.06, p.z, _cv.x * 1.8, _cv.y * 1.8 + 0.2, _cv.z * 1.8, rr(0.35, 0.6), 0.08, rr(0.3, 0.45));
        }
      }
    } else {
      S(car.pos, _v).addScaledVector(_up, -0.25);
      shocks.ring(_v.x, _v.y, _v.z, _up.x, _up.y, _up.z, 0.3, 0.3, 1.5, 0.18, 0.5, [1.6, 1.6, 1.7], 2);
      smoke.style([0.5, 0.5, 0.52, 0.18], [0.6, 0.6, 0.62, 0], 3.0, 0, SHAPE.SMOKE, 0, 0.1);
      const k = cnt(5);
      for (let i = 0; i < k; i++) {
        randDir(_cv); const d = _cv.dot(_up); _cv.addScaledVector(_up, -d).normalize();
        smoke.emit(_v.x, _v.y, _v.z, _cv.x * 2.5 - _up.x, _cv.y * 2.5 - _up.y, _cv.z * 2.5 - _up.z, rr(0.3, 0.5), 0.12, 0.45);
      }
    }
  }

  function padPickup(e) {
    const p = S(e.pos, _v);
    p.y = Math.max(p.y, 0.05);
    if (e.isBig) {
      add.style(C.padGlow0, C.padGlow1, 0, 0, SHAPE.GLOW, 0, 0);
      add.emit(p.x, p.y + 0.8, p.z, 0, 0, 0, 0.35, 1.2, 3.2);
      shocks.ring(p.x, p.y + 0.05, p.z, 0, 1, 0, 0.45, 0.6, 3.2, 0.12, 1.6, [4.0, 2.2, 0.5], 2.5);
      const k = cnt(40);
      add.style(C.ember0, C.ember1, 1.2, 2.5, SHAPE.SPARK, 0.03, 0);
      for (let i = 0; i < k; i++) {
        const a = rand() * 6.2832, r = rr(0.2, 1.3);
        add.emit(p.x + Math.cos(a) * r, p.y + rr(0.1, 1.2), p.z + Math.sin(a) * r, Math.cos(a) * rr(0.5, 2), rr(3, 9), Math.sin(a) * rr(0.5, 2), rr(0.4, 0.9), 0.04, 0.015);
      }
      add.style([6, 5, 3, 1], [3, 1.4, 0.3, 0], 0, 0, SHAPE.GLINT, 0, 0.1);
      for (let i = 0; i < 4; i++) add.emit(p.x + rr(-0.8, 0.8), p.y + rr(0.4, 1.8), p.z + rr(-0.8, 0.8), 0, 0.5, 0, rr(0.25, 0.45), 0.6, 0.1, time + i * 0.05);
    } else {
      add.style([5, 4, 2, 1], [2.5, 1.2, 0.2, 0], 0, 0, SHAPE.GLINT, 0, 0.05);
      add.emit(p.x, p.y + 0.35, p.z, 0, 0.6, 0, 0.3, 0.7, 0.1);
      const k = cnt(8);
      add.style(C.ember0, C.ember1, 1.5, 3, SHAPE.SPARK, 0.025, 0);
      for (let i = 0; i < k; i++) {
        const a = rand() * 6.2832;
        add.emit(p.x, p.y + 0.15, p.z, Math.cos(a) * rr(0.5, 1.5), rr(2, 4.5), Math.sin(a) * rr(0.5, 1.5), rr(0.3, 0.6), 0.03, 0.01);
      }
    }
  }

  function demo(e, view) {
    const car = findCar(view, e.victimId);
    const team = car ? car.team : 0;
    const pal = teamPalette(team);
    const c = S(e.pos, _v.set(0, 0, 0)).clone();
    const cvel = e.vel ? S(e.vel, new THREE.Vector3()) : new THREE.Vector3();
    cvel.multiplyScalar(0.35);
    // flash
    add.style([4, 3.2, 1.8, 1], [1.5, 0.5, 0.1, 0], 0, 0, SHAPE.GLOW, 0, 0);
    add.emit(c.x, c.y, c.z, 0, 0, 0, 0.22, 1.2, 4.5);
    startFlash(c, _c.setRGB(1, 0.55, 0.2), 450, 0.8);
    // fireball: hot yellow core puffs, then orange/red billows
    let k = cnt(16);
    add.style([2.6, 1.6, 0.5, 0.7], [1.2, 0.25, 0.04, 0], 3.5, -0.8, SHAPE.GLOW, 0, 0.04);
    for (let i = 0; i < k; i++) {
      randDir(_cv); const sp = rr(0.8, 3.5);
      add.emit(c.x + _cv.x * 0.3, c.y + _cv.y * 0.3, c.z + _cv.z * 0.3, _cv.x * sp + cvel.x, _cv.y * sp + cvel.y + 0.6, _cv.z * sp + cvel.z, rr(0.3, 0.55), rr(0.5, 0.8), rr(1.2, 1.8));
    }
    k = cnt(26);
    add.style(C.demoFire0, C.demoFire1, 3.2, -1.2, SHAPE.SMOKE, 0, 0.06);
    for (let i = 0; i < k; i++) {
      randDir(_cv); const sp = rr(2, 7);
      add.emit(c.x + _cv.x * 0.4, c.y + _cv.y * 0.4, c.z + _cv.z * 0.4, _cv.x * sp + cvel.x, _cv.y * sp + cvel.y + 1, _cv.z * sp + cvel.z, rr(0.5, 0.95), rr(0.45, 0.8), rr(1.3, 2.2));
    }
    // team-tinted inner glow
    add.style(scaled(pal.l, 1.6, 0.6, [0, 0, 0, 0]), scaled(pal.p, 0.8, 0, [0, 0, 0, 0]), 2, 0, SHAPE.GLOW, 0, 0);
    add.emit(c.x, c.y, c.z, cvel.x, cvel.y, cvel.z, 0.45, 1.0, 3.0);
    // sparks
    k = cnt(70);
    add.style(C.landSpark0, C.landSpark1, 1.2, 8, SHAPE.SPARK, 0.035, 0);
    for (let i = 0; i < k; i++) {
      randDir(_cv); _cv.y = Math.abs(_cv.y) * 0.8 + 0.1; _cv.normalize(); const sp = rr(6, 24);
      add.emit(c.x, c.y, c.z, _cv.x * sp + cvel.x, _cv.y * sp + cvel.y, _cv.z * sp + cvel.z, rr(0.5, 1.3), rr(0.03, 0.055), 0.015);
    }
    // smoke (lingers)
    // many smaller puffs born over ~0.7 s that rise and spread (no single grey dome)
    k = cnt(52);
    smoke.style(C.demoSmoke0, C.demoSmoke1, 1.4, -1.8, SHAPE.SMOKE, 0, 0.2);
    for (let i = 0; i < k; i++) {
      randDir(_cv); const sp = rr(0.8, 4);
      const r = rr(0.1, 1.2);
      smoke.emit(c.x + _cv.x * r, c.y + Math.abs(_cv.y) * 0.4, c.z + _cv.z * r, _cv.x * sp + cvel.x, Math.abs(_cv.y) * sp * 0.5 + cvel.y * 0.5 + 0.4, _cv.z * sp + cvel.z,
        rr(1.3, 2.3), rr(0.35, 0.65), rr(1.2, 2.3), time + rr(0.02, 0.7));
    }
    // shockwave
    shocks.ring(c.x, Math.max(0.05, c.y - 0.3), c.z, 0, 1, 0, 0.5, 0.5, 8, 0.06, 1.0, [3, 1.6, 0.6], 3);
    shocks.shell(c.x, c.y, c.z, 0.35, 0.5, 4.5, 0.35, [3, 1.6, 0.5], 3);
    // chunks
    const nChunks = 9;
    const tint = new THREE.Color().copy(pal.p).multiplyScalar(0.5).lerp(new THREE.Color(0.03, 0.03, 0.035), 0.5);
    const dark = new THREE.Color(0.025, 0.025, 0.028);
    for (let i = 0; i < nChunks; i++) {
      randDir(_cv); _cv.y = Math.abs(_cv.y) * 0.7 + 0.25; _cv.normalize();
      const sp = rr(3, 7.5);
      _v2.set(_cv.x * sp + cvel.x, _cv.y * sp + cvel.y + rr(1.5, 3.5), _cv.z * sp + cvel.z);
      _v3.set(c.x + _cv.x * 0.4, c.y + _cv.y * 0.2, c.z + _cv.z * 0.4);
      const big = i < 4;
      const sc = big ? new THREE.Vector3(rr(0.45, 0.75), rr(0.5, 0.9), rr(0.35, 0.6)) : new THREE.Vector3(rr(0.2, 0.38), rr(0.4, 0.9), rr(0.18, 0.34));
      debris.spawn(_v3, _v2, sc, i % 3 === 2 ? dark : tint, rr(2.2, 3.0));
    }
  }

  function goal(e, view) {
    const pal = teamPalette(e.team);
    const c = S(e.pos, new THREE.Vector3());
    const fz = e.pos.y > 0 ? -1 : 1; // towards the field (three z = sim y)
    // compact white-hot core (~4 m, ~0.15 s) + short team glow
    add.style([4, 4, 4, 1], scaled(pal.l, 2, 0, _col1), 0, 0, SHAPE.GLOW, 0, 0);
    add.emit(c.x, c.y, c.z, 0, 0, 0, 0.15, 0.8, 4);
    add.style(scaled(pal.l, 1.6, 0.5, [0, 0, 0, 0]), scaled(pal.p, 0.8, 0, [0, 0, 0, 0]), 0, 0, SHAPE.GLOW, 0, 0);
    add.emit(c.x, c.y, c.z, 0, 0, 0, 0.45, 2, 6);
    startFlash(_v2.set(c.x, c.y + 2, c.z + fz * 4), pal.l, 900, 0.9);
    // radial light streaks (carry the explosion)
    let k = cnt(150);
    add.style(scaled(pal.l, 4.5, 1, [0, 0, 0, 0]), scaled(pal.p, 2.5, 0, [0, 0, 0, 0]), 2.6, 0, SHAPE.SPARK, 0.07, 0);
    for (let i = 0; i < k; i++) {
      randDir(_cv); _cv.z += fz * 0.55; _cv.y = _cv.y * 0.85 + 0.15; _cv.normalize();
      const sp = rr(25, 70);
      add.emit(c.x, c.y, c.z, _cv.x * sp, _cv.y * sp, _cv.z * sp, rr(0.6, 1.2), rr(0.1, 0.2), 0.03);
    }
    // white-hot fast streaks
    k = cnt(40);
    add.style([8, 8, 8, 1], scaled(pal.l, 3, 0, _col1), 3.5, 0, SHAPE.SPARK, 0.05, 0);
    for (let i = 0; i < k; i++) {
      randDir(_cv); _cv.z += fz * 0.5; _cv.normalize();
      const sp = rr(40, 90);
      add.emit(c.x, c.y, c.z, _cv.x * sp, _cv.y * sp, _cv.z * sp, rr(0.3, 0.5), rr(0.08, 0.15), 0.03);
    }
    // embers that hang and fall
    k = cnt(260);
    add.style(scaled(pal.l, 6, 1, [0, 0, 0, 0]), scaled(pal.p, 2, 0, [0, 0, 0, 0]), 1.1, 2.6, SHAPE.GLOW, 0, 0.02);
    for (let i = 0; i < k; i++) {
      randDir(_cv); _cv.z += fz * 0.3; _cv.y = Math.abs(_cv.y) * 0.9 + 0.1; _cv.normalize();
      const sp = rr(4, 26);
      add.emit(c.x, c.y, c.z, _cv.x * sp, _cv.y * sp, _cv.z * sp, rr(1.6, 3.0), rr(0.1, 0.18), 0.04);
    }
    // delayed firework pops around the goal mouth
    const pops = 6;
    for (let b = 0; b < pops; b++) {
      const delay = 0.12 + b * 0.14 + rr(0, 0.08);
      randDir(_cv); _cv.z = fz * rr(0.2, 1); _cv.y = Math.abs(_cv.y) + 0.3; _cv.normalize();
      const r = rr(3, 9);
      const bx = c.x + _cv.x * r, by = Math.max(1, c.y + _cv.y * r * 0.8), bz = c.z + _cv.z * r;
      const hot = b % 2 === 0;
      const p0 = hot ? [6, 6, 6, 1] : scaled(pal.l, 5, 1, [0, 0, 0, 0]);
      add.style(p0, scaled(pal.l, 2, 0, [0, 0, 0, 0]), 0, 0, SHAPE.GLOW, 0, 0);
      add.emit(bx, by, bz, 0, 0, 0, 0.25, 0.4, 2.0, time + delay);
      const n = cnt(30);
      add.style(scaled(pal.l, 5, 1, [0, 0, 0, 0]), scaled(pal.p, 1.5, 0, [0, 0, 0, 0]), 1.6, 3.0, SHAPE.SPARK, 0.03, 0);
      for (let i = 0; i < n; i++) {
        randDir(_v3); const sp = rr(4, 9);
        add.emit(bx, by, bz, _v3.x * sp, _v3.y * sp, _v3.z * sp, rr(0.7, 1.2), rr(0.05, 0.08), 0.02, time + delay);
      }
    }
    // twinkles spread over ~1.5 s
    k = cnt(60);
    add.style([7, 7, 7, 1], scaled(pal.l, 3, 0, _col1), 0, 0, SHAPE.GLINT, 0, 0.15);
    for (let i = 0; i < k; i++) {
      randDir(_cv); const r = rr(2, 11);
      add.emit(c.x + _cv.x * r, Math.max(0.5, c.y + _cv.y * r * 0.7), c.z + _cv.z * r + fz * r * 0.4, 0, 0.5, 0, rr(0.3, 0.5), rr(0.5, 1.1), 0.1, time + rr(0.05, 1.5));
    }
    // light, team-tinted haze (never darker than the arena)
    k = cnt(28);
    const hz = _c.copy(pal.l).lerp(_cw, 0.55);
    const sm0 = [hz.r * 0.9, hz.g * 0.9, hz.b * 0.9, 0.09], sm1 = [hz.r, hz.g, hz.b, 0];
    smoke.style(sm0, sm1, 1.2, -0.5, SHAPE.SMOKE, 0, 0.25);
    for (let i = 0; i < k; i++) {
      randDir(_cv); _cv.z += fz * 0.4; _cv.normalize(); const sp = rr(2, 8);
      smoke.emit(c.x, c.y, c.z, _cv.x * sp, _cv.y * sp * 0.7 + 0.5, _cv.z * sp, rr(2.0, 2.8), rr(1.2, 2.0), rr(4, 6.5), time + rr(0.05, 0.3));
    }
    // shockwaves: one small fast shell, thin faint rings
    shocks.shell(c.x, c.y, c.z, 0.3, 0.5, 6, 0.22, scaled(pal.l, 3, 1, [0, 0, 0, 0]), 3);
    shocks.ring(c.x, c.y, c.z, 0, 0, fz, 0.7, 1, 16, 0.03, 0.9, scaled(pal.l, 4, 1, [0, 0, 0, 0]), 3);
    shocks.ring(c.x, 0.06, c.z, 0, 1, 0, 1.0, 2, 24, 0.03, 0.5, scaled(pal.l, 3, 1, [0, 0, 0, 0]), 3);
  }

  function carBump(e) {
    if (e.speed < 300) return;
    const s = Math.min(1, (e.speed - 300) / 1800);
    const p = S(e.pos, _v);
    const k = cnt(4 + 18 * s);
    add.style(C.hitSpark0, C.hitSpark1, 2.5, 6, SHAPE.SPARK, 0.03, 0);
    for (let i = 0; i < k; i++) { randDir(_cv); const sp = rr(3, 6 + 10 * s); add.emit(p.x, p.y, p.z, _cv.x * sp, _cv.y * sp + 1, _cv.z * sp, rr(0.2, 0.45), 0.03, 0.01); }
    add.style(C.white0, C.white1, 0, 0, SHAPE.GLOW, 0, 0);
    add.emit(p.x, p.y, p.z, 0, 0, 0, 0.1, 0.3 + 0.5 * s, 0.8 + 1.2 * s);
  }

  function respawn(e, view) {
    const car = findCar(view, e.carId);
    if (!car) return;
    const p = S(car.pos, _v);
    const pal = teamPalette(car.team);
    shocks.ring(p.x, Math.max(0.04, p.y - 0.15), p.z, 0, 1, 0, 0.5, 2.2, 0.4, 0.15, 1.2, scaled(pal.l, 3, 1, [0, 0, 0, 0]), 2);
    add.style(scaled(pal.l, 3, 0.8, [0, 0, 0, 0]), scaled(pal.p, 1, 0, [0, 0, 0, 0]), 1, -2, SHAPE.SPARK, 0.03, 0);
    const k = cnt(24);
    for (let i = 0; i < k; i++) {
      const a = rand() * 6.2832;
      add.emit(p.x + Math.cos(a) * 1.1, p.y - 0.1, p.z + Math.sin(a) * 1.1, 0, rr(1, 3), 0, rr(0.4, 0.7), 0.04, 0.02);
    }
  }

  function supersonicStart(e, view) {
    const car = findCar(view, e.carId);
    if (!car || car.isDemoed) return;
    carBasis(car);
    const p = S(car.pos, _v).addScaledVector(_fw, -1.2).addScaledVector(_up, 0.15);
    shocks.ring(p.x, p.y, p.z, _fw.x, _fw.y, _fw.z, 0.3, 0.5, 1.6, 0.1, 0.3, [1.6, 1.7, 1.9], 2);
  }

  // debug-only camera override (?vfxdebug=1): follow a car with a car-local offset (sim units)
  let debugFollow = null;
  function applyDebugFollow(view, cam) {
    const car = findCar(view, debugFollow.id) || view.cars[0];
    if (!car) return;
    const m = car.rot.m, o = debugFollow.off;
    const yawOnly = debugFollow.flat;
    let fx = m[0], fy = m[3], rx = m[1], ry = m[4];
    if (yawOnly) { const l = Math.hypot(fx, fy) || 1; fx /= l; fy /= l; rx = -fy; ry = fx; }
    const px = car.pos.x + fx * o.x + rx * o.y, py = car.pos.y + fy * o.x + ry * o.y, pz = car.pos.z + o.z;
    cam.position.set(px * U, pz * U, py * U);
    cam.lookAt(car.pos.x * U + fx * debugFollow.ahead * U, car.pos.z * U + 0.3, car.pos.y * U + fy * debugFollow.ahead * U);
    if (debugFollow.fov) { cam.fov = debugFollow.fov; cam.updateProjectionMatrix(); }
  }

  function debrisTrail(it, h) {
    if (it.rest) return;
    it.trailAcc += h * 28 * density;
    while (it.trailAcc >= 1) {
      it.trailAcc -= 1;
      if (it.t < 0.9) {
        add.style(C.demoFire0, C.demoFire1, 2, -1, SHAPE.GLOW, 0, 0.05);
        add.emit(it.pos.x, it.pos.y, it.pos.z, rr(-0.4, 0.4), rr(-0.2, 0.6), rr(-0.4, 0.4), rr(0.25, 0.45), 0.18, 0.4);
      }
      smoke.style(C.demoSmoke0, C.demoSmoke1, 1.5, -0.6, SHAPE.SMOKE, 0, 0.15);
      smoke.emit(it.pos.x, it.pos.y, it.pos.z, rr(-0.3, 0.3), rr(0, 0.5), rr(-0.3, 0.3), rr(0.7, 1.3), 0.15, rr(0.5, 0.9));
    }
  }
  const perf = { ms: 0, frames: 0 };

  // ---- public API -----------------------------------------------------------------------
  const api = {
    onEvents(events, view) {
      if (view) lastView = view;
      if (!events || !events.length) return;
      for (const e of events) {
        switch (e.type) {
          case EV.BALL_HIT: ballHit(e, view); break;
          case EV.BALL_BOUNCE: ballBounce(e); break;
          case EV.LAND: land(e, view); break;
          case EV.JUMP: jumpPuff(e, view, false); break;
          case EV.DOUBLE_JUMP: case EV.DODGE: jumpPuff(e, view, true); break;
          case EV.PAD_PICKUP: padPickup(e); break;
          case EV.DEMO: demo(e, view); break;
          case EV.GOAL: goal(e, view); break;
          case EV.CAR_BUMP: carBump(e); break;
          case EV.WALL_SCRAPE: carBump({ pos: e.pos, speed: Math.min(e.speed || 0, 900) }); break;
          case EV.RESPAWN: respawn(e, view); break;
          case EV.SUPERSONIC_START: supersonicStart(e, view); break;
          case EV.REPLAY_START: case EV.REPLAY_END: api.clear(); break;
          default: break;
        }
      }
    },

    update(view, dt, camera) {
      if (!view) return;
      const t0 = performance.now();
      try { api._update(view, dt, camera); } finally { perf.ms = perf.ms * 0.9 + (performance.now() - t0) * 0.1; perf.frames++; }
    },

    _update(view, dt, camera) {
      lastView = view;
      if (debugFollow) applyDebugFollow(view, camera || ctx.camera);
      // time step follows the view (pause -> 0, slow-mo replays -> slower)
      const d = view.time - lastViewTime;
      if (lastViewTime < 0 || !(d >= 0) || d > 0.25) step = Math.min(Math.max(dt || 0, 0), 0.1);
      else step = d;
      lastViewTime = view.time;
      time += step;
      add.time = time; smoke.time = time; shocks.time = time;

      // cars
      for (const st of cars.values()) st.seen = 0;
      for (const cv of view.cars) {
        const st = carState(cv);
        st.seen = 1;
      }
      for (const [id, st] of cars) if (!st.seen) { cars.delete(id); slotsDirty = true; }
      if (slotsDirty) rebuildSlots(view);
      for (let s = 0; s < MAX_CARS; s++) carK[s].set(0, 0, 1, 0);
      let anyBoost = false, anySS = false;

      for (const cv of view.cars) {
        const st = cars.get(cv.id);
        if (!st || st.slot < 0) continue;
        const mat = carMats[st.slot];
        S(cv.pos, _v);
        simRotToQuat(cv.rot, _q);
        mat.compose(_v, _q, _one);
        carBasis(cv);
        const alive = !cv.isDemoed;
        const kRate = Math.min(1, step * 22);
        st.boost += ((alive && cv.isBoosting ? 1 : 0) - st.boost) * kRate;
        st.ss += ((alive && cv.isSupersonic ? 1 : 0) - st.ss) * Math.min(1, step * 6);
        if (!alive) { st.boost = 0; st.ss = 0; }
        carK[st.slot].set(st.boost, st.ss, st.scale, st.ss);
        if (st.boost > 0.01) anyBoost = true;
        if (st.ss > 0.01) anySS = true;
        const carVel = S(cv.vel, _v2);
        if (step > 0) {
          if (alive && cv.isBoosting) emitBoostTrail(cv, st, carVel);
          else st.hasLast = false;
          updateSkids(cv, st, cv.vel);
        }
        // contrails from the rear corners while supersonic
        for (let r = 0; r < 2; r++) {
          _v3.copy(st.rear[r]).applyMatrix4(mat);
          ribbons.feed(st.slot * 2 + r, _v3.x, _v3.y, _v3.z, alive && cv.isSupersonic, time);
        }
      }

      // debris + their fire/smoke trails
      if (step > 0) {
        debris.update(step, ctx.arena.sdf, ctx.arena.normal, debrisTrail);
      }

      // flash light
      if (flash.peak > 0) {
        flash.t += step;
        const f = Math.max(0, 1 - flash.t / flash.life);
        light.color.copy(flash.color);
        light.intensity = flash.peak * f * f;
        if (f <= 0) { flash.peak = 0; light.intensity = 0; }
      }

      const cam = camera || ctx.camera;
      add.update(time); smoke.update(time); flames.update(time); streaks.update(time);
      skids.update(time); shocks.update(time);
      flames.mesh.visible = anyBoost;
      streaks.mesh.visible = anySS;
      ribbons.mesh.visible = ribbons.update(time, cam.position) && ribbonsOn;
    },

    // Make every system renderable (but drawing nothing on screen) so renderer.compileAsync() builds all
    // VFX programs up front. Returns restore(). Usage: const r = vfx.prewarm(); await renderer.compileAsync(scene, camera); r();
    prewarm() {
      const objs = [add.mesh, smoke.mesh, flames.mesh, streaks.mesh, ribbons.mesh, skids.mesh, shocks.rings.mesh, shocks.shells.mesh, debris.mesh];
      const saved = objs.map((o) => [o, o.visible, o.geometry.instanceCount, o.count]);
      for (const o of objs) {
        o.visible = true; // dead particles / zero-boost flames / zero-scale debris all land off screen
        if (o.geometry.isInstancedBufferGeometry && !(o.geometry.instanceCount >= 1)) o.geometry.instanceCount = 1;
        if (o.isInstancedMesh && o.count < 1) o.count = 1;
      }
      return () => {
        for (const [o, vis, ic, cnt0] of saved) {
          o.visible = vis;
          if (o.geometry.isInstancedBufferGeometry) o.geometry.instanceCount = ic;
          if (o.isInstancedMesh) o.count = cnt0;
        }
      };
    },

    setQuality(name) {
      const q = QUALITY[name] || ctx.quality || QUALITY.high;
      density = q.particles;
      skids.setLife(name === 'low' ? 4 : name === 'ultra' ? 10 : 7);
      ribbonsOn = name !== 'low';
    },

    clear() {
      add.clear(); smoke.clear(); skids.clear(); shocks.clear(); ribbons.clear(); debris.clear();
      for (const st of cars.values()) { st.hasLast = false; st.skid[0] = st.skid[1] = false; }
      flash.peak = 0; light.intensity = 0;
    },

    dispose() {
      scene.remove(root);
      add.dispose(); smoke.dispose(); flames.dispose(); streaks.dispose(); ribbons.dispose();
      skids.dispose(); shocks.dispose(); debris.dispose();
      light.dispose && light.dispose();
      if (typeof window !== 'undefined' && window.__vfx === api) delete window.__vfx;
    },
  };
  api.setQuality(ctx.qualityName || 'high');

  // dev hook: ?vfxdebug=1 exposes window.__vfx to trigger effects for screenshots
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('vfxdebug')) {
      window.__vfx = api;
      ctx.renderer.info.autoReset = false; // post.render() resets once per frame -> whole-frame draw call counts
      api.debug = {
        goal(team = 0, x = 0, y = 5300, z = 300) { api.onEvents([{ type: EV.GOAL, team, pos: { x, y, z } }], lastView); },
        demo(victimId = 0) {
          const c = findCar(lastView, victimId) || (lastView && lastView.cars[0]);
          if (!c) return;
          api.onEvents([{ type: EV.DEMO, attackerId: -1, victimId: c.id, pos: c.pos, vel: c.vel }], lastView);
        },
        hit(impulse = 2500) {
          const b = lastView.ball; const c = lastView.cars[0];
          api.onEvents([{ type: EV.BALL_HIT, carId: c.id, impulse, pos: b.pos, ballVel: b.vel }], lastView);
        },
        fire(ev) { api.onEvents([ev], lastView); },
        graphics(o) { Object.assign(ctx.settings.graphics, o); },
        // set a car's sim velocity along its nose (uu/s), e.g. push(0, 2250) to go supersonic
        push(id, speed) {
          const g = window.__game, car = g && g.world && g.world.getCar(id);
          if (!car) return;
          const f = car.body.rot.forward;
          car.body.vel.set(f.x * speed, f.y * speed, f.z * speed);
          car.boost = 100;
        },
        // jump the effect clock forward (to screenshot an effect mid-flight on slow machines)
        advance(sec) {
          const n = Math.ceil(sec * 60);
          for (let i = 0; i < n; i++) {
            time += sec / n;
            debris.update(sec / n, ctx.arena.sdf, ctx.arena.normal, null);
          }
          flash.t += sec;
        },
        follow(id, x, y, z, ahead, fov) { debugFollow = id === null ? null : { id, off: { x, y, z }, ahead: ahead || 0, fov: fov || 0, flat: true }; },
        // override bot controls (spectate scenes): e.g. drive({ boost: true }) or drive({ handbrake: true, steer: 1 })
        drive(over) {
          const g = window.__game;
          if (!g || !g.bots) return;
          for (const b of g.bots.values()) {
            if (!b.__orig) b.__orig = b.tick.bind(b);
            b.tick = (w, m, dt) => Object.assign(b.__orig(w, m, dt), over);
          }
        },
        stats() {
          return {
            time, density, updateMs: perf.ms, frames: perf.frames,
            meshes: root.children.filter((o) => o.isMesh && o.visible).length,
            visible: root.children.filter((o) => o.isMesh && o.visible).map((o) => o.name),
            renderCalls: ctx.renderer.info.render.calls, triangles: ctx.renderer.info.render.triangles,
            fps: window.__game && window.__game.fps,
            cars: lastView ? lastView.cars.map((c) => [c.id, Math.round(c.pos.x), Math.round(c.pos.y), Math.round(c.pos.z), c.isBoosting, c.isSupersonic]) : [],
            ball: lastView ? [Math.round(lastView.ball.pos.x), Math.round(lastView.ball.pos.y), Math.round(lastView.ball.pos.z)] : null,
          };
        },
      };
    }
  } catch (e) { /* no location (tests) */ }

  return api;
}
