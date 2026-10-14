// The simulation world (RocketSim Arena.cpp port, Soccar).
// One call to step() advances exactly one 120 Hz tick.

import { Vec3 } from './math.js';
import { Car } from './car.js';
import { Ball } from './ball.js';
import { carWorldContacts, carBallContact, carCarContacts, solveContacts, integrateBody } from './physics.js';
import * as K from './const.js';
import { EV } from '../contracts.js';

export class BoostPad {
  constructor(index, x, y, z, isBig) {
    this.index = index;
    this.pos = new Vec3(x, y, z);
    this.isBig = isBig;
    this.isActive = true;
    this.cooldown = 0;
    this.prevLockedCarId = -1;
    this.curLockedCar = null;
    const br = isBig ? K.PAD.BOX_RAD_BIG : K.PAD.BOX_RAD_SMALL;
    this.boxMin = new Vec3(x - br, y - br, z);
    this.boxMax = new Vec3(x + br, y + br, z + K.PAD.BOX_HEIGHT);
  }
  reset() { this.isActive = true; this.cooldown = 0; this.prevLockedCarId = -1; this.curLockedCar = null; }
  preTick(dt) {
    if (this.cooldown > 0) this.cooldown = Math.max(this.cooldown - dt, 0);
    this.isActive = this.cooldown === 0;
    this.curLockedCar = null;
  }
  checkCollide(car) {
    const p = car.body.pos;
    let colliding = false;
    if (this.prevLockedCarId === car.id) {
      // AABB of the car hitbox vs pad box
      const aabb = carAABB(car);
      colliding = this.boxMax.x > aabb.min.x && this.boxMax.y > aabb.min.y && this.boxMax.z > aabb.min.z &&
        this.boxMin.x < aabb.max.x && this.boxMin.y < aabb.max.y && this.boxMin.z < aabb.max.z;
    } else {
      const rad = this.isBig ? K.PAD.CYL_RAD_BIG : K.PAD.CYL_RAD_SMALL;
      const dx = p.x - this.pos.x, dy = p.y - this.pos.y;
      if (dx * dx + dy * dy < rad * rad) colliding = Math.abs(p.z - this.pos.z) < K.PAD.CYL_HEIGHT;
    }
    if (colliding) this.curLockedCar = car;
  }
  postTick(dt, events) {
    let lockedId = -1;
    const car = this.curLockedCar;
    if (car) {
      lockedId = car.id;
      if (this.isActive) {
        const add = this.isBig ? K.PAD.BOOST_AMOUNT_BIG : K.PAD.BOOST_AMOUNT_SMALL;
        car.boost = Math.min(car.boost + add, K.BOOST_MAX);
        this.isActive = false;
        this.cooldown = this.isBig ? K.PAD.COOLDOWN_BIG : K.PAD.COOLDOWN_SMALL;
        events.push({ type: EV.PAD_PICKUP, carId: car.id, padIndex: this.index, isBig: this.isBig, pos: this.pos.clone() });
      }
    }
    this.prevLockedCarId = lockedId;
  }
}

function carAABB(car) {
  const b = car.body, hs = car.halfSize, off = car.config.hitboxOffset, R = b.rot;
  const c = b.pos.add(R.mulVec(new Vec3(off.x, off.y, off.z)));
  const m = R.m;
  const ex = Math.abs(m[0]) * hs.x + Math.abs(m[1]) * hs.y + Math.abs(m[2]) * hs.z;
  const ey = Math.abs(m[3]) * hs.x + Math.abs(m[4]) * hs.y + Math.abs(m[5]) * hs.z;
  const ez = Math.abs(m[6]) * hs.x + Math.abs(m[7]) * hs.y + Math.abs(m[8]) * hs.z;
  return { min: new Vec3(c.x - ex, c.y - ey, c.z - ez), max: new Vec3(c.x + ex, c.y + ey, c.z + ez) };
}

export class World {
  constructor(opts = {}) {
    this.tick = 0;
    this.time = 0;
    this.dt = K.TICK_TIME;
    this.cars = [];
    this.ball = new Ball();
    this.pads = [];
    K.PAD_LOCS_BIG.forEach((p, i) => this.pads.push(new BoostPad(i, p[0], p[1], p[2], true)));
    K.PAD_LOCS_SMALL.forEach((p, i) => this.pads.push(new BoostPad(K.PAD_LOCS_BIG.length + i, p[0], p[1], p[2], false)));
    this.events = [];
    this.rng = opts.rng || Math.random;
    this.unlimitedBoost = false;
    this.demosEnabled = true;
    this.lastTouch = null;     // {carId, team, tick}
    this.ballTouchedThisTick = [];
    this._nextCarId = 0;
    this.goalScored = null;    // set when the ball crosses a goal line (team that conceded side)
    this.carsFrozen = false;   // kickoff countdown: cars cannot move
  }

  addCar(opts) {
    const car = new Car({ id: this._nextCarId++, ...opts });
    this.cars.push(car);
    return car;
  }
  removeCar(car) { this.cars = this.cars.filter((c) => c !== car); }
  getCar(id) { return this.cars.find((c) => c.id === id); }

  // RocketSim Arena::ResetToRandomKickoff
  resetKickoff() {
    const order = [0, 1, 2, 3, 4];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const blue = this.cars.filter((c) => c.team === 0), orange = this.cars.filter((c) => c.team === 1);
    const n = Math.max(blue.length, orange.length);
    const atRespawn = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      let sp;
      if (i < 5) sp = { ...K.CAR_SPAWN_LOCATIONS[order[i]] };
      else {
        const ri = (i - 5) % 4;
        sp = { ...K.CAR_RESPAWN_LOCATIONS[ri] };
        sp.y += 250 * atRespawn[ri]++;
      }
      for (let t = 0; t < 2; t++) {
        const list = t === 0 ? blue : orange;
        if (i >= list.length) continue;
        const s = t === 0 ? 1 : -1;
        list[i].setSpawn(sp.x * s, sp.y * s, K.CAR_SPAWN_REST_Z, sp.yaw + (t === 0 ? 0 : Math.PI));
        list[i].kickoffSpawnIndex = order[Math.min(i, 4)];
      }
    }
    this.ball.reset();
    for (const p of this.pads) p.reset();
    this.lastTouch = null;
    this.goalScored = null;
  }

  respawnCar(car) {
    const idx = Math.floor(this.rng() * 4);
    const sp = K.CAR_RESPAWN_LOCATIONS[idx];
    const s = car.team === 0 ? 1 : -1;
    car.setSpawn(sp.x, sp.y * s, K.CAR_RESPAWN_Z, sp.yaw + (car.team === 0 ? 0 : Math.PI));
    this.events.push({ type: EV.RESPAWN, carId: car.id });
  }

  demolish(car, attacker) {
    car.isDemoed = true;
    car.demoRespawnTimer = K.DEMO_RESPAWN_TIME;
    car.isBoosting = false;
    this.events.push({ type: EV.DEMO, attackerId: attacker ? attacker.id : -1, victimId: car.id, pos: car.body.pos.clone(), vel: car.body.vel.clone() });
  }

  isBallScored() {
    return Math.abs(this.ball.body.pos.y) > K.SOCCAR_GOAL_SCORE_BASE_THRESHOLD_Y + K.BALL_RADIUS;
  }

  // controls: Map/obj carId -> Controls (optional; otherwise car.controls is used)
  step() {
    const dt = this.dt;
    this.events = [];
    this.ballTouchedThisTick = [];
    const ball = this.ball, bb = ball.body;
    const ballVelBefore = bb.vel.clone();

    if (this.carsFrozen) {
      for (const car of this.cars) {
        // kickoff countdown: inputs ignored except we still let boost flames show
        car.controls = { ...car.controls, throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
      }
    }

    for (const car of this.cars) car.preTick(this, dt);
    for (const p of this.pads) p.preTick(dt);

    const ballSleeping = ball.isSleeping();

    // ---- stepSimulation: integrate velocities (forces + gravity) ----
    for (const car of this.cars) {
      if (car.isDemoed) { car.body.force.set(0, 0, 0); continue; }
      const b = car.body;
      b.vel.addScaledSelf(b.force, b.invMass * dt);
      b.vel.z += K.GRAVITY_Z * dt;
      b.force.set(0, 0, 0);
    }
    if (!ballSleeping) ball.integrateVelocity(dt);

    // ---- collision detection ----
    const contacts = [];
    if (!ballSleeping) {
      const bc = ball.worldContact();
      if (bc) {
        contacts.push(bc);
        const vn = -bb.vel.dot(bc.n);
        if (vn > 150) this.events.push({ type: EV.BALL_BOUNCE, pos: bb.pos.clone(), normal: bc.n.clone(), speed: vn });
      }
    }
    const active = this.cars.filter((c) => !c.isDemoed);
    for (const car of active) {
      const wc = [];
      carWorldContacts(car, 1.0, wc);
      for (const c of wc) {
        car.worldContact.hasContact = true;
        car.worldContact.normal = c.n;
        contacts.push({ a: car.body, b: null, pA: c.pA, pB: c.pA, n: c.n, depth: c.depth, friction: K.CARWORLD_FRICTION, restitution: K.CARWORLD_RESTITUTION, kind: 'carWorld', car });
      }
    }
    for (const car of active) {
      const c = carBallContact(car, bb, K.BALL_RADIUS, 1.0);
      if (!c) continue;
      this._onCarBallHit(car, c);
      // A = ball, B = car; normal from car to ball
      contacts.push({ a: bb, b: car.body, pA: c.pBall, pB: c.pCar, n: c.n, depth: c.depth, friction: K.CARBALL_FRICTION, restitution: K.CARBALL_RESTITUTION, kind: 'carBall', car });
    }
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const A = active[i], B = active[j];
        const cc = carCarContacts(A, B, 1.0);
        if (!cc.length) continue;
        for (const c of cc) {
          this._onCarCarContact(A, B, c);
          if (A.isDemoed || B.isDemoed) break;
          contacts.push({ a: A.body, b: B.body, pA: c.pA, pB: c.pB, n: c.n, depth: c.depth, friction: K.CARCAR_FRICTION, restitution: K.CARCAR_RESTITUTION, kind: 'carCar', carA: A, carB: B });
        }
      }
    }
    const live = contacts.filter((c) => !((c.car && c.car.isDemoed) || (c.carA && (c.carA.isDemoed || c.carB.isDemoed))));
    solveContacts(live, dt);

    // ---- integrate positions ----
    for (const car of this.cars) if (!car.isDemoed) integrateBody(car.body, dt);
    if (!ballSleeping || !bb.vel.isZero() || !bb.angVel.isZero() || !bb.pushVel.isZero()) integrateBody(bb, dt);
    else { bb.pushVel.set(0, 0, 0); bb.turnVel.set(0, 0, 0); }

    // ---- post tick ----
    for (const car of this.cars) {
      car.postTick(this, dt);
      car.finishTick();
      if (!car.isDemoed) for (const p of this.pads) p.checkCollide(car);
    }
    for (const p of this.pads) p.postTick(dt, this.events);
    ball.finishTick();

    if (this.ballTouchedThisTick.length) {
      const dv = bb.vel.sub(ballVelBefore);
      for (const id of this.ballTouchedThisTick) {
        const car = this.getCar(id);
        this.events.push({ type: EV.BALL_HIT, carId: id, team: car.team, impulse: dv.len(), pos: bb.pos.clone(), ballVel: bb.vel.clone() });
      }
    }

    if (!this.goalScored && this.isBallScored()) {
      this.goalScored = { team: bb.pos.y > 0 ? 0 : 1 }; // scoring team: ball in orange goal (+y) -> blue scores
    }

    this.tick++;
    this.time += dt;
  }

  _onCarBallHit(car, c) {
    const bb = this.ball.body;
    const tick = this.tick;
    car.ballHit.tick = tick;
    if (!this.ballTouchedThisTick.includes(car.id)) this.ballTouchedThisTick.push(car.id);
    this.lastTouch = { carId: car.id, team: car.team, tick };
    // extra impulse at most every other tick
    if (tick > car.ballHit.extraTick + 1 || car.ballHit.extraTick > tick) {
      car.ballHit.extraTick = tick;
      const carFwd = car.body.rot.forward;
      const relPos = bb.pos.sub(car.body.pos);
      const relVel = bb.vel.sub(car.body.vel);
      const relSpeed = Math.min(relVel.len(), K.BALL_CAR_EXTRA_IMPULSE_MAXDELTAVEL_UU);
      if (relSpeed > 0) {
        let hitDir = new Vec3(relPos.x, relPos.y, relPos.z * K.BALL_CAR_EXTRA_IMPULSE_Z_SCALE).normalized();
        const adj = carFwd.mul(hitDir.dot(carFwd) * (1 - K.BALL_CAR_EXTRA_IMPULSE_FORWARD_SCALE));
        hitDir = hitDir.sub(adj).normalized();
        const added = hitDir.mul(relSpeed * K.BALL_CAR_EXTRA_IMPULSE_FACTOR_CURVE.get(relSpeed));
        bb.velCache.addSelf(added);
      }
    }
  }

  _onCarCarContact(car1, car2, c) {
    // test both ways (RocketSim _BtCallback_OnCarCarCollision)
    for (let i = 0; i < 2; i++) {
      const A = i === 0 ? car1 : car2, B = i === 0 ? car2 : car1;
      if (A.isDemoed || B.isDemoed) return;
      if (A.carContact.otherCarId === B.id && A.carContact.cooldownTimer > 0) continue;
      const deltaPos = B.body.pos.sub(A.body.pos);
      if (A.body.vel.dot(deltaPos) <= 0) continue;
      const velDir = A.body.vel.normalized();
      const dirToOther = deltaPos.normalized();
      const speedTowards = A.body.vel.dot(dirToOther);
      const otherAway = B.body.vel.dot(velDir);
      if (speedTowards <= otherAway) continue;
      // contact point on A in A's local frame
      const pOnA = i === 0 ? c.pA : c.pB;
      const local = A.body.rot.mulVecT(pOnA.sub(A.body.pos));
      if (local.x <= K.BUMP_MIN_FORWARD_DIST) continue;
      let isDemo = A.isSupersonic && this.demosEnabled;
      if (isDemo && A.team === B.team) isDemo = false;
      if (isDemo) {
        this.demolish(B, A);
      } else {
        const groundHit = B.isOnGround;
        const baseScale = (groundHit ? K.BUMP_VEL_AMOUNT_GROUND_CURVE : K.BUMP_VEL_AMOUNT_AIR_CURVE).get(speedTowards);
        const hitUp = B.isOnGround ? B.body.rot.up : new Vec3(0, 0, 1);
        const imp = velDir.mul(baseScale).add(hitUp.mul(K.BUMP_UPWARD_VEL_AMOUNT_CURVE.get(speedTowards)));
        B.body.velCache.addSelf(imp);
        this.events.push({ type: EV.CAR_BUMP, attackerId: A.id, victimId: B.id, pos: pOnA.clone(), speed: speedTowards });
      }
      A.carContact.otherCarId = B.id;
      A.carContact.cooldownTimer = K.BUMP_COOLDOWN_TIME;
    }
  }

  // Serializable snapshot for replays / interpolation
  snapshot() {
    return {
      tick: this.tick,
      ball: { pos: this.ball.body.pos.clone(), vel: this.ball.body.vel.clone(), angVel: this.ball.body.angVel.clone(), rot: this.ball.body.rot.clone() },
      cars: this.cars.map((c) => ({
        id: c.id, pos: c.body.pos.clone(), vel: c.body.vel.clone(), angVel: c.body.angVel.clone(), rot: c.body.rot.clone(),
        boost: c.boost, isBoosting: c.isBoosting, isSupersonic: c.isSupersonic, isDemoed: c.isDemoed, isOnGround: c.isOnGround,
        handbrakeVal: c.handbrakeVal, steer: c.wheels[0].steerAngle,
        wheels: c.wheels.map((w) => ({ suspLen: w.suspLen, spin: w.spin, contact: w.isInContact })),
      })),
      pads: this.pads.map((p) => p.isActive),
    };
  }
}
