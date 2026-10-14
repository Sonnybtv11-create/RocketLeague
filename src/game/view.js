// Builds the interpolated "view" object every renderer/audio/UI module reads.
// Live play: interpolate between the previous and current tick snapshots.
// Replays produce the same structure from the replay buffer.
//
// VIEW SCHEMA (all positions in sim units, Z-up; rot is a RotMat (columns fwd/right/up)):
// view = {
//   time,                // seconds of sim time
//   tick,
//   isReplay,            // true when rendering a replay
//   ball: { pos, vel, angVel, rot },
//   cars: [ CarView ],
//   pads: [ { index, pos, isBig, isActive, cooldown } ],
//   match: MatchView (see game/match.js) or null
// }
// CarView = {
//   id, team, name, isBot, bodyId, hitbox, accent,
//   pos, vel, angVel, rot, forward, right, up,
//   boost, isBoosting, isSupersonic, isDemoed, isOnGround, numWheelsInContact,
//   handbrakeVal, forwardSpeed, steer (wheel steer angle, rad),
//   controls (throttle, steer, pitch, yaw, roll, jump, boost, handbrake),
//   wheels: [ { offset{x,y,z} (local hard point), radius, restLen, suspLen, spin, contact, front, left } x4 ]
//            order: 0 FR, 1 FL, 2 BR, 3 BL. Wheel centre (local) = offset - up*suspLen.
//   hasJumped, hasFlipped, isFlipping, airTimeSinceJump, isJumping,
// }

import { Vec3, RotMat } from '../sim/math.js';

function lerpV(a, b, t) { return new Vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }

// Rotation interpolation via quaternions
function matToQuat(m) {
  const a = m.m; const tr = a[0] + a[4] + a[8];
  let w, x, y, z;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (a[7] - a[5]) / s; y = (a[2] - a[6]) / s; z = (a[3] - a[1]) / s; }
  else if (a[0] > a[4] && a[0] > a[8]) { const s = Math.sqrt(1 + a[0] - a[4] - a[8]) * 2; w = (a[7] - a[5]) / s; x = 0.25 * s; y = (a[1] + a[3]) / s; z = (a[2] + a[6]) / s; }
  else if (a[4] > a[8]) { const s = Math.sqrt(1 + a[4] - a[0] - a[8]) * 2; w = (a[2] - a[6]) / s; x = (a[1] + a[3]) / s; y = 0.25 * s; z = (a[5] + a[7]) / s; }
  else { const s = Math.sqrt(1 + a[8] - a[0] - a[4]) * 2; w = (a[3] - a[1]) / s; x = (a[2] + a[6]) / s; y = (a[5] + a[7]) / s; z = 0.25 * s; }
  return [x, y, z, w];
}
function quatToMat(q) {
  const [x, y, z, w] = q;
  return new RotMat([
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ]);
}
export function slerpRot(ma, mb, t) {
  const a = matToQuat(ma), b = matToQuat(mb);
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b[0] = -b[0]; b[1] = -b[1]; b[2] = -b[2]; b[3] = -b[3]; d = -d; }
  let q;
  if (d > 0.9995) q = a.map((v, i) => v + (b[i] - v) * t);
  else {
    const th = Math.acos(d), s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    q = a.map((v, i) => v * wa + b[i] * wb);
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return quatToMat(q.map((v) => v / l));
}

// Snapshot of everything the view needs from one tick (also used by replay recording)
export function captureFrame(world, match) {
  return {
    tick: world.tick,
    time: world.time,
    ball: {
      pos: world.ball.body.pos.clone(), vel: world.ball.body.vel.clone(),
      angVel: world.ball.body.angVel.clone(), rot: world.ball.body.rot.clone(),
    },
    cars: world.cars.map((c) => ({
      id: c.id, team: c.team, name: c.name, isBot: c.isBot, bodyId: c.bodyId, hitbox: c.hitbox, accent: c.accent,
      pos: c.body.pos.clone(), vel: c.body.vel.clone(), angVel: c.body.angVel.clone(), rot: c.body.rot.clone(),
      boost: c.boost, isBoosting: c.isBoosting, isSupersonic: c.isSupersonic, isDemoed: c.isDemoed,
      isOnGround: c.isOnGround, numWheelsInContact: c.numWheelsInContact, handbrakeVal: c.handbrakeVal,
      forwardSpeed: c.forwardSpeed, steer: c.wheels[0].steerAngle,
      controls: { ...c.controls },
      hasJumped: c.hasJumped, hasFlipped: c.hasFlipped, isFlipping: c.isFlipping, isJumping: c.isJumping,
      airTimeSinceJump: c.airTimeSinceJump, demoRespawnTimer: c.demoRespawnTimer,
      wheels: c.wheels.map((w) => ({
        offset: w.def.offset, radius: w.def.radius, restLen: w.def.restLen, front: w.def.front, left: w.def.left,
        suspLen: w.suspLen, spin: w.spin, contact: w.isInContact,
      })),
    })),
    pads: world.pads.map((p) => ({ index: p.index, pos: p.pos, isBig: p.isBig, isActive: p.isActive, cooldown: p.cooldown })),
  };
}

// Interpolate two captured frames (a = previous tick, b = current tick)
export function interpolateFrames(a, b, t) {
  if (!a) a = b;
  const view = {
    tick: b.tick, time: a.time + (b.time - a.time) * t, isReplay: false,
    ball: {
      pos: lerpV(a.ball.pos, b.ball.pos, t), vel: lerpV(a.ball.vel, b.ball.vel, t),
      angVel: b.ball.angVel, rot: slerpRot(a.ball.rot, b.ball.rot, t),
    },
    cars: [],
    pads: b.pads,
    match: null,
  };
  for (const cb of b.cars) {
    const ca = a.cars.find((c) => c.id === cb.id) || cb;
    // don't interpolate across teleports (respawn / kickoff reset)
    const teleport = ca.pos.dist(cb.pos) > 400 || ca.isDemoed !== cb.isDemoed;
    const tt = teleport ? 1 : t;
    const rot = slerpRot(ca.rot, cb.rot, tt);
    view.cars.push({
      ...cb,
      pos: lerpV(ca.pos, cb.pos, tt), vel: lerpV(ca.vel, cb.vel, tt), rot,
      forward: rot.forward, right: rot.right, up: rot.up,
      boost: ca.boost + (cb.boost - ca.boost) * tt,
      wheels: cb.wheels.map((w, i) => ({
        ...w,
        suspLen: ca.wheels[i].suspLen + (w.suspLen - ca.wheels[i].suspLen) * tt,
        spin: ca.wheels[i].spin + (w.spin - ca.wheels[i].spin) * tt,
      })),
    });
  }
  if (a.ball.pos.dist(b.ball.pos) > 600) view.ball.pos = b.ball.pos.clone();
  return view;
}
