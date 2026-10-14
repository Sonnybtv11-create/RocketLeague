// Binary world snapshots for LAN play (lead-owned). Encodes a captureFrame()-shaped frame
// (or an interpolated replay view) into a Float32Array; decodes back into the same shape so
// the renderers and interpolateFrames() work unchanged on the joining computer.
import { Vec3, RotMat } from '../sim/math.js';
import { CAR_CONFIGS, wheelLayout } from '../sim/carconfig.js';

const HEADER = 12;      // kind, tick, time, nCars, nPads, hintMode, hintTarget, goalTeam, goalPos xyz, reserved
const BALL = 18;        // pos3 vel3 angVel3 rot9
const CAR = 40;         // id, pos3 vel3 angVel3 rot9, boost, handbrake, fwdSpeed, steer, airTime, demoTimer, nWheels, 4×(susp, spin), flags, 5 controls
const HINTS = ['follow', 'wide', 'ball', 'goal'];

const FLAGS = ['isBoosting', 'isSupersonic', 'isDemoed', 'isOnGround', 'hasJumped', 'hasFlipped', 'isFlipping', 'isJumping'];

function putV(a, o, v) { a[o] = v.x; a[o + 1] = v.y; a[o + 2] = v.z; return o + 3; }
function putR(a, o, r) { for (let i = 0; i < 9; i++) a[o + i] = r.m[i]; return o + 9; }
function getV(a, o) { return new Vec3(a[o], a[o + 1], a[o + 2]); }
function getR(a, o) { return new RotMat(a.subarray(o, o + 9)); }

// frame: captureFrame() or replay view; hint: replay cameraHint or null
export function encodeFrame(frame, hint = null) {
  const nCars = frame.cars.length, nPads = frame.pads.length;
  const a = new Float32Array(HEADER + BALL + nPads + nCars * CAR);
  a[0] = hint ? 1 : 0;
  a[1] = frame.tick; a[2] = frame.time || 0; a[3] = nCars; a[4] = nPads;
  if (hint) {
    a[5] = Math.max(0, HINTS.indexOf(hint.mode)); a[6] = hint.targetCarId ?? -1; a[7] = hint.goalTeam ?? -1;
    if (hint.goalPos) putV(a, 8, hint.goalPos);
  }
  let o = HEADER;
  const b = frame.ball;
  o = putV(a, o, b.pos); o = putV(a, o, b.vel); o = putV(a, o, b.angVel); o = putR(a, o, b.rot);
  for (const p of frame.pads) a[o++] = p.cooldown;
  for (const c of frame.cars) {
    a[o++] = c.id;
    o = putV(a, o, c.pos); o = putV(a, o, c.vel); o = putV(a, o, c.angVel); o = putR(a, o, c.rot);
    a[o++] = c.boost; a[o++] = c.handbrakeVal; a[o++] = c.forwardSpeed; a[o++] = c.steer;
    a[o++] = c.airTimeSinceJump; a[o++] = c.demoRespawnTimer; a[o++] = c.numWheelsInContact;
    let flags = 0;
    FLAGS.forEach((f, i) => { if (c[f]) flags |= 1 << i; });
    c.wheels.forEach((w, i) => { a[o++] = w.suspLen; a[o++] = w.spin; if (w.contact) flags |= 1 << (8 + i); });
    const k = c.controls || {};
    if (k.jump) flags |= 1 << 12; if (k.boost) flags |= 1 << 13; if (k.handbrake) flags |= 1 << 14;
    a[o++] = flags;
    a[o++] = k.throttle || 0; a[o++] = k.steer || 0; a[o++] = k.pitch || 0; a[o++] = k.yaw || 0; a[o++] = k.roll || 0;
  }
  return a.buffer;
}

// roster: [{id, team, name, isBot, bodyId, hitbox, accent}], padsStatic: world.pads
export function decodeFrame(buf, roster, padsStatic) {
  const a = new Float32Array(buf);
  const kind = a[0], nCars = a[3], nPads = a[4];
  const hint = kind === 1 ? {
    mode: HINTS[a[5]] || 'follow', targetCarId: a[6] >= 0 ? a[6] : undefined,
    goalTeam: a[7] >= 0 ? a[7] : undefined, goalPos: a[7] >= 0 ? getV(a, 8) : undefined,
  } : null;
  let o = HEADER;
  const ball = { pos: getV(a, o), vel: getV(a, o + 3), angVel: getV(a, o + 6), rot: getR(a, o + 9) };
  o += BALL;
  const pads = [];
  for (let i = 0; i < nPads; i++) {
    const s = padsStatic[i], cd = a[o++];
    pads.push({ index: s.index, pos: s.pos, isBig: s.isBig, isActive: cd === 0, cooldown: cd });
  }
  const cars = [];
  for (let i = 0; i < nCars; i++) {
    const id = a[o];
    const r = roster.find((x) => x.id === id) || { id, team: 0, name: '?', isBot: false, bodyId: 'vector', hitbox: 'OCTANE', accent: '#e8e8e8' };
    const layout = r._wheels || (r._wheels = wheelLayout(CAR_CONFIGS[r.hitbox] || CAR_CONFIGS.OCTANE));
    const c = {
      id, team: r.team, name: r.name, isBot: r.isBot, bodyId: r.bodyId, hitbox: r.hitbox, accent: r.accent,
      pos: getV(a, o + 1), vel: getV(a, o + 4), angVel: getV(a, o + 7), rot: getR(a, o + 10),
    };
    o += 19;
    c.boost = a[o++]; c.handbrakeVal = a[o++]; c.forwardSpeed = a[o++]; c.steer = a[o++];
    c.airTimeSinceJump = a[o++]; c.demoRespawnTimer = a[o++]; c.numWheelsInContact = a[o++];
    const ws = [];
    for (let w = 0; w < 4; w++) ws.push({ susp: a[o++], spin: a[o++] });
    const flags = a[o++];
    FLAGS.forEach((f, k) => { c[f] = !!(flags & (1 << k)); });
    c.wheels = layout.map((d, w) => ({
      offset: d.offset, radius: d.radius, restLen: d.restLen, front: d.front, left: d.left,
      suspLen: ws[w].susp, spin: ws[w].spin, contact: !!(flags & (1 << (8 + w))),
    }));
    c.controls = {
      throttle: a[o++], steer: a[o++], pitch: a[o++], yaw: a[o++], roll: a[o++],
      jump: !!(flags & (1 << 12)), boost: !!(flags & (1 << 13)), handbrake: !!(flags & (1 << 14)), ballCam: false,
    };
    cars.push(c);
  }
  return { frame: { tick: a[1], time: a[2], ball, cars, pads }, hint };
}

// Controls <-> compact array (client -> host, one entry per 120 Hz tick)
export function packControls(c) {
  return [round3(c.throttle), round3(c.steer), round3(c.pitch), round3(c.yaw), round3(c.roll),
    (c.jump ? 1 : 0) | (c.boost ? 2 : 0) | (c.handbrake ? 4 : 0)];
}
export function unpackControls(p, out) {
  out.throttle = p[0]; out.steer = p[1]; out.pitch = p[2]; out.yaw = p[3]; out.roll = p[4];
  out.jump = !!(p[5] & 1); out.boost = !!(p[5] & 2); out.handbrake = !!(p[5] & 4);
  return out;
}
const round3 = (v) => Math.round((v || 0) * 1000) / 1000;
