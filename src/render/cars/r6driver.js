// TURBO PITCH — the jeep's driver: a bacon-hair Roblox avatar (tools/blender/import_bacon.py ->
// baconMesh.js) animated the way Roblox animates an R6 character.
//
// Seated: Roblox's R6 "Animate" script puts a seated character in one fixed pose: both shoulders
// and both hips at 90° (arms straight out in front, legs straight out along the seat), head and torso
// still. Its joints are Motor6Ds: each turns toward its target angle at a fixed rate (MaxVelocity,
// radians per 1/60 s step; 0.15 for the sit pose), so the character snaps from standing into the
// seat in about 0.2 s when it appears. The body is welded to the seat, so it rides rigidly with the
// jeep (no wobble).
// In the air (the jeep jumps): the R6 jump pose's arms, both shoulders straight up (MaxVelocity 0.5),
// legs still seated.
// His team scores: he jumps out of the jeep (R6 jump pose), falls (R6 fall pose: arms up, legs
// kicking), and when he hits the floor his joints break and he goes "oof". He is back in his seat for
// the replay / kickoff.
// Demolished: he pops out of the wreck, lands on his feet, waves goodbye ("baii") and falls apart.
// He is back in his seat when the jeep respawns.
// End of the match: the winners' drivers stand on their seats and do the R6 /e dance; the losers stay
// seated, head down.
import * as THREE from 'three';

const STEP = 60;                   // Motor6D MaxVelocity is per 1/60 s step
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const STUD = 0.07;                 // m (7 uu per stud, as the jeep)
const STAND = 1.5 * STUD;          // standing on the seat lifts the body 1.5 studs
const FEET = 3 * STUD;             // standing: torso centre to the soles (1 + 2 studs)
const LIMBS = ['arm_r', 'arm_l', 'leg_r', 'leg_l'];
const GRAV = 9.8;                  // m/s²: a little faster than the game's 6.5, like Roblox parts
const ARENA_X = 40.4, ARENA_Z = 50.6;      // keep him inside the side walls / back walls (m)
const PI = Math.PI;

const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0), _axis = new THREE.Vector3(), _f3 = new THREE.Vector3();

// parts: { id: { box: [[x,y,z],[x,y,z]] (model metres, relative to the joint) } }
// sfx(name, pos): plays a driver sound at a sim position (uu)
export function createR6Driver(groups, parts, root, sfx = () => {}) {
  const ids = Object.keys(parts).filter((id) => groups[id]);
  if (!ids.length) return null;
  // a body group at the torso: the whole character rises / turns / leaves the jeep with it
  const car = groups.torso ? groups.torso.parent : groups[ids[0]].parent;
  const body = new THREE.Group(); body.name = 'r6:body';
  const bodyHome = (groups.torso ? groups.torso.position : groups[ids[0]].position).clone();
  body.position.copy(bodyHome); car.add(body);
  for (const id of ids) { const g = groups[id]; g.position.sub(bodyHome); body.add(g); }
  const home = new Map(ids.map((id) => [id, groups[id].position.clone()]));
  // box corners per part (for the floor)
  const corners = {};
  for (const id of ids) {
    const [a, b] = parts[id].box;
    corners[id] = [];
    for (let i = 0; i < 8; i++) corners[id].push(new THREE.Vector3(i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]));
  }

  // joints: pitch (about the body's left-right axis: + swings a limb forward / up, tips the head back),
  // roll (about the forward axis: + leans toward the right) / yaw for the head; body rise and yaw
  const J = {};
  for (const id of [...LIMBS, 'head']) J[id] = { p: 0, r: 0, want: { p: 0, r: 0 } };
  const B = { rise: 0, yaw: 0, want: { rise: 0, yaw: 0 } };
  const toward = (cur, want, max) => { const d = want - cur; return Math.abs(d) <= max ? want : cur + Math.sign(d) * max; };
  function stepJoints(rates, dt) {
    for (const [id, j] of Object.entries(J)) {
      const m = (rates[id] ?? rates.all) * STEP * dt;
      j.p = toward(j.p, j.want.p, m); j.r = toward(j.r, j.want.r, m);
    }
    const m = (rates.body ?? rates.all) * STEP * dt;
    B.rise = toward(B.rise, B.want.rise, m * 0.12); B.yaw = toward(B.yaw, B.want.yaw, m);
  }
  function applyJoints() {
    for (const id of LIMBS) if (groups[id]) groups[id].quaternion.setFromAxisAngle(AX, J[id].r).multiply(_q.setFromAxisAngle(AZ, J[id].p));
    for (const id of ['head', 'hair']) if (groups[id]) groups[id].quaternion.setFromAxisAngle(AY, J.head.r).multiply(_q.setFromAxisAngle(AZ, J.head.p));
    if (mode === 'seat') { body.position.copy(bodyHome).addScaledVector(AY, B.rise); body.quaternion.setFromAxisAngle(AY, B.yaw); }
  }
  const set = (id, p, r = 0) => { J[id].want.p = p; J[id].want.r = r; };
  const sitDown = () => { for (const j of Object.values(J)) { j.p = 0; j.r = 0; } B.rise = 0; B.yaw = 0; };

  // mode: 'seat' | 'air' (out of the jeep, flying) | 'stand' (on the floor, waving) | 'dead' (in pieces)
  let mode = 'seat', bye = false, modeT = 0, said = false;
  const vel = new THREE.Vector3();                      // body velocity while out of the jeep
  const lastPos = new THREE.Vector3(), lastVel = new THREE.Vector3();
  let haveLast = false, t = 0, airT = 0, seenGoal, wasDemoed = false, dead = null;

  // ---- leaving the jeep: the body goes to world space, upright, facing the jeep's way
  function leave(v) {
    car.updateMatrixWorld(true);
    root.attach(body);
    const f = _f3.set(1, 0, 0).transformDirection(car.matrixWorld);
    body.quaternion.setFromAxisAngle(AY, Math.atan2(-f.z, f.x));
    vel.copy(v);
    mode = 'air'; modeT = 0; said = false;
  }
  // his team scored: jump out over the driver's side (the jeep's left)
  function jumpOut() {
    car.updateMatrixWorld(true);
    const left = _v.set(0, 0, -1).transformDirection(car.matrixWorld); left.y = 0; left.normalize();
    leave(lastVel.clone().multiplyScalar(0.6).addScaledVector(left, 1.4).add(_p.set(0, 4.2, 0)));
    bye = false;
  }
  // demolished: pop out of the wreck, then land and wave
  function popOut() {
    leave(lastVel.clone().multiplyScalar(0.25).add(_p.set(0, 2.5, 0)));
    bye = true;
  }
  const simPos = (p) => ({ x: p.x * 100, y: p.z * 100, z: p.y * 100 });
  function stepOut(dt) {
    modeT += dt;
    if (mode === 'air') {
      vel.y -= GRAV * dt;
      body.position.addScaledVector(vel, dt);
      if (Math.abs(body.position.x) > ARENA_X) { body.position.x = Math.sign(body.position.x) * ARENA_X; vel.x *= -0.3; }
      if (Math.abs(body.position.z) > ARENA_Z) { body.position.z = Math.sign(body.position.z) * ARENA_Z; vel.z *= -0.3; }
      if (body.position.y - FEET <= 0 && vel.y <= 0) {
        body.position.y = FEET;
        if (bye) { mode = 'stand'; modeT = 0; vel.set(0, 0, 0); }
        else { breakApart(vel, true); sfx('oof', simPos(body.position)); }
      }
    } else if (mode === 'stand') {
      if (!said && modeT > 0.25) { said = true; sfx('bye', simPos(body.position)); }
      if (modeT > 1.9) breakApart(_v.set(0, 0, 0), false);
    }
  }

  // ---- poses (joint targets + motor rates)
  function outPose() {
    if (mode === 'air') {
      // R6 jump (going up) / fall (coming down): arms up; falling, they spread and the legs kick
      const fall = vel.y < 0 ? Math.min(1, -vel.y / 3) : 0, k = Math.sin(t * 14);
      set('arm_r', PI, 0.35 * fall); set('arm_l', PI, -0.35 * fall);
      set('leg_r', 0.25 * fall * k); set('leg_l', -0.25 * fall * k); set('head', 0.15 * fall);
      return { all: 0.5 };
    }
    // waving goodbye: right arm up, waving side to side
    set('arm_r', 2.75, 0.2 + 0.4 * Math.sin(t * 9)); set('arm_l', 0);
    set('leg_r', 0); set('leg_l', 0); set('head', 0, 0.15 * Math.sin(t * 3));
    return { all: 0.5 };
  }
  function seatPose(cv, view) {
    const m = view && view.match, team = cv.team;
    const ended = m && m.state === 'ended';
    if (ended && m.winner === team) {
      // R6 /e dance on the seat: arms swing up and down in turn, legs step, body bobs and sways
      const w = t * PI * 2;
      set('arm_r', 1.4 + 1.3 * Math.sin(w), 0.25); set('arm_l', 1.4 - 1.3 * Math.sin(w), -0.25);
      set('leg_r', 0.35 * Math.max(0, Math.sin(w))); set('leg_l', 0.35 * Math.max(0, -Math.sin(w)));
      set('head', 0.12 * Math.sin(w * 2), 0.25 * Math.sin(w));
      B.want.rise = STAND + 0.012 * Math.abs(Math.sin(w * 2)); B.want.yaw = 0.3 * Math.sin(w);
      return { all: 0.5 };
    }
    // seated (the losers keep their head down at the end)
    set('leg_r', PI / 2); set('leg_l', PI / 2);
    set('head', ended ? -0.5 : 0, 0);
    B.want.rise = 0; B.want.yaw = 0;
    if (airT > 0.08) { set('arm_r', PI); set('arm_l', PI); return { all: 0.15, arm_r: 0.5, arm_l: 0.5, head: 0.1 }; }
    set('arm_r', PI / 2); set('arm_l', PI / 2);
    return { all: 0.15, head: 0.1 };
  }

  // ---- falling apart: every joint breaks; parts keep their world pose and carry on moving
  function breakApart(v, hard) {
    body.updateMatrixWorld(true);
    const centre = new THREE.Vector3().setFromMatrixPosition(body.matrixWorld);
    dead = [];
    for (const id of ids) {
      const g = groups[id];
      root.attach(g);
      const out = _v.setFromMatrixPosition(g.matrixWorld).sub(centre); out.y = 0;
      if (out.lengthSq() < 1e-6) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      out.normalize();
      const pv = new THREE.Vector3().copy(v).multiplyScalar(hard ? 0.5 : 0).setY(0)
        .addScaledVector(out, (hard ? 0.8 : 0.3) + Math.random() * 0.6)
        .add(_f3.set((Math.random() - 0.5) * 0.4, (hard ? 0.6 : 0.2) + Math.random() * 0.8, (Math.random() - 0.5) * 0.4));
      const w = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar((hard ? 4 : 2) + Math.random() * 5);
      dead.push({ id, g, v: pv, w });
    }
    mode = 'dead';
  }
  function stepDebris(dt) {
    for (const d of dead) {
      const g = d.g;
      d.v.y -= GRAV * dt;
      g.position.addScaledVector(d.v, dt);
      const wl = d.w.length();
      if (wl > 1e-4) g.quaternion.premultiply(_q.setFromAxisAngle(_axis.copy(d.w).divideScalar(wl), wl * dt));
      g.updateMatrix();
      // floor: push the lowest box corner back up to y = 0, bounce, rub
      let minY = Infinity;
      for (const c of corners[d.id]) { const y = _p.copy(c).applyMatrix4(g.matrix).y; if (y < minY) minY = y; }
      if (minY < 0) {
        g.position.y -= minY;
        if (d.v.y < 0) d.v.y = d.v.y < -1.5 ? -d.v.y * 0.3 : 0;
        const f = Math.exp(-dt * 6);
        d.v.x *= f; d.v.z *= f; d.w.multiplyScalar(Math.exp(-dt * 5));
        // settle onto the nearest flat side once it has nearly stopped (no balancing on a corner)
        if (d.v.lengthSq() < 0.25) {
          g.quaternion.slerp(flatten(g.quaternion), Math.min(1, dt * 6));
          d.w.multiplyScalar(Math.exp(-dt * 8));
        }
      }
      if (Math.abs(g.position.x) > ARENA_X) { g.position.x = Math.sign(g.position.x) * ARENA_X; d.v.x *= -0.3; }
      if (Math.abs(g.position.z) > ARENA_Z) { g.position.z = Math.sign(g.position.z) * ARENA_Z; d.v.z *= -0.3; }
    }
  }
  function stepOutside(dt) {
    const n = Math.min(15, Math.max(1, Math.ceil(dt * 60))), h = dt / n;
    for (let i = 0; i < n; i++) {
      if (mode === 'dead') stepDebris(h);
      else stepOut(h);
    }
    if (mode === 'air' || mode === 'stand') { stepJoints(outPose(), dt); applyJoints(); }
  }

  // ---- back in the seat
  function putBack() {
    car.add(body);
    for (const id of ids) { const g = groups[id]; body.add(g); g.position.copy(home.get(id)); g.quaternion.identity(); }
    dead = null; haveLast = false; mode = 'seat'; modeT = 0;
    sitDown();
    applyJoints();
  }

  putBack();
  return {
    update(cv, dt, view) {
      t += dt;
      const m = view && view.match;
      // a new goal: his team's makes him jump out (a goal from before he appeared doesn't count)
      if (m && seenGoal === undefined) seenGoal = m.lastGoal;
      const newGoal = m && m.lastGoal && m.lastGoal !== seenGoal ? m.lastGoal : null;
      if (newGoal) seenGoal = newGoal;
      const between = !!(view && view.isReplay) || !!(m && (m.state === 'replay' || m.state === 'countdown' || m.state === 'ended'));
      // back in the seat after a respawn, for the replay / kickoff / end, or a while after a free-play goal
      if (mode !== 'seat' && (wasDemoed || between || ((!m || m.mode === 'freeplay') && mode === 'dead' && modeT > 3))) putBack();
      wasDemoed = false;
      // remember how the car moves (his speed when he leaves it)
      const p = _p.set(cv.pos.x / 100, cv.pos.z / 100, cv.pos.y / 100);
      if (haveLast && dt > 0 && p.distanceTo(lastPos) < 4) lastVel.copy(p).sub(lastPos).divideScalar(dt);
      else lastVel.set(0, 0, 0);
      lastPos.copy(p); haveLast = true;
      if (mode === 'seat') {
        if (newGoal && newGoal.team === cv.team && !between) { jumpOut(); stepOutside(dt); return; }
        const air = (cv.numWheelsInContact || 0) === 0 && !cv.isOnGround;
        airT = air ? airT + dt : 0;
        stepJoints(seatPose(cv, view), dt);
        applyJoints();
      } else {
        if (mode === 'dead') modeT += dt;
        stepOutside(dt);
      }
    },
    // the jeep is demolished (hidden): he pops out and waves goodbye before falling apart
    demoed(cv, dt) {
      wasDemoed = true;
      if (mode === 'seat') popOut();
      if (mode === 'dead') modeT += dt;
      stepOutside(dt);
    },
    dispose() { if (mode !== 'seat') putBack(); },
  };
}

// the orientation nearest to q that has one of the part's axes pointing straight up
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const _f = new THREE.Quaternion(), _a = new THREE.Vector3();
function flatten(q) {
  let best = null, bestDot = -1;
  for (const ax of AXES) {
    for (const s of [1, -1]) {
      const d = _a.copy(ax).multiplyScalar(s).applyQuaternion(q).dot(_up);
      if (d > bestDot) { bestDot = d; best = _a.copy(ax).multiplyScalar(s).applyQuaternion(q).clone(); }
    }
  }
  return _f.setFromUnitVectors(best, _up).multiply(q);
}
