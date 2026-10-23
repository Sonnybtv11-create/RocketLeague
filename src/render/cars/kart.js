// TURBO PITCH — the ATK kart skin (Octane hitbox), from tools/blender/models/kart.blend
// (tools/blender/import_kart.py -> kartMesh.js) and its motion rig.
//
// Looks: every surface samples one baked colour atlas. Material classes from the importer (satin,
// matte, gloss, metal, lamp, brake) set how it is shaded. Team colour: the model is blue-accented;
// on the orange team every blue surface (stripes, rim lips, bumpers, seats, piping, wires) is swapped
// to the team colour by hue, keeping its brightness. White, yellow, gold, red and greens stay.
//
// Motion (createRig): parts hang, bob and rattle with the car's real motion. Each loose part is a
// small mass on a rod from its pivot, simulated in world space: gravity, the pull back to its rest
// pose (stiffness), damping and air drag. Car acceleration, braking, cornering, flips and landings
// all come out of that on their own.
//   * charms (tomato, burger): free pendulums on their strings; they stream back at speed, swing
//     through corners and twist in the wind.
//   * flag: the whip pole flexes; the cloth turns into the wind and flutters harder with speed.
//   * llama: a stiff bobble-head spring.
//   * cargo (cooler, axe, propane tank): tilt and jiggle, hop on bumps and landings. The cooler lid
//     is hinged: it bangs open and shut and lifts in fast wind.
//   * pickaxe sign: swings on its rack hinge. Roof light bar: rocks on its yoke.
//   * steering wheel follows the steering input; GO / STOP pedals press with throttle / braking;
//     coil springs stretch and compress with the suspension; tail lights brighten when braking.
import * as THREE from 'three';
import { TEAM_COLORS } from '../../contracts.js';
import { registerEnvUser } from './materials.js';
import { KART_MESH_META, KART_MESH_B64, KART_WHEEL_META, KART_WHEEL_B64, KART_INFO, KART_ATLAS } from './kartMesh.js';

const I = KART_INFO;
const S = 0.42;                    // Blender metre -> game metre (42 uu per model metre)

// ------------------------------------------------------------------ materials
let atlas = null;
function getAtlas() {
  if (atlas) return atlas;
  atlas = new THREE.TextureLoader().load(KART_ATLAS);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 8;
  return atlas;
}
const CLASS = {
  satin: { roughness: 0.48, metalness: 0.02 },
  matte: { roughness: 0.82, metalness: 0.0 },
  gloss: { roughness: 0.26, metalness: 0.0 },
  metal: { roughness: 0.32, metalness: 0.85 },
  lamp: { roughness: 0.2, metalness: 0.0, emissive: 0xffffff, emissiveIntensity: 1.3 },
  brake: { roughness: 0.3, metalness: 0.0, emissive: 0xffffff, emissiveIntensity: 1.0 },
};
const TINT = /* glsl */`
{
  // swap blue surfaces to the team colour (keeps their brightness); w = how blue the texel is
  vec3 c = diffuseColor.rgb;
  float w = clamp((c.b - max(c.r, c.g)) / max(c.b, 1e-3) * 2.0, 0.0, 1.0);
  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 t = uTeamTint * (L / max(dot(uTeamTint, vec3(0.2126, 0.7152, 0.0722)), 1e-3));
  diffuseColor.rgb = mix(c, min(t, vec3(1.0)), w * uTintAmt);
}`;
// extra = { vertex: glsl inserted after begin_vertex, uniforms, key }
export function kartMaterial(cls, team, extra = null) {
  const p = CLASS[cls] || CLASS.satin;
  const map = getAtlas();
  const m = new THREE.MeshStandardMaterial({ map, ...p, ...(p.emissive ? { emissiveMap: map } : null), name: `kart.${cls}.${team}` });
  const tint = team === 1 ? new THREE.Color(TEAM_COLORS[1].primary) : new THREE.Color(1, 1, 1);
  const uniforms = { uTeamTint: { value: tint }, uTintAmt: { value: team === 1 ? 1 : 0 }, ...(extra && extra.uniforms) };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uTeamTint;\nuniform float uTintAmt;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + TINT);
    if (extra && extra.vertex) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + (extra.vertexPars || ''))
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + extra.vertex);
    }
  };
  m.customProgramCacheKey = () => 'kart-' + (extra ? extra.key : 'std');
  m.userData.uniforms = uniforms;
  registerEnvUser(m);
  return m;
}

// ------------------------------------------------------------------ skin spec (see skins.js)
const partsModel = {};
for (const p of I.parts) partsModel[p.id] = { ...p, pivot: new THREE.Vector3(p.pivot[0] / 100, p.pivot[2] / 100, -p.pivot[1] / 100) };

export const KART_SKIN = {
  hitbox: 'OCTANE',
  tyre: { wF: I.wheelW[0], wB: I.wheelW[1], extraF: I.trackY - 25.9, extraB: I.trackY - 29.5, spokes: 0, modelled: true, x: I.axles, r: I.wheelR },
  nozzles: I.nozzles,
  build() {
    const perTeam = new Map();
    const forTeam = (team) => {
      const t = team === 1 ? 1 : 0;
      if (!perTeam.has(t)) {
        const mats = {};
        for (const cls of Object.keys(CLASS)) mats[cls] = kartMaterial(cls, t);
        perTeam.set(t, {
          body: mats,
          wheel: { tyre: kartMaterial('matte', t), rim: mats.metal, hub: mats.satin, lip: mats.satin },
        });
      }
      return perTeam.get(t);
    };
    return {
      mesh: [KART_MESH_META, KART_MESH_B64],
      wheel: [KART_WHEEL_META, KART_WHEEL_B64],
      materialsFor: (team) => forTeam(team).body,
      wheelMaterialsFor: (team) => forTeam(team).wheel,
      parts: partsModel,
      createRig: (groups, opts) => createRig(groups, opts),
    };
  },
};

// ------------------------------------------------------------------ rig
const G = 6.5;                     // game gravity, m/s² (650 uu/s²)
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion();
const _rot = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

// rod-on-a-pivot element: a mass at L along `rest` (model axes) from the part's pivot. Simulated
// relative to the pivot, in world axes: the pivot's own acceleration (the car speeding up, braking,
// turning, landing) acts on it as a fictitious force, plus gravity, air drag on its true velocity,
// a spring and damper back to the rest pose, and road shake. begin() reads this frame's car pose;
// step() runs one substep, with the rest direction turning smoothly through the frame.
const _acc = new THREE.Vector3(), _rd = new THREE.Vector3(), _f = new THREE.Vector3();
class Swinger {
  constructor(group, o) {
    this.g = group; this.o = o;
    this.rest = o.rest.clone().normalize();
    this.q = new THREE.Vector3(); this.qv = new THREE.Vector3();          // mass offset from the pivot, its velocity
    this.pivot = new THREE.Vector3(); this.pv = new THREE.Vector3(); this.pa = new THREE.Vector3();
    this.restW = new THREE.Vector3(); this.restW0 = new THREE.Vector3(); this.restV = new THREE.Vector3();
    this.ok = false; this.twist = 0; this.twistV = 0;
  }
  begin(car, dt, teleport) {
    const o = this.o;
    const p = _f.copy(this.g.position).applyMatrix4(car.m);
    this.restW0.copy(this.restW);
    this.restW.copy(this.rest).transformDirection(car.m);
    if (!this.ok || teleport) {
      this.pivot.copy(p); this.pv.copy(car.vel); this.pa.set(0, 0, 0); this.restW0.copy(this.restW);
      this.q.copy(this.restW).multiplyScalar(o.L); this.qv.set(0, 0, 0); this.ok = true;
    } else {
      const pv = _acc.copy(p).sub(this.pivot).divideScalar(dt);
      this.pa.copy(pv).sub(this.pv).divideScalar(dt).clampLength(0, 400);
      this.pv.copy(pv); this.pivot.copy(p);
    }
    this.restV.copy(this.restW).sub(this.restW0).multiplyScalar(o.L / dt);   // how fast the rest tip turns
  }
  step(car, a, dt, env) {
    const o = this.o, q = this.q, qv = this.qv;
    const tip = _rd.copy(this.restW0).lerp(this.restW, a).normalize().multiplyScalar(o.L);
    const f = _f.copy(tip).sub(q).multiplyScalar(o.k)
      .addScaledVector(_acc.copy(this.restV).sub(qv), o.c)
      .addScaledVector(_acc.copy(this.pv).add(qv), -o.drag)
      .sub(this.pa)
      .addScaledVector(env.shake, o.shake);
    f.y += -G * o.gs + (o.lift || 0) * env.speed2;
    qv.addScaledVector(f, dt);
    q.addScaledVector(qv, dt);
    // keep the rod length, drop the radial velocity
    q.normalize(); qv.addScaledVector(q, -qv.dot(q)); q.multiplyScalar(o.L);
    this.pose(car);
  }
  // rod direction -> part rotation (model axes) within the angle limits (hinges: projected onto the
  // hinge plane); the mass is put back where the limited rotation puts it
  pose(car) {
    const o = this.o;
    const dir = _rd.copy(this.q).normalize().transformDirection(car.inv);
    let angle;
    if (o.axis) {
      const ax2 = o.axis;
      dir.addScaledVector(ax2, -dir.dot(ax2)).normalize();
      angle = Math.atan2(_f.copy(this.rest).cross(dir).dot(ax2), this.rest.dot(dir));
      const lo = o.min ?? -o.max, hi = o.max;
      if (angle < lo || angle > hi) { angle = Math.min(hi, Math.max(lo, angle)); this.bounce(); }
      this.g.quaternion.setFromAxisAngle(ax2, angle);
    } else {
      angle = Math.acos(Math.min(1, Math.max(-1, this.rest.dot(dir))));
      _q.setFromUnitVectors(this.rest, dir);
      if (angle > o.max) { _q.slerp(_q0, 1 - o.max / angle); this.bounce(); }
      this.g.quaternion.copy(_q);
    }
    this.q.copy(this.rest).applyQuaternion(this.g.quaternion).transformDirection(car.m).multiplyScalar(o.L);
  }
  // hit a stop: lose most of the swing (velocity relative to the rest pose)
  bounce() { this.qv.sub(this.restV).multiplyScalar(this.o.bounce ?? 0.3).add(this.restV); }
  // twist about the rod (charms spin in the wind); applied once per frame after the substeps
  spin(dt, env) {
    const o = this.o;
    if (!o.twist) return;
    this.twistV += (-30 * this.twist - 1.2 * this.twistV + env.gust * o.twist) * dt;
    this.twist += this.twistV * dt;
    this.g.quaternion.multiply(_q.setFromAxisAngle(this.rest, this.twist));
  }
}
const _q0 = new THREE.Quaternion();

// cargo hop: an offset along the car's up axis, resting on the deck (h >= 0)
class Hopper {
  constructor(group, o) { this.g = group; this.o = o; this.base = group.position.clone(); this.h = 0; this.v = 0; }
  step(dt, env) {
    // felt gravity along the car's up axis (negative = pressed onto the deck)
    this.v += (env.gUp - 40 * this.h * this.o.spring) * dt;
    this.v += env.hop * this.o.hop;
    this.v *= Math.exp(-dt * 2);
    this.h += this.v * dt;
    if (this.h < 0) { this.h = 0; this.v = this.v < -0.05 ? -this.v * 0.25 : 0; }
    if (this.h > this.o.max) { this.h = this.o.max; this.v = Math.min(this.v, 0); }
    this.g.position.copy(this.base).addScaledVector(UP, this.h);
  }
}

function createRig(groups, { team, cfg, meshes }) {
  const sw = [], hops = [];
  // stiff: car acceleration (m/s²) that tips the part 1 rad; zeta: damping ratio; drag: air drag (1/s);
  // gs: gravity scale; shake: how much road rumble / engine buzz reaches it; max: angle limit (rad)
  const add = (id, o) => {
    if (!groups[id]) return;
    if (o.stiff != null) o.k = o.stiff / o.L;
    if (o.zeta != null) o.c = 2 * o.zeta * Math.sqrt(o.k);
    sw.push(new Swinger(groups[id], o));
  };
  const hop = (id, o) => { if (groups[id]) hops.push(new Hopper(groups[id], o)); };
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
  // lengths: Blender metres -> game metres
  add('charm_tomato', { rest: v3(0, -1, 0), L: 0.42 * S, k: 0, c: 0.3, drag: 0.6, gs: 1, max: 1.7, shake: 0.6, twist: 18 });
  add('charm_burger', { rest: v3(0, -1, 0), L: 0.43 * S, k: 0, c: 0.3, drag: 0.5, gs: 1, max: 1.7, shake: 0.6, twist: -14 });
  add('flag', { rest: v3(0, 2.6, 0.037), L: 2.6 * S, stiff: 130, zeta: 0.15, drag: 0.5, gs: 0.15, max: 0.32, shake: 0.6 });
  add('llama', { rest: v3(0, 1, 0), L: 0.1 * S, stiff: 45, zeta: 0.1, drag: 0.1, gs: 0.3, max: 0.6, shake: 1.6 });
  add('cooler', { rest: v3(0, 1, 0), L: 0.2 * S, stiff: 260, zeta: 0.45, drag: 0, gs: 0.1, max: 0.07, shake: 1.5 });
  add('cooler_lid', { rest: v3(1, 0, 0), L: 0.18 * S, axis: v3(0, 0, 1), min: 0, max: 0.75, k: 0, c: 0.6, drag: 0.2, gs: 1, shake: 2.5, bounce: 0.25, lift: 0.0045 });
  add('propane', { rest: v3(0, 1, 0), L: 0.15 * S, axis: v3(0, 0, 1), max: 0.12, stiff: 170, zeta: 0.35, drag: 0, gs: 0.1, shake: 1.5 });
  add('axe', { rest: v3(-1, 0.15, 0), L: 0.46 * S, stiff: 130, zeta: 0.3, drag: 0.05, gs: 0.3, max: 0.16, shake: 1.5 });
  add('sign', { rest: v3(0, -1, 0), L: 0.2 * S, axis: v3(1, 0, 0), max: 0.5, stiff: 10, zeta: 0.12, drag: 0.1, gs: 1, shake: 1.2 });
  add('lightbar', { rest: v3(0, 1, 0), L: 0.1 * S, axis: v3(0, 0, 1), max: 0.16, stiff: 220, zeta: 0.3, drag: 0.05, gs: 0.15, shake: 1 });
  hop('cooler', { spring: 0, hop: 1, max: 0.05 });
  hop('axe', { spring: 3, hop: 0.6, max: 0.025 });
  hop('propane', { spring: 6, hop: 0.4, max: 0.015 });

  // the cloth rides on the pole: re-parent it (same pivot)
  const pole = groups.flag, cloth = groups.flag_cloth;
  let flagU = null;
  if (pole && cloth) {
    pole.add(cloth); cloth.position.set(0, 0, 0);
    // flutter: waves run from the pole to the tip, growing with distance and speed
    const len = Math.abs(I.flag.xFar) / 100;
    flagU = { uTime: { value: 0 }, uAmp: { value: 0.01 }, uFreq: { value: 6 }, uLen: { value: len } };
    const mat = kartMaterial('satin', team, {
      key: 'flag', uniforms: flagU,
      vertexPars: 'uniform float uTime; uniform float uAmp; uniform float uFreq; uniform float uLen;',
      vertex: `{
        float d = clamp(-position.x / uLen, 0.0, 1.0);
        float ph = d * 7.0 - uTime * uFreq + position.y * 9.0;
        transformed.z += uAmp * pow(d, 1.3) * (sin(ph) + 0.35 * sin(ph * 2.3 + 1.7));
        transformed.y += uAmp * 0.25 * d * sin(ph * 0.7 + 0.4);
      }`,
    });
    cloth.traverse((m) => { if (m.isMesh) m.material = mat; });
  }
  // tail lights: own material per car so they can brighten
  const brakeMeshes = [];
  for (const [slot, m] of Object.entries(meshes)) {
    if (!slot.endsWith('.brake')) continue;
    const src = m.material;
    m.material = src.clone();
    m.material.onBeforeCompile = src.onBeforeCompile; m.material.customProgramCacheKey = src.customProgramCacheKey;
    brakeMeshes.push(m);
  }

  const steerQ = groups.steering ? groups.steering.quaternion : null;
  const steerAxis = v3(-0.7208, 0.6931, 0).normalize();      // column axis (model)
  const springs = ['FR', 'FL', 'RR', 'RL'].map((c) => groups['spring_' + c] || null);   // view wheel order
  const restSusp = [cfg.frontWheels, cfg.frontWheels, cfg.backWheels, cfg.backWheels].map((w) => w.suspRest - 14);
  const SPRING_LEN = 0.38 * S;

  const car = { m: new THREE.Matrix4(), inv: new THREE.Matrix4(), vel: new THREE.Vector3() };
  const env = { shake: new THREE.Vector3(), gust: 0, speed2: 0, gUp: -G, hop: 0, teleport: false };
  const prevPos = new THREE.Vector3(), prevVel = new THREE.Vector3();
  let havePrev = false, steerS = 0, goS = 0, stopS = 0, brakeS = 0, t = Math.random() * 100, wheelsPrev = 4, clothYaw = 0;
  return {
    update(cv, dt) {
      if (!dt || dt <= 0) return;
      dt = Math.min(dt, 0.25);         // the true frame time: velocities come from how far the car moved
      t += dt;
      // car transform (model -> world, metres): columns fwd / up / right
      const f = cv.forward || cv.rot.forward, u = cv.up || cv.rot.up, r = cv.right || cv.rot.right;
      car.m.set(f.x, u.x, r.x, cv.pos.x / 100, f.z, u.z, r.z, cv.pos.z / 100, f.y, u.y, r.y, cv.pos.y / 100, 0, 0, 0, 1);
      car.inv.copy(car.m).invert();
      const pos = _v.set(cv.pos.x / 100, cv.pos.z / 100, cv.pos.y / 100);
      env.teleport = !havePrev || pos.distanceTo(prevPos) > 4;
      const vel = car.vel.set(cv.vel.x / 100, cv.vel.z / 100, cv.vel.y / 100);
      const acc = env.teleport ? new THREE.Vector3() : vel.clone().sub(prevVel).divideScalar(dt);
      prevPos.copy(pos); prevVel.copy(vel); havePrev = true;
      const upW = new THREE.Vector3(u.x, u.z, u.y);
      const speed = vel.length();
      env.speed2 = speed * speed;
      // felt gravity along the car's up axis: (g - a) . up
      env.gUp = (-G - acc.y) * upW.y - acc.x * upW.x - acc.z * upW.z;
      // road rumble while driving on the ground, engine buzz at idle
      const onGround = (cv.numWheelsInContact || 0) >= 3;
      const rumble = onGround ? Math.min(1, speed / 14) : 0;
      const buzz = 0.25 + 0.35 * Math.abs((cv.controls && cv.controls.throttle) || 0);
      env.shake.set((Math.random() - 0.5), (Math.random() - 0.5) * 1.6, (Math.random() - 0.5)).multiplyScalar(3 * rumble + 0.6 * buzz).applyMatrix4(_rot.extractRotation(car.m));
      env.gust = (Math.sin(t * 7.3) + Math.sin(t * 13.1 + 1) * 0.5 + (Math.random() - 0.5)) * Math.min(1, speed / 10);
      // landing: cargo bounces
      const wheels = cv.numWheelsInContact || 0;
      env.hop = 0;
      if (wheels >= 3 && wheelsPrev < 2) env.hop = Math.min(1.6, Math.max(0, -acc.dot(upW) / -60));
      if (onGround && Math.random() < dt * 3 * rumble) env.hop += 0.15 + Math.random() * 0.25;
      wheelsPrev = wheels;
      // integrate in substeps (stiff springs)
      const n = Math.min(60, Math.max(1, Math.ceil(dt * 240))), h = dt / n;
      env.dt = dt;
      for (const s of sw) s.begin(car, dt, env.teleport);
      for (let i = 0; i < n; i++) {
        for (const s of sw) s.step(car, (i + 1) / n, h, env);
        for (const s of hops) s.step(h, env);
        env.hop = 0;
      }
      for (const s of sw) s.spin(dt, env);
      // flag cloth: turn into the wind, flutter with speed
      if (cloth && flagU) {
        const wind = vel.clone().negate().transformDirection(car.inv).applyQuaternion(pole.quaternion.clone().invert());
        const ws = Math.hypot(wind.x, wind.z);
        const want = ws > 0.8 ? Math.atan2(wind.z, -wind.x) : 0;
        let dYaw = want - clothYaw; dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
        clothYaw += dYaw * Math.min(1, dt * (1 + ws * 0.4));
        cloth.quaternion.setFromAxisAngle(UP, clothYaw + Math.sin(t * 1.3) * 0.08);
        flagU.uTime.value = t;
        flagU.uAmp.value = 0.006 + Math.min(0.03, speed * 0.0012);
        flagU.uFreq.value = 5 + Math.min(18, speed * 0.9);
      }
      // steering wheel, pedals
      const c = cv.controls || {};
      steerS += ((c.steer || 0) - steerS) * Math.min(1, dt * 14);
      if (steerQ) steerQ.setFromAxisAngle(steerAxis, -steerS * 2.2);
      const fwdSpeed = cv.forwardSpeed || 0;
      const braking = ((c.throttle || 0) < -0.1 && fwdSpeed > 50) || ((c.throttle || 0) > 0.1 && fwdSpeed < -50) || (cv.handbrakeVal || 0) > 0.2;
      goS += ((Math.max(0, c.throttle || 0) * (braking ? 0 : 1)) - goS) * Math.min(1, dt * 16);
      stopS += ((braking ? 1 : 0) - stopS) * Math.min(1, dt * 16);
      if (groups.pedal_go) groups.pedal_go.quaternion.setFromAxisAngle(AXZ, goS * 0.38);
      if (groups.pedal_stop) groups.pedal_stop.quaternion.setFromAxisAngle(AXZ, stopS * 0.38);
      brakeS += ((braking ? 1 : 0) - brakeS) * Math.min(1, dt * 12);
      for (const m of brakeMeshes) m.material.emissiveIntensity = 1 + brakeS * 3.5;
      // springs follow the suspension
      const ws2 = cv.wheels;
      if (ws2 && ws2.length === 4) for (let i = 0; i < 4; i++) {
        const g = springs[i]; if (!g) continue;
        const d = (ws2[i].suspLen - restSusp[i]) / 100;
        g.scale.y = Math.max(0.45, Math.min(1.6, (SPRING_LEN + d) / SPRING_LEN));
      }
    },
    dispose() { for (const m of brakeMeshes) m.material.dispose(); },
  };
}
const AXZ = new THREE.Vector3(0, 0, 1);
