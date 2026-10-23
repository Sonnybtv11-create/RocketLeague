// TURBO PITCH — the jeep's driver: a bacon-hair Roblox avatar (tools/blender/import_bacon.py ->
// baconMesh.js) animated the way Roblox animates an R6 character.
//
// Seated: Roblox's R6 "Animate" script puts a seated character in one fixed pose and nothing else:
// both shoulders and both hips at 90° (arms straight out in front, legs straight out along the seat),
// head and torso still. Its joints are Motor6Ds: each turns toward its target angle at a fixed rate
// (MaxVelocity, radians per 1/60 s step; 0.15 for the sit pose), so the character snaps from standing
// into the seat in about 0.2 s when it appears, like a Roblox character sitting down. The body is
// welded to the seat, so it rides rigidly with the jeep (no wobble).
//
// Demolished: like a Roblox death, the joints break and the six parts plus the hair accessory fall
// apart, thrown by the explosion. They tumble, bounce on the floor and lie there until the car
// respawns, when the character is put back in its seat.
import * as THREE from 'three';

const ANGLES = { arm_r: Math.PI / 2, arm_l: Math.PI / 2, leg_r: Math.PI / 2, leg_l: Math.PI / 2 };
const SIT_RATE = 0.15 * 60;        // Motor6D MaxVelocity 0.15 rad per step at 60 steps/s
const AXIS = new THREE.Vector3(0, 0, 1);   // R6 shoulders / hips turn about the body's left-right axis
const GRAV = 9.8;                  // m/s²: debris falls a little faster than the game's 6.5, like Roblox parts
const ARENA_X = 40.4, ARENA_Z = 50.6;      // keep debris inside the side walls / back walls (m)

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion();
const _c = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _axis = new THREE.Vector3();

// parts: { id: { box: [[x,y,z],[x,y,z]] (model metres, relative to the joint) } }
export function createR6Driver(groups, parts, root) {
  const ids = Object.keys(parts).filter((id) => groups[id]);
  if (!ids.length) return null;
  const home = new Map(ids.map((id) => [id, { parent: groups[id].parent, pos: groups[id].position.clone() }]));
  const motors = Object.keys(ANGLES).filter((id) => groups[id]).map((id) => ({ id, cur: 0, want: ANGLES[id] }));
  // box corners per part (for the floor) and its centre (for the blast direction)
  const corners = {}, centre = {};
  for (const id of ids) {
    const [a, b] = parts[id].box;
    corners[id] = [];
    for (let i = 0; i < 8; i++) corners[id].push(new THREE.Vector3(i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]));
    centre[id] = new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  }
  const lastPos = new THREE.Vector3(), lastVel = new THREE.Vector3();
  let haveLast = false, dead = null;

  function sitDown() { for (const mo of motors) mo.cur = 0; }
  function stepMotors(dt) {
    for (const mo of motors) {
      const d = mo.want - mo.cur, s = SIT_RATE * dt;
      mo.cur += Math.abs(d) <= s ? d : Math.sign(d) * s;
      groups[mo.id].quaternion.setFromAxisAngle(AXIS, mo.cur);
    }
  }

  // break every joint: parts keep their world pose and fly off with the car's speed plus the blast
  function breakApart() {
    const car = groups[ids[0]].parent;
    car.updateMatrixWorld(true);
    const carCentre = _c.setFromMatrixPosition(car.matrixWorld);
    dead = [];
    for (const id of ids) {
      const g = groups[id];
      root.attach(g);
      const wc = centre[id].clone().applyMatrix4(g.matrixWorld);
      const out = wc.clone().sub(carCentre); out.y = 0;
      if (out.lengthSq() < 1e-6) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      out.normalize();
      const v = lastVel.clone().multiplyScalar(0.35)
        .addScaledVector(out, 1.5 + Math.random() * 2)
        .add(_v.set((Math.random() - 0.5) * 1.5, 2.5 + Math.random() * 2.5, (Math.random() - 0.5) * 1.5));
      const w = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(5 + Math.random() * 9);
      dead.push({ id, g, v, w, rest: 0 });
    }
  }
  function putBack() {
    for (const id of ids) {
      const g = groups[id], h = home.get(id);
      h.parent.add(g); g.position.copy(h.pos); g.quaternion.identity();
    }
    dead = null; haveLast = false;
    sitDown();
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
          d.rest += dt;
          const best = flatten(g.quaternion);
          g.quaternion.slerp(best, Math.min(1, dt * 6));
          d.w.multiplyScalar(Math.exp(-dt * 8));
        }
      }
      // arena walls
      if (Math.abs(g.position.x) > ARENA_X) { g.position.x = Math.sign(g.position.x) * ARENA_X; d.v.x *= -0.3; }
      if (Math.abs(g.position.z) > ARENA_Z) { g.position.z = Math.sign(g.position.z) * ARENA_Z; d.v.z *= -0.3; }
    }
  }

  sitDown();
  return {
    update(cv, dt) {
      if (dead) putBack();               // respawned
      // remember how the car moves (its speed is the debris' starting speed)
      const p = _p.set(cv.pos.x / 100, cv.pos.z / 100, cv.pos.y / 100);
      if (haveLast && dt > 0 && p.distanceTo(lastPos) < 4) lastVel.copy(p).sub(lastPos).divideScalar(dt);
      else lastVel.set(0, 0, 0);
      lastPos.copy(p); haveLast = true;
      stepMotors(dt);
    },
    // the car is demolished (hidden): break apart once, then let the pieces fall
    demoed(cv, dt) {
      if (!dead) breakApart();
      const n = Math.min(15, Math.ceil(dt * 60));
      for (let i = 0; i < n; i++) stepDebris(dt / n);
    },
    dispose() { if (dead) putBack(); },
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
