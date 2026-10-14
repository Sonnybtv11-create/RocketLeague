// Node tests for the camera rig (sim space): framing, behaviour and wall clearance.
// Run: node --test src/camera/tests/rig.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCarRig, hfovToVfov, createLookRig, spectatorTarget, replayTarget } from '../rig.js';
import { arenaSDF, arenaRaycast } from '../../sim/arena.js';
import { DEFAULT_SETTINGS } from '../../game/settings.js';

const arena = { sdf: arenaSDF, raycast: arenaRaycast };
const CAM = DEFAULT_SETTINGS.camera;
const v = (x, y, z) => ({ x, y, z });
const n = (a) => { const l = Math.hypot(a.x, a.y, a.z); return v(a.x / l, a.y / l, a.z / l); };
const crs = (a, b) => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
function carView(pos, fwd, up, vel = v(0, 0, 0), wheels = 4, extra = {}) {
  fwd = n(fwd); up = n(up);
  const right = crs(up, fwd);
  return { id: 0, pos, forward: fwd, up, right, vel, numWheelsInContact: wheels, isOnGround: wheels >= 3, ...extra };
}
function run(rig, car, ball, opts, frames = 120, aspect = 16 / 9, cam = CAM) {
  let p;
  for (let i = 0; i < frames; i++) p = rig.update(car, ball, cam, opts, 1 / 60, aspect, arena);
  return p;
}
// project a world point into normalised screen coords (0..1, y down) for a pose
function project(pose, pt, hfov, aspect) {
  const f = pose.dir, u = pose.up, r = crs(u, f); // RL: right = up x forward
  const d = v(pt.x - pose.pos.x, pt.y - pose.pos.y, pt.z - pose.pos.z);
  const z = dot(d, f), x = dot(d, r), y = dot(d, u);
  const th = Math.tan((hfov * Math.PI / 180) / 2);
  const tv = Math.tan((hfovToVfov(hfov, aspect) * Math.PI / 180) / 2);
  return { sx: 0.5 + 0.5 * (x / z) / th, sy: 0.5 - 0.5 * (y / z) / tv, depth: z };
}

test('hfov -> vfov: 110 horizontal at 16:9 is ~77.5 vertical, Hor+ on ultrawide', () => {
  assert.ok(Math.abs(hfovToVfov(110, 16 / 9) - 77.54) < 0.05);
  assert.equal(hfovToVfov(110, 21 / 9), hfovToVfov(110, 16 / 9));
  assert.ok(hfovToVfov(110, 4 / 3) > hfovToVfov(110, 16 / 9));
});

test('kickoff framing: car low-centre, horizon slightly above centre (matches RL reference)', () => {
  const rig = createCarRig();
  const car = carView(v(0, -4608, 17), v(0, 1, 0), v(0, 0, 1));
  const ball = { pos: v(0, 0, 92.75) };
  const pose = run(rig, car, ball, { ballCam: true });
  // camera 270 behind and 100 above the car
  assert.ok(Math.abs(pose.pos.y - (-4608 - 270)) < 1, `y ${pose.pos.y}`);
  assert.ok(Math.abs(pose.pos.z - 117) < 1, `z ${pose.pos.z}`);
  const wheel = project(pose, v(0, -4608 - 34, 0), 110, 16 / 9); // rear wheel contact line
  const horizon = project(pose, v(0, 1e6, 0), 110, 16 / 9);
  // facing +Y in RL's left-handed world, the car's right side is -X
  const left = project(pose, v(43.35, -4608 - 46, 17), 110, 16 / 9);
  const right = project(pose, v(-43.35, -4608 - 46, 17), 110, 16 / 9);
  console.log(`  wheel line y=${(wheel.sy * 100).toFixed(1)}%  horizon y=${(horizon.sy * 100).toFixed(1)}%  hitbox width=${((right.sx - left.sx) * 100).toFixed(1)}% of screen`);
  assert.ok(Math.abs(wheel.sy - 0.757) < 0.02, 'reference: wheel contact line at 75.7% of screen height');
  assert.ok(Math.abs(horizon.sy - 0.465) < 0.015, 'reference: horizon at ~46.5%');
  assert.ok(right.sx > left.sx, 'right side of the car appears right on screen');
});

test('stiffness: camera stretches back at speed, rigid at stiffness 1', () => {
  const mk = (st) => {
    const rig = createCarRig();
    const car = carView(v(0, 0, 17), v(0, 1, 0), v(0, 0, 1), v(0, 2300, 0));
    return run(rig, car, null, { ballCam: false }, 120, 16 / 9, { ...CAM, stiffness: st });
  };
  const loose = mk(0), rigid = mk(1);
  assert.ok(Math.abs(rigid.pos.y + 270) < 1);
  assert.ok(-loose.pos.y - 270 > 100, `stretch ${-loose.pos.y - 270}`);
});

test('ball cam: points at the ball, keeps heading when the ball is straight above', () => {
  const rig = createCarRig();
  const car = carView(v(0, 0, 17), v(0, 1, 0), v(0, 0, 1));
  let pose = run(rig, car, { pos: v(2000, 0, 93) }, { ballCam: true });
  assert.ok(pose.dir.x > 0.9, 'turned to face +X ball');
  pose = run(rig, car, { pos: v(2000, 0, 93) }, { ballCam: false });
  assert.ok(pose.dir.y > 0.9, 'car cam faces car forward');
  // ball high above the car: camera tilts up but keeps heading
  pose = run(rig, car, { pos: v(0, 400, 1200) }, { ballCam: true });
  assert.ok(pose.dir.z > 0.3, 'tilted up toward a high ball');
  assert.ok(pose.dir.y > 0.5);
  assert.ok(pose.pos.z > 40, 'camera stays above the floor');
  pose = run(rig, car, { pos: v(0, 0, 1500) }, { ballCam: true }); // straight above
  assert.ok(pose.dir.y > 0.3 && Math.abs(pose.dir.x) < 0.2, 'heading kept');
});

test('air: car cam follows velocity direction, not orientation', () => {
  const rig = createCarRig();
  // car spinning nose-down while flying toward +X
  const car = carView(v(0, 0, 800), v(0, 0.2, -1), v(0, 1, 0.2), v(1500, 0, 200), 0);
  const pose = run(rig, car, null, { ballCam: false });
  assert.ok(pose.dir.x > 0.9, 'looks along velocity');
  assert.ok(pose.up.z > 0.9, 'world up in the air');
});

test('walls: car cam uses the surface orientation', () => {
  const rig = createCarRig();
  // driving up the +X side wall (surface normal -X), heading +Z
  const car = carView(v(4096 - 17, 0, 900), v(0, 0, 1), v(-1, 0, 0), v(0, 0, 1200), 4);
  const pose = run(rig, car, null, { ballCam: false });
  assert.ok(pose.up.x < -0.9, 'camera up = wall normal');
  assert.ok(pose.dir.z > 0.9, 'looking up the wall');
  assert.ok(arenaSDF(pose.pos.x, pose.pos.y, pose.pos.z) > 20);
});

test('free look rotates around the car with swivel speed', () => {
  const rig = createCarRig();
  const car = carView(v(0, 0, 17), v(0, 1, 0), v(0, 0, 1));
  let pose = run(rig, car, null, { ballCam: false, look: { x: 1, y: 0 } });
  assert.ok(pose.dir.x < -0.95, 'stick right -> look right (-X when facing +Y in RL coords)');
  pose = run(rig, car, null, { ballCam: false, look: { x: 0, y: 1 } });
  assert.ok(pose.dir.y < -0.95, 'stick back -> look behind');
  pose = run(rig, car, null, { ballCam: false, look: { x: 0, y: 0 } });
  assert.ok(pose.dir.y > 0.95, 'released -> back to forward');
});

test('camera never inside the arena walls (sweep of positions/orientations/modes)', () => {
  let minD = Infinity, worst = null, count = 0;
  const rnd = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  const cases = [];
  // floor near walls / corners / goals, facing every direction
  for (let i = 0; i < 400; i++) {
    const x = (rnd() * 2 - 1) * 4000, y = (rnd() * 2 - 1) * 5900, z = 17;
    if (arenaSDF(x, y, z + 10) < 25) continue;
    const yaw = rnd() * Math.PI * 2;
    cases.push(carView(v(x, y, z), v(Math.cos(yaw), Math.sin(yaw), 0), v(0, 0, 1), v(Math.cos(yaw) * 1500 * rnd(), Math.sin(yaw) * 1500 * rnd(), 0)));
  }
  // on side walls / back walls / ceiling / corner walls (surface normal = -outward)
  const surf = [];
  for (let i = 0; i < 300; i++) {
    const k = Math.floor(rnd() * 4);
    let p, nrm;
    if (k === 0) { const s = rnd() < 0.5 ? 1 : -1; p = v(s * (4096 - 17), (rnd() * 2 - 1) * 3800, 300 + rnd() * 1500); nrm = v(-s, 0, 0); }
    else if (k === 1) { const s = rnd() < 0.5 ? 1 : -1; p = v((rnd() < 0.5 ? 1 : -1) * (1000 + rnd() * 2500), s * (5120 - 17), 700 + rnd() * 1200); nrm = v(0, -s, 0); }
    else if (k === 2) { p = v((rnd() * 2 - 1) * 3500, (rnd() * 2 - 1) * 4500, 2044 - 17); nrm = v(0, 0, -1); }
    else { const sx = rnd() < 0.5 ? 1 : -1, sy = rnd() < 0.5 ? 1 : -1; const t = rnd(); const cx = 4096 - 1152 * t, cy = 5120 - 1152 * (1 - t); const o = 17 / Math.SQRT2; p = v(sx * (cx - o), sy * (cy - o), 300 + rnd() * 1400); nrm = n(v(-sx, -sy, 0)); }
    if (arenaSDF(p.x, p.y, p.z) < 5) continue;
    const t1 = n(crs(nrm, v(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5)));
    surf.push(carView(p, t1, nrm, v(t1.x * 1200, t1.y * 1200, t1.z * 1200)));
  }
  // in the air near the ceiling corners
  for (let i = 0; i < 200; i++) {
    const p = v((rnd() * 2 - 1) * 3900, (rnd() * 2 - 1) * 4900, 100 + rnd() * 1900);
    if (arenaSDF(p.x, p.y, p.z) < 60) continue;
    const f = n(v(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5));
    cases.push(carView(p, f, n(crs(f, v(0, 1, 0))), v((rnd() - 0.5) * 3000, (rnd() - 0.5) * 3000, (rnd() - 0.5) * 2000), 0));
  }
  for (const car of [...cases, ...surf]) {
    for (const ballCam of [false, true]) {
      const rig = createCarRig();
      const ball = { pos: v((rnd() * 2 - 1) * 3500, (rnd() * 2 - 1) * 4500, 93 + rnd() * 1500) };
      const pose = run(rig, car, ball, { ballCam, look: { x: rnd() * 2 - 1, y: rnd() * 2 - 1 } }, 40);
      const d = arenaSDF(pose.pos.x, pose.pos.y, pose.pos.z);
      count++;
      if (d < minD) { minD = d; worst = { car: car.pos, cam: pose.pos }; }
    }
  }
  console.log(`  ${count} poses, minimum camera clearance ${minD.toFixed(1)} uu`);
  assert.ok(minD > 20, `camera too close to a wall: ${JSON.stringify(worst)}`);
});

test('spectator & replay targets stay inside the arena', () => {
  const rig = createLookRig();
  for (const bp of [v(0, 0, 93), v(3900, 5000, 100), v(-3900, -5000, 1800), v(0, 5500, 200)]) {
    const ball = { pos: bp, vel: v(0, 1000, 0) };
    const t = spectatorTarget(ball);
    let p = rig.update(t.pos, t.look, 1 / 60, 2, 4, 's', arena);
    assert.ok(arenaSDF(p.pos.x, p.pos.y, p.pos.z) > 50);
    for (const m of ['wide', 'ball', 'goal']) {
      for (const side of [1, -1]) {
        const r = replayTarget(m, ball, null, side);
        p = createLookRig().update(r.pos, r.look, 1 / 60, 2, 4, m, arena);
        assert.ok(arenaSDF(p.pos.x, p.pos.y, p.pos.z) > 50, `${m} ${side} ${JSON.stringify(p.pos)}`);
      }
    }
  }
});

test('ball cam on walls / ceiling / in the net keeps a usable boom (camera never collapses into the car)', () => {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const cases = [
    // driving up the +X side wall (normal -X), heading up / along the wall
    { name: 'side wall up', car: carView(v(4096 - 17, -800, 900), v(0, 0, 1), v(-1, 0, 0), v(0, 0, 1200)) },
    { name: 'side wall along', car: carView(v(4096 - 17, 1500, 1200), v(0, 1, 0), v(-1, 0, 0), v(0, 1500, 0)) },
    { name: '-X side wall low', car: carView(v(-4096 + 17, 2000, 400), v(0, 0.3, 1), v(1, 0, 0), v(0, 400, 1200)) },
    // upside down on the ceiling
    { name: 'ceiling', car: carView(v(1000, -1500, 2044 - 17), v(0, 1, 0), v(0, 0, -1), v(0, 1300, 0)) },
    // back wall beside the goal
    { name: 'back wall', car: carView(v(-2000, 5120 - 17, 900), v(0, 0, 1), v(0, -1, 0), v(0, 0, 1000)) },
    // reversed into the back of the net, facing out (ball cam boom points into the net)
    { name: 'in the net (backed in)', car: carView(v(0, 5900, 17), v(0, -1, 0), v(0, 0, 1)) },
    { name: 'in the net (facing net)', car: carView(v(300, 5850, 17), v(0, 1, 0), v(0, 0, 1)) },
    // corner, facing out of the corner
    { name: 'corner backed in', car: carView(v(3300, 4300, 17), v(-1, -1, 0), v(0, 0, 1)) },
  ];
  const balls = [v(0, 0, 93), v(-2500, -3000, 600), v(0, 3000, 1400)];
  let minD = Infinity;
  for (const c of cases) {
    for (const bp of balls) {
      for (const ballCam of [true, false]) {
        const rig = createCarRig();
        const pose = run(rig, c.car, { pos: bp }, { ballCam }, 150);
        const d = dist(pose.pos, c.car.pos);
        minD = Math.min(minD, d);
        const clr = arenaSDF(pose.pos.x, pose.pos.y, pose.pos.z);
        assert.ok(d >= 150, `${c.name} ballCam=${ballCam} ball=${JSON.stringify(bp)}: camera only ${d.toFixed(0)} uu from the car`);
        assert.ok(clr > 20, `${c.name}: camera clearance ${clr.toFixed(1)}`);
        // the car must stay in front of the camera (visible), not behind / beside it
        const toCar = v(c.car.pos.x - pose.pos.x, c.car.pos.y - pose.pos.y, c.car.pos.z - pose.pos.z);
        assert.ok(dot(n(toCar), pose.dir) > 0.3, `${c.name} ballCam=${ballCam}: car not in view`);
      }
    }
  }
  console.log(`  minimum car-camera distance on walls/ceiling/net: ${minD.toFixed(0)} uu`);
});

test('ball cam boom survives driving floor -> ramp -> wall -> ceiling -> falling off (frame by frame)', () => {
  // car path in the x-z cross-section of the +X side wall: floor, floor fillet (r 256), wall,
  // ceiling fillet, ceiling, then a fall from the ceiling. 1380 uu/s at 60 fps. Ball at centre.
  const R = 256, X = 4096, Hc = 2044, o = 17, sp = 23;
  const pts = [];
  const push = (x, z, nx, nz, tx, tz, air = false) => pts.push({ x, z, nx, nz, tx, tz, air });
  for (let x = 2900; x < X - R; x += sp) push(x, o, 0, 1, 1, 0);
  for (let a = 0; a < Math.PI / 2; a += sp / (R - o)) { // floor fillet
    const nx = -Math.sin(a), nz = Math.cos(a);
    push(X - R + (R - o) * Math.sin(a), R - (R - o) * Math.cos(a), nx, nz, Math.cos(a), Math.sin(a));
  }
  for (let z = R; z < Hc - R; z += sp) push(X - o, z, -1, 0, 0, 1);
  for (let a = 0; a < Math.PI / 2; a += sp / (R - o)) { // ceiling fillet
    const nx = -Math.cos(a), nz = -Math.sin(a);
    push(X - R + (R - o) * Math.cos(a), Hc - R + (R - o) * Math.sin(a), nx, nz, -Math.sin(a), Math.cos(a));
  }
  for (let x = X - R; x > 2600; x -= sp) push(x, Hc - o, 0, -1, -1, 0);
  { // fall off the ceiling for 1 s under gravity (still upside down)
    const x0 = pts[pts.length - 1].x;
    for (let i = 1; i <= 60; i++) { const t = i / 60; push(x0 - sp * i, Hc - o - 325 * t * t, 0, -1, -1, 0, true); }
  }
  for (const ballCam of [true, false]) {
    const rig = createCarRig();
    let minD = Infinity, at = null;
    pts.forEach((p, i) => {
      const car = carView(v(p.x, 0, p.z), v(p.tx, 0, p.tz), v(p.nx, 0, p.nz), v(p.tx * 1380, 0, p.tz * 1380), p.air ? 0 : 4);
      const pose = rig.update(car, { pos: v(0, 0, 93) }, CAM, { ballCam }, 1 / 60, 16 / 9, arena);
      const d = Math.hypot(pose.pos.x - p.x, pose.pos.y, pose.pos.z - p.z);
      if (i > 5 && d < minD) { minD = d; at = { x: p.x, z: p.z }; }
      assert.ok(arenaSDF(pose.pos.x, pose.pos.y, pose.pos.z) > 20);
    });
    console.log(`  ballCam=${ballCam}: min car-camera distance along the path ${minD.toFixed(0)} uu`);
    assert.ok(minD >= 150, `ballCam=${ballCam}: boom collapsed to ${minD.toFixed(0)} uu at ${JSON.stringify(at)}`);
  }
});
