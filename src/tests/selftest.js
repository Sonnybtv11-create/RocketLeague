// Automated physics self-tests (phases 1-5). Scripted inputs at 120 Hz.
// Runs in Node (tools/run-selftests.mjs) and in the browser debug menu (F3 -> Self-test).

import { World } from '../sim/world.js';
import { Vec3, rotMatFromYPR, yprFromRotMat } from '../sim/math.js';
import { arenaSDF } from '../sim/arena.js';
import { BallPredictor } from '../sim/ball.js';
import * as K from '../sim/const.js';
import { makeControls } from '../contracts.js';

function mkWorld(nCars = 1, hitbox = 'OCTANE') {
  const w = new World({ rng: (() => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })() });
  for (let i = 0; i < nCars; i++) w.addCar({ team: i % 2, hitbox, name: 'T' + i });
  return w;
}
function settleCar(w, car, x = 0, y = 0, yaw = 0, ticks = 120) {
  car.setSpawn(x, y, K.CAR_SPAWN_REST_Z, yaw);
  w.ball.reset(0, 4000, K.BALL_KICKOFF_Z); // keep ball out of the way
  for (let i = 0; i < ticks; i++) w.step();
}
function ctl(over) { return Object.assign(makeControls(), over); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

export const TESTS = [];
const T = (phase, name, fn) => TESTS.push({ phase, name, fn });

// ---------------------------------------------------------------- Phase 1
T(1, 'Ball drop from z=1000 bounces to ~0.36x height', () => {
  const w = mkWorld(0);
  w.ball.reset(0, 0, 1000);
  w.ball.body.vel.set(0, 0, -1e-6);
  let goingUp = false, peak = 0, bounced = false;
  for (let i = 0; i < 600; i++) {
    w.step();
    const b = w.ball.body;
    if (b.vel.z > 0) { goingUp = true; bounced = true; }
    if (goingUp) peak = Math.max(peak, b.pos.z);
    if (bounced && b.vel.z < 0 && goingUp) break;
  }
  const rise = peak - K.BALL_REST_Z, drop = 1000 - K.BALL_REST_Z;
  const ratio = rise / drop;
  return { pass: ratio > 0.32 && ratio < 0.39, detail: `peak ${peak.toFixed(1)} (rise/drop ${ratio.toFixed(3)}, expected ≈0.36 minus drag)` };
});

T(1, 'Ball rests at z≈93.15', () => {
  const w = mkWorld(0);
  w.ball.reset(0, 0, 200); w.ball.body.vel.set(0, 0, -1e-6);
  for (let i = 0; i < 1200; i++) w.step();
  const z = w.ball.body.pos.z;
  return { pass: near(z, 93.15, 1.0), detail: `rest z ${z.toFixed(2)}` };
});

T(1, 'Ball speed never exceeds 6000', () => {
  const w = mkWorld(0);
  w.ball.reset(0, 0, 1000); w.ball.body.vel.set(9000, 3000, 2000);
  let mx = 0;
  for (let i = 0; i < 600; i++) { w.step(); mx = Math.max(mx, w.ball.body.vel.len()); }
  return { pass: mx <= 6000.01, detail: `max speed ${mx.toFixed(1)}` };
});

T(1, 'Ball rolls into corner ramp smoothly and stays inside', () => {
  const w = mkWorld(0);
  w.ball.reset(2500, 3500, K.BALL_REST_Z); w.ball.body.vel.set(1500, 1500, 0);
  let minSdf = Infinity, maxZ = 0;
  for (let i = 0; i < 360; i++) { w.step(); const p = w.ball.body.pos; minSdf = Math.min(minSdf, arenaSDF(p.x, p.y, p.z)); maxZ = Math.max(maxZ, p.z); }
  return { pass: minSdf > 60 && maxZ > 200, detail: `min clearance ${minSdf.toFixed(1)} (radius 91.25), climbed to z ${maxZ.toFixed(0)}` };
});

T(1, 'Ball at 6000 uu/s never leaves the arena / tunnels the goal frame', () => {
  const w = mkWorld(0);
  let escaped = 0;
  const rng = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  for (let trial = 0; trial < 60; trial++) {
    w.ball.reset((rng() - 0.5) * 6000, (rng() - 0.5) * 8000, 200 + rng() * 1500);
    const dir = new Vec3(rng() - 0.5, (rng() - 0.5) * 2, rng() - 0.5).normalized();
    w.ball.body.vel.copy(dir.mul(6000));
    for (let i = 0; i < 240; i++) {
      w.step();
      const p = w.ball.body.pos;
      if (arenaSDF(p.x, p.y, p.z) < -5 || Math.abs(p.y) > 6000 || Math.abs(p.x) > 4096 || p.z > 2044 || p.z < 0) { escaped++; break; }
    }
  }
  // also fire straight at the posts/crossbar
  const shots = [[892, 5000, 300, 0, 1, 0], [-892, 5000, 300, 0, 1, 0], [0, 5000, 642, 0, 1, 0.1], [892, -5000, 100, 0.2, -1, 0]];
  for (const s of shots) {
    w.ball.reset(s[0], s[1], s[2]); w.ball.body.vel.copy(new Vec3(s[3], s[4], s[5]).normalized().mul(6000));
    for (let i = 0; i < 120; i++) {
      w.step(); const p = w.ball.body.pos;
      if (arenaSDF(p.x, p.y, p.z) < -5) { escaped++; break; }
    }
  }
  return { pass: escaped === 0, detail: `${escaped} escapes out of 64 shots` };
});

// ---------------------------------------------------------------- Phase 2
T(2, 'Car rests on its wheels (4 wheels, isOnGround)', () => {
  const w = mkWorld(1); const car = w.cars[0];
  settleCar(w, car, 0, 0, 0, 240);
  return { pass: car.isOnGround && car.numWheelsInContact === 4 && near(car.pos.z, 17, 3), detail: `z ${car.pos.z.toFixed(2)}, wheels ${car.numWheelsInContact}` };
});

T(2, 'Throttle-only top speed ≈1410', () => {
  const w = mkWorld(1); const car = w.cars[0];
  settleCar(w, car, -3000, -3800, Math.PI / 4 * 0 + 0.0);
  car.setSpawn(-2000, -3000, 17, Math.PI / 2);
  for (let i = 0; i < 30; i++) w.step();
  for (let i = 0; i < 900; i++) {
    car.controls = ctl({ throttle: 1 }); w.step();
    if (car.pos.y > 3000) car.body.pos.y -= 6000; // treadmill: stay on flat floor
  }
  const v = car.forwardSpeed;
  return { pass: near(v, 1410, 15), detail: `speed ${v.toFixed(1)}` };
});

T(2, 'Boost reaches 2300 and caps; supersonic at 2200', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(0, -4500, 17, Math.PI / 2, 100);
  for (let i = 0; i < 30; i++) w.step();
  let ssAt = -1, mx = 0;
  for (let i = 0; i < 360; i++) {
    car.controls = ctl({ throttle: 1, boost: true }); w.step();
    const s = car.vel.len(); mx = Math.max(mx, s);
    if (car.isSupersonic && ssAt < 0) ssAt = s;
  }
  return { pass: near(mx, 2300, 1) && ssAt >= 2199 && ssAt < 2240, detail: `max ${mx.toFixed(1)}, supersonic flag at ${ssAt.toFixed(1)}` };
});

T(2, 'Full boost tank lasts 3.0 s', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(0, 0, 300, Math.PI / 2, 100); // in the air, stays airborne a while
  w.ball.reset(0, 4000, K.BALL_KICKOFF_Z);
  let ticks = 0;
  car.body.rot = rotMatFromYPR(0, Math.PI / 2, 0); // nose up so we hover
  for (let i = 0; i < 600 && car.boost > 0; i++) { car.controls = ctl({ boost: true }); w.step(); ticks++; }
  const t = ticks / 120;
  return { pass: near(t, 3.0, 0.02), detail: `${t.toFixed(3)} s` };
});

T(2, 'Coasting decel ≈525, braking ≈3500', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(0, -4000, 17, Math.PI / 2);
  for (let i = 0; i < 30; i++) w.step();
  for (let i = 0; i < 240; i++) { car.controls = ctl({ throttle: 1 }); w.step(); }
  const v0 = car.forwardSpeed;
  for (let i = 0; i < 3; i++) { car.controls = ctl({}); w.step(); }
  const v0b = car.forwardSpeed;
  for (let i = 0; i < 60; i++) { car.controls = ctl({}); w.step(); }
  const coast = (v0b - car.forwardSpeed) / 0.5;
  for (let i = 0; i < 240; i++) { car.controls = ctl({ throttle: 1 }); w.step(); }
  for (let i = 0; i < 3; i++) { car.controls = ctl({ throttle: -1 }); w.step(); } // 1-tick wheel latency
  const v1 = car.forwardSpeed;
  for (let i = 0; i < 24; i++) { car.controls = ctl({ throttle: -1 }); w.step(); }
  const brake = (v1 - car.forwardSpeed) / 0.2;
  return { pass: near(coast, 525, 30) && near(brake, 3500, 120), detail: `coast ${coast.toFixed(0)} uu/s², brake ${brake.toFixed(0)} uu/s²` };
});

T(2, 'Powerslide slides (lateral speed builds up)', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(0, -4000, 17, Math.PI / 2);
  for (let i = 0; i < 30; i++) w.step();
  for (let i = 0; i < 180; i++) { car.controls = ctl({ throttle: 1 }); w.step(); }
  let maxLat = 0;
  for (let i = 0; i < 60; i++) { car.controls = ctl({ throttle: 1, steer: 1, handbrake: true }); w.step(); maxLat = Math.max(maxLat, Math.abs(car.vel.dot(car.right))); }
  const w2 = mkWorld(1); const c2 = w2.cars[0];
  c2.setSpawn(0, -4000, 17, Math.PI / 2);
  for (let i = 0; i < 30; i++) w2.step();
  for (let i = 0; i < 180; i++) { c2.controls = ctl({ throttle: 1 }); w2.step(); }
  let maxLat2 = 0;
  for (let i = 0; i < 60; i++) { c2.controls = ctl({ throttle: 1, steer: 1 }); w2.step(); maxLat2 = Math.max(maxLat2, Math.abs(c2.vel.dot(c2.right))); }
  return { pass: maxLat > maxLat2 * 2 && maxLat > 200, detail: `lateral slip with powerslide ${maxLat.toFixed(0)} vs normal ${maxLat2.toFixed(0)}` };
});

T(2, 'Drives up the wall, along it and onto the ceiling holding throttle', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(2500, 0, 17, 0, 100);
  for (let i = 0; i < 30; i++) w.step();
  let onWall = false, onCeil = false, maxZ = 0;
  for (let i = 0; i < 900; i++) {
    car.controls = ctl({ throttle: 1, boost: i < 400 });
    w.step();
    maxZ = Math.max(maxZ, car.pos.z);
    if (car.isOnGround && car.up.x < -0.9 && car.pos.z > 500) onWall = true;
    if (car.isOnGround && car.up.z < -0.9 && car.pos.z > 1900) onCeil = true;
  }
  return { pass: onWall && onCeil, detail: `wall ${onWall}, ceiling ${onCeil}, max z ${maxZ.toFixed(0)}` };
});

T(2, 'Slides off the wall when throttle released', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(2500, 0, 17, 0, 100);
  for (let i = 0; i < 30; i++) w.step();
  let t = 0;
  for (; t < 600; t++) { car.controls = ctl({ throttle: 1, boost: true }); w.step(); if (car.isOnGround && car.pos.z > 700 && car.up.x < -0.95) break; }
  // turn along the wall so we are not driving straight up
  const zStart = car.pos.z;
  let fell = false;
  for (let i = 0; i < 360; i++) { car.controls = ctl({}); w.step(); if (car.pos.z < zStart - 300 || !car.isOnGround) { fell = true; } }
  return { pass: fell, detail: `wall z ${zStart.toFixed(0)} -> ${car.pos.z.toFixed(0)}, onGround ${car.isOnGround}` };
});

// ---------------------------------------------------------------- Phase 3
function airborneCar(w, car, speed = 0) {
  car.setSpawn(0, -4000, 17, Math.PI / 2, 100);
  for (let i = 0; i < 30; i++) w.step();
  if (speed > 0) {
    // drive to speed with boost on the ground
    for (let i = 0; i < 600 && car.forwardSpeed < speed; i++) {
      car.controls = ctl({ throttle: 1, boost: car.forwardSpeed < speed - 40 }); w.step();
      if (car.pos.y > 3000) car.body.pos.y -= 6000;
    }
  }
}

T(3, 'Dodge only within 1.25 s after jump ends', () => {
  const w = mkWorld(1); const car = w.cars[0];
  airborneCar(w, car);
  // single long jump then wait 1.3 s
  for (let i = 0; i < 30; i++) { car.controls = ctl({ jump: true }); w.step(); }
  for (let i = 0; i < 1.3 * 120; i++) { car.controls = ctl({}); w.step(); }
  const canLate = car.airTimeSinceJump < K.DOUBLEJUMP_MAX_DELAY;
  car.controls = ctl({ jump: true, pitch: -1 }); w.step();
  const flippedLate = car.hasFlipped;
  // second car: dodge at 1.0 s
  const w2 = mkWorld(1); const c2 = w2.cars[0];
  airborneCar(w2, c2);
  for (let i = 0; i < 30; i++) { c2.controls = ctl({ jump: true }); w2.step(); }
  for (let i = 0; i < 100; i++) { c2.controls = ctl({}); w2.step(); }
  c2.controls = ctl({ jump: true, pitch: -1 }); w2.step();
  return { pass: !flippedLate && !canLate && c2.hasFlipped, detail: `late flip ${flippedLate}, in-window flip ${c2.hasFlipped}` };
});

T(3, 'Driving off a ramp without jumping keeps the flip indefinitely', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(0, 0, 800, 0);
  for (let i = 0; i < 240; i++) { car.controls = ctl({}); w.step(); car.body.pos.z = 800; car.body.vel.z = 0; }
  car.controls = ctl({ jump: true, pitch: -1 }); w.step();
  return { pass: car.hasFlipped, detail: `airTime ${car.airTime.toFixed(2)} s, flipped ${car.hasFlipped}` };
});

T(3, 'Front flip at 1000 uu/s adds ~500 uu/s forward', () => {
  const w = mkWorld(1); const car = w.cars[0];
  airborneCar(w, car, 1000);
  car.controls = ctl({ jump: true }); w.step(); w.step();
  car.controls = ctl({}); for (let i = 0; i < 6; i++) w.step();
  const before = car.vel.to2D().dot(car.forward.to2D().normalized());
  car.controls = ctl({ jump: true, pitch: -1 }); w.step();
  const after = car.vel.to2D().dot(car.forward.to2D().normalized());
  const dv = after - before;
  return { pass: near(dv, 500, 25), detail: `Δv forward ${dv.toFixed(1)} at ${before.toFixed(0)} uu/s` };
});

T(3, 'Side flip at max speed adds ~950 uu/s sideways', () => {
  const w = mkWorld(1); const car = w.cars[0];
  airborneCar(w, car, 2290);
  car.controls = ctl({ jump: true }); w.step(); w.step();
  car.controls = ctl({}); for (let i = 0; i < 6; i++) w.step();
  const r2 = car.right.to2D().normalized();
  const before = car.vel.dot(r2), fs = car.forwardSpeed;
  car.controls = ctl({ jump: true, yaw: 1 }); w.step();
  const dv = car.vel.dot(r2) - before;
  const expect = 500 * (1 + 0.9 * Math.abs(fs) / 2300);
  // the impulse is applied, then total speed is clamped to 2300 at the end of the tick
  const vz = car.vel.z, pre = Math.hypot(fs, before + expect, vz);
  const expectAfter = (before + expect) * Math.min(1, 2300 / pre) - before;
  return { pass: near(dv, expectAfter, 15) && expect > 930, detail: `impulse ${expect.toFixed(0)} uu/s at fwd ${fs.toFixed(0)}; after 2300 clamp Δv side ${dv.toFixed(1)} (expected ${expectAfter.toFixed(0)})` };
});

T(3, 'Backflip at speed scales up to 2.5×', () => {
  const w = mkWorld(1); const car = w.cars[0];
  airborneCar(w, car, 2000);
  car.controls = ctl({ jump: true }); w.step(); w.step();
  car.controls = ctl({}); for (let i = 0; i < 6; i++) w.step();
  const f2 = car.forward.to2D().normalized();
  const before = car.vel.dot(f2), fs = car.forwardSpeed;
  car.controls = ctl({ jump: true, pitch: 1 }); w.step();
  const dv = before - car.vel.dot(f2);
  const expect = 500 * (1 + 1.5 * Math.abs(fs) / 2300) * 16 / 15;
  return { pass: near(dv, expect, 30), detail: `Δv back ${dv.toFixed(1)} (expected ${expect.toFixed(0)})` };
});

T(3, 'Flip cancel produces a working half-flip', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(0, 0, 17, Math.PI / 2);
  for (let i = 0; i < 30; i++) w.step();
  for (let i = 0; i < 120; i++) { car.controls = ctl({ throttle: -1 }); w.step(); } // reverse a bit
  car.controls = ctl({ jump: true, throttle: -1 }); w.step(); w.step(); w.step();
  car.controls = ctl({ throttle: -1 }); for (let i = 0; i < 4; i++) w.step();
  car.controls = ctl({ jump: true, pitch: 1 }); w.step(); // backflip
  for (let i = 0; i < 8; i++) { car.controls = ctl({ pitch: 1 }); w.step(); }
  // cancel: push pitch forward (same sign as flip pitch torque -> cancel) and air roll
  for (let i = 0; i < 150; i++) { car.controls = ctl({ pitch: -1, roll: 1, throttle: 1, boost: false }); w.step(); if (car.isOnGround && i > 30) break; }
  for (let i = 0; i < 60; i++) { car.controls = ctl({ throttle: 1 }); w.step(); }
  // after a half flip the car should face the opposite direction (-Y) and be wheels-down
  const fwdY = car.forward.y;
  return { pass: fwdY < -0.7 && car.up.z > 0.8, detail: `facing y ${fwdY.toFixed(2)}, up.z ${car.up.z.toFixed(2)}` };
});

T(3, 'Pitch locked during flip', () => {
  const w = mkWorld(1); const car = w.cars[0];
  airborneCar(w, car);
  car.controls = ctl({ jump: true }); w.step(); w.step();
  car.controls = ctl({}); for (let i = 0; i < 6; i++) w.step();
  car.controls = ctl({ jump: true, yaw: 1 }); w.step(); // side flip: no pitch torque
  const r0 = car.right;
  let maxPitchRate = 0;
  for (let i = 0; i < 40; i++) { car.controls = ctl({ pitch: 1 }); w.step(); maxPitchRate = Math.max(maxPitchRate, Math.abs(car.angVel.dot(car.right))); }
  return { pass: maxPitchRate < 0.5, detail: `max pitch rate during side flip with full pitch input ${maxPitchRate.toFixed(3)} rad/s` };
});

T(3, 'Air roll rate and 5.5 rad/s cap', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(0, 0, 1000, 0);
  car.body.vel.set(0, 0, 500);
  let mx = 0;
  const w0 = car.angVel.len();
  car.controls = ctl({ roll: 1 }); w.step();
  const acc = (car.angVel.len() - w0) * 120;
  for (let i = 0; i < 200; i++) { car.controls = ctl({ roll: 1, yaw: 1, pitch: 1 }); w.step(); mx = Math.max(mx, car.angVel.len()); }
  return { pass: near(acc, 38.35, 1.0) && mx <= 5.5001, detail: `initial roll accel ${acc.toFixed(2)} rad/s² (expect 38.35), max ω ${mx.toFixed(3)}` };
});

// ---------------------------------------------------------------- Phase 4
T(4, 'Driving into still ball at 1400 uu/s (RocketSim model predicts ≈2000)', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(0, -3000, 17, Math.PI / 2);
  w.ball.reset(0, 0, K.BALL_REST_Z);
  for (let i = 0; i < 30; i++) { w.step(); }
  w.ball.reset(0, 0, K.BALL_REST_Z);
  let hitSpeed = 0, carSpeed = 0;
  for (let i = 0; i < 600; i++) {
    car.controls = ctl({ throttle: 1, boost: car.forwardSpeed < 1390 });
    w.ball.body.pos.y = Math.max(w.ball.body.pos.y, 0);
    w.step();
    if (w.ball.body.vel.len() > 10) { carSpeed = car.forwardSpeed; for (let k = 0; k < 6; k++) { car.controls = ctl({}); w.step(); } hitSpeed = w.ball.body.vel.len(); break; }
  }
  return { pass: hitSpeed > 1800 && hitSpeed < 2400, detail: `car ${carSpeed.toFixed(0)} uu/s -> ball ${hitSpeed.toFixed(0)} uu/s` };
});

T(4, 'Ball can be dribbled on the roof', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(0, -4000, 17, Math.PI / 2);
  for (let i = 0; i < 60; i++) w.step();
  for (let i = 0; i < 100; i++) { car.controls = ctl({ throttle: 0.6 }); w.step(); }
  w.ball.reset(car.pos.x, car.pos.y + 5, car.pos.z + 135); w.ball.body.vel.copy(car.vel);
  let onRoof = 0;
  for (let i = 0; i < 360; i++) {
    const rel = car.rot.mulVecT(w.ball.pos.sub(car.pos));
    const rv = car.rot.mulVecT(w.ball.vel.sub(car.vel));
    car.controls = ctl({
      throttle: Math.max(-1, Math.min(1, (rel.x - 8) * 0.05 + rv.x * 0.03 + 0.2)),
      steer: Math.max(-1, Math.min(1, rel.y * 0.03 + rv.y * 0.01)),
    });
    w.step();
    if (car.pos.y > 3000) { car.body.pos.y -= 6000; w.ball.body.pos.y -= 6000; }
    const r2 = car.rot.mulVecT(w.ball.pos.sub(car.pos));
    if (r2.z > 90 && Math.abs(r2.x) < 80 && Math.abs(r2.y) < 60) onRoof++;
  }
  return { pass: onRoof > 340, detail: `ball on roof ${onRoof}/360 ticks at ~640 uu/s` };
});

T(4, 'Landing all wheels on the ball resets the flip', () => {
  const w = mkWorld(1); const car = w.cars[0];
  w.ball.reset(0, 0, 600); w.ball.body.vel.set(0, 0, 1e-6);
  car.setSpawn(0, 0, 800, 0);
  car.hasJumped = true; car.hasFlipped = true; car.isOnGround = false;
  w.ball.body.vel.set(0, 0, 0); w.ball.body.angVel.set(0, 0, 0);
  let reset = false;
  for (let i = 0; i < 150; i++) {
    car.controls = ctl({});
    w.ball.body.pos.set(0, 0, 600); w.ball.body.vel.set(0, 0, 0.001);
    w.step();
    if (car.isOnGround && !car.hasFlipped) reset = true;
  }
  return { pass: reset, detail: `wheels ${car.numWheelsInContact}, hasFlipped ${car.hasFlipped}` };
});

T(4, 'Supersonic front-bumper hit demolishes an enemy', () => {
  const w = mkWorld(2); const a = w.cars[0], b = w.cars[1];
  a.setSpawn(0, -4000, 17, Math.PI / 2, 100);
  b.setSpawn(0, 1500, 17, 0);
  w.ball.reset(3000, 0, K.BALL_REST_Z);
  let demo = false;
  for (let i = 0; i < 600 && !demo; i++) { a.controls = ctl({ throttle: 1, boost: true }); b.controls = ctl({}); w.step(); if (b.isDemoed) demo = true; }
  return { pass: demo, detail: `victim demoed ${demo}, attacker supersonic ${a.isSupersonic}` };
});

T(4, 'Non-supersonic hit bumps per curve (with 0.25 s cooldown)', () => {
  const w = mkWorld(2); const a = w.cars[0], b = w.cars[1];
  a.setSpawn(0, -3000, 17, Math.PI / 2, 0);
  b.setSpawn(0, -1000, 17, 0);
  w.ball.reset(3000, 0, K.BALL_REST_Z);
  let bumps = [], speed = 0;
  for (let i = 0; i < 400; i++) {
    a.controls = ctl({ throttle: 1 }); b.controls = ctl({}); w.step();
    for (const e of w.events) if (e.type === 'carBump') { bumps.push(w.tick); speed = e.speed; }
  }
  const bv = b.vel.len();
  const expected = K.BUMP_VEL_AMOUNT_GROUND_CURVE.get(speed);
  const okCooldown = bumps.every((t, i) => i === 0 || t - bumps[i - 1] >= 30);
  return { pass: bumps.length >= 1 && !b.isDemoed && okCooldown, detail: `${bumps.length} bump(s) at ${speed.toFixed(0)} uu/s (curve ${expected.toFixed(0)}), victim speed after ${bv.toFixed(0)}` };
});

// ---------------------------------------------------------------- Phase 5
T(5, 'Boost pad pickup (+12 small, +100 big, respawn timers)', () => {
  const w = mkWorld(1); const car = w.cars[0];
  car.setSpawn(0, -1024 - 400, 17, Math.PI / 2, 0);
  for (let i = 0; i < 300; i++) { car.controls = ctl({ throttle: 1 }); w.step(); if (car.pos.y > -900) break; }
  const small = car.boost;
  const pad = w.pads.find((p) => !p.isBig && p.pos.x === 0 && p.pos.y === -1024);
  return { pass: near(small, 12, 0.01) && !pad.isActive && near(pad.cooldown, 4, 0.5), detail: `boost ${small.toFixed(2)}, pad cooldown ${pad.cooldown.toFixed(2)}` };
});

T(5, 'Goal detected when the whole ball crosses the line', () => {
  const w = mkWorld(0);
  w.ball.reset(0, 4800, 300); w.ball.body.vel.set(0, 2000, 0);
  let at = null;
  for (let i = 0; i < 120; i++) { w.step(); if (w.goalScored && !at) at = w.ball.pos.y; }
  return { pass: at !== null && at > 5215 && w.goalScored.team === 0, detail: `scored at y=${at && at.toFixed(1)} by team ${w.goalScored && w.goalScored.team}` };
});

T(5, 'Ball prediction matches the live sim', () => {
  const w = mkWorld(0);
  w.ball.reset(-1000, -2000, 500); w.ball.body.vel.set(1500, 2500, 800);
  const pred = new BallPredictor().predict({ pos: w.ball.pos, vel: w.ball.vel, angVel: w.ball.angVel }, 3);
  for (let i = 0; i < 360; i++) w.step();
  const p = pred[359].pos;
  const err = w.ball.pos.dist(new Vec3(p.x, p.y, p.z));
  return { pass: err < 1, detail: `error after 3 s: ${err.toFixed(3)} uu` };
});

export function runAll(filterPhase = null, log = console.log) {
  const results = [];
  for (const t of TESTS) {
    if (filterPhase && t.phase !== filterPhase) continue;
    let r;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try { r = t.fn(); } catch (e) { r = { pass: false, detail: 'EXCEPTION ' + (e && e.stack || e) }; }
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    results.push({ phase: t.phase, name: t.name, ...r, ms });
    log(`${r.pass ? 'PASS' : 'FAIL'}  [P${t.phase}] ${t.name} — ${r.detail} (${ms.toFixed(0)} ms)`);
  }
  const passed = results.filter((r) => r.pass).length;
  log(`${passed}/${results.length} passed`);
  return results;
}
