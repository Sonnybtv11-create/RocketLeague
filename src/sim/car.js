// Car simulation: port of RocketSim Car.cpp + btVehicleRL.cpp (MIT, ZealanL).
// Units: uu, s, rad. Forces in kg·uu/s² (see const.js header).

import { Vec3, RotMat, rotMatFromYPR, yprFromRotMat, clamp, sgn } from './math.js';
import { RigidBody, raySphere, rayCarBox } from './physics.js';
import { arenaRaycast } from './arena.js';
import { CAR_CONFIGS, wheelLayout } from './carconfig.js';
import * as K from './const.js';
import { makeControls, EV } from '../contracts.js';

const UP = new Vec3(0, 0, 1);
const _hitN = new Vec3();

export class Car {
  constructor({ id, team, hitbox = 'OCTANE', name = 'Player', isBot = false, bodyId = 'vector' }) {
    this.id = id;
    this.team = team;
    this.name = name;
    this.isBot = isBot;
    this.bodyId = bodyId;
    this.hitbox = hitbox;
    this.config = CAR_CONFIGS[hitbox];
    const s = this.config.hitboxSize;
    this.halfSize = new Vec3(s.x / 2, s.y / 2, s.z / 2);
    const m = K.CAR_MASS;
    // btBoxShape::calculateLocalInertia
    const inertia = new Vec3(
      m / 12 * (s.y * s.y + s.z * s.z),
      m / 12 * (s.x * s.x + s.z * s.z),
      m / 12 * (s.x * s.x + s.y * s.y));
    this.body = new RigidBody(m, inertia);
    this.wheelDefs = wheelLayout(this.config);
    this.wheels = this.wheelDefs.map((d) => ({
      def: d,
      // ray cast info
      isInContact: false, isWorld: false, groundBody: null,
      hardPoint: new Vec3(), contactPoint: new Vec3(), contactNormal: new Vec3(0, 0, 1),
      suspLen: d.restLen, suspRelVel: 0, clippedInv: 1, extraPushback: 0,
      // wheel basis (steered), world space
      wFwd: new Vec3(1, 0, 0), wRight: new Vec3(0, 1, 0), wUp: new Vec3(0, 0, 1),
      steerAngle: 0, engineForce: 0, brake: 0, latFriction: 1, longFriction: 1,
      impulse: new Vec3(), suspForce: 0,
      // render-only
      spin: 0,
    }));
    this.controls = makeControls();
    this.lastControls = makeControls();
    this.resetState();
  }

  resetState() {
    this.boost = K.BOOST_SPAWN_AMOUNT;
    this.isOnGround = true;
    this.isJumping = false; this.hasJumped = false; this.jumpTime = 0;
    this.hasDoubleJumped = false; this.hasFlipped = false; this.isFlipping = false;
    this.flipTime = 0; this.flipRelTorque = new Vec3();
    this.airTime = 0; this.airTimeSinceJump = 0;
    this.isAutoFlipping = false; this.autoFlipTimer = 0; this.autoFlipTorqueScale = 0;
    this.handbrakeVal = 0;
    this.isBoosting = false; this.boostingTime = 0; this.timeSinceBoosted = 0;
    this.isSupersonic = false; this.supersonicTime = 0;
    this.worldContact = { hasContact: false, normal: new Vec3(0, 0, 1) };
    this.carContact = { otherCarId: -1, cooldownTimer: 0 };
    this.isDemoed = false; this.demoRespawnTimer = 0;
    this.ballHit = { tick: -10, extraTick: -10 };
    this.wheelsWithContact = [false, false, false, false];
    this.numWheelsInContact = 4;
    this.forwardSpeed = 0;
    this.lastLandTick = -100;
    for (const w of this.wheels || []) { w.steerAngle = 0; w.engineForce = 0; w.brake = 0; w.impulse.set(0, 0, 0); w.isInContact = false; }
    this.body.vel.set(0, 0, 0); this.body.angVel.set(0, 0, 0);
    this.body.velCache.set(0, 0, 0); this.body.force.set(0, 0, 0); this.body.angAccel.set(0, 0, 0);
  }

  setSpawn(x, y, z, yaw, boost = K.BOOST_SPAWN_AMOUNT) {
    this.resetState();
    this.body.pos.set(x, y, z);
    this.body.rot = rotMatFromYPR(yaw, 0, 0);
    this.boost = boost;
    this.isOnGround = true;
    this.controls = makeControls();
    this.lastControls = makeControls();
  }

  get pos() { return this.body.pos; }
  get vel() { return this.body.vel; }
  get angVel() { return this.body.angVel; }
  get rot() { return this.body.rot; }
  get forward() { return this.body.rot.forward; }
  get right() { return this.body.rot.right; }
  get up() { return this.body.rot.up; }

  // ---------------------------------------------------------------- btVehicleRL
  _updateWheelTransforms() {
    const b = this.body, R = b.rot;
    const f = R.forward, r = R.right, u = R.up;
    for (const w of this.wheels) {
      w.hardPoint = b.pos.add(R.mulVec(w.def.offset));
      const c = Math.cos(w.steerAngle), s = Math.sin(w.steerAngle);
      w.wFwd = f.mul(c).add(r.mul(s));
      w.wRight = r.mul(c).sub(f.mul(s));
      w.wUp = u;
    }
  }

  _rayCast(w, world) {
    const b = this.body;
    const up = b.rot.up;
    const dir = up.neg();
    const travel = K.MAX_SUSPENSION_TRAVEL;
    const restLen = w.def.restLen;
    const rayLen = restLen + travel + w.def.radius - K.SUSPENSION_SUBTRACTION;
    const src = w.hardPoint;
    w.isInContact = false; w.isWorld = false; w.groundBody = null;
    // nearest hit among arena, ball, other cars
    let bestT = -1, bestN = null, bestBody = null, isWorld = false;
    const tw = arenaRaycast(src.x, src.y, src.z, dir.x, dir.y, dir.z, rayLen, _hitN);
    if (tw >= 0) { bestT = tw; bestN = new Vec3(_hitN.x, _hitN.y, _hitN.z); isWorld = true; }
    if (world.ball) {
      const tb = raySphere(src, dir, world.ball.body.pos, K.BALL_RADIUS, rayLen);
      if (tb >= 0 && (bestT < 0 || tb < bestT)) {
        bestT = tb; bestBody = world.ball.body; isWorld = false;
        bestN = src.add(dir.mul(tb)).sub(world.ball.body.pos).normalized();
      }
    }
    for (const oc of world.cars) {
      if (oc === this || oc.isDemoed) continue;
      if (oc.body.pos.dist(src) > 200) continue;
      const h = rayCarBox(src, dir, oc, rayLen);
      if (h && (bestT < 0 || h.t < bestT)) { bestT = h.t; bestN = h.n; bestBody = oc.body; isWorld = false; }
    }
    if (bestT >= 0) {
      w.contactPoint = src.add(dir.mul(bestT));
      w.contactNormal = bestN;
      w.isInContact = true;
      w.isWorld = isWorld;
      w.groundBody = bestBody; // null = static world
      const traceLen = src.sub(w.contactPoint).dot(up);
      w.suspLen = clamp(traceLen - w.def.radius, restLen - travel, restLen + travel);
      const denom = bestN.dot(up);
      const relpos = w.contactPoint.sub(b.pos);
      const velAt = b.velAt(relpos);
      const projVel = bestN.dot(velAt);
      if (denom > 0.1) {
        const inv = 1 / denom;
        w.suspRelVel = projVel * inv;
        w.clippedInv = inv;
      } else {
        w.suspRelVel = 0;
        w.clippedInv = 10;
      }
      w.extraPushback = 0;
      if (isWorld) {
        const thresh = restLen + w.def.radius - K.SUSPENSION_SUBTRACTION;
        if (traceLen < thresh) {
          const dist = traceLen - thresh;
          // resolveSingleCollision (applyImpulses = false), world is static
          const relVel = bestN.dot(velAt);
          const posErr = K.SOLVER_ERP * -dist / K.TICK_TIME;
          const velErr = -relVel;
          const den = b.impulseDenom(relpos, bestN);
          let imp = (posErr + velErr) / den;
          if (imp < 0) imp = 0;
          w.extraPushback = imp / 4;
        }
      }
    } else {
      w.suspLen = restLen + travel;
      w.suspRelVel = 0;
      w.contactNormal = up;
      w.clippedInv = 1;
      w.extraPushback = 0;
    }
  }

  _calcFrictionImpulses(dt) {
    const b = this.body;
    const frictionScale = b.mass / 3;
    for (const w of this.wheels) {
      if (!w.isInContact) { w.impulse = new Vec3(); continue; }
      const g = w.groundBody; // null = static
      const n = w.contactNormal;
      let axle = w.wRight;
      axle = axle.sub(n.mul(axle.dot(n))).normalized();
      const fwd = n.cross(axle).normalized();
      // resolveSingleBilateral
      const relA = w.contactPoint.sub(b.pos);
      const velA = b.velAt(relA);
      let velB = new Vec3(), denB = 0;
      if (g) {
        const relB = w.contactPoint.sub(g.pos);
        velB = g.velAt(relB);
        denB = g.impulseDenom(relB, axle);
      }
      const jac = b.impulseDenom(relA, axle) + denB;
      const relVelSide = axle.dot(velA.sub(velB));
      const sideImpulse = -0.2 * relVelSide / jac;

      let rolling;
      if (w.engineForce === 0) {
        if (w.brake) {
          const v1 = b.velAt(relA);
          const v2 = g ? g.velAt(relA) : new Vec3(); // (sic) RocketSim uses car-relative point
          const relVel = v1.sub(v2).dot(fwd);
          rolling = clamp(-relVel * K.ROLLING_FRICTION_SCALE_MAGIC, -w.brake, w.brake);
        } else rolling = 0;
      } else {
        rolling = -w.engineForce / frictionScale;
      }
      w.impulse = fwd.mul(rolling * w.longFriction).add(axle.mul(sideImpulse * w.latFriction)).mul(frictionScale);
    }
  }

  _updateSuspension(dt) {
    const b = this.body;
    for (const w of this.wheels) {
      if (w.isInContact) {
        let force = (w.def.restLen - w.suspLen) * K.SUSPENSION_STIFFNESS * w.clippedInv;
        const damp = w.suspRelVel < 0 ? K.WHEELS_DAMPING_COMPRESSION : K.WHEELS_DAMPING_RELAXATION;
        force -= damp * w.suspRelVel;
        force *= w.def.front ? K.SUSPENSION_FORCE_SCALE_FRONT : K.SUSPENSION_FORCE_SCALE_BACK;
        if (force < 0) force = 0;
        w.suspForce = force;
      } else w.suspForce = 0;
    }
    for (const w of this.wheels) {
      if (w.suspForce !== 0) {
        const off = w.contactPoint.sub(b.pos);
        const mag = w.suspForce * dt + w.extraPushback;
        b.applyImpulse(w.contactNormal.mul(mag), off);
      }
    }
  }

  _applyFrictionImpulses(dt) {
    const b = this.body;
    const up = b.rot.up;
    for (const w of this.wheels) {
      if (w.impulse.isZero()) continue;
      const off = w.contactPoint.sub(b.pos);
      const rel = off.sub(up.mul(up.dot(off)));
      b.applyImpulse(w.impulse.mul(dt), rel);
    }
  }

  _upwardsDirFromWheelContacts() {
    let s = new Vec3();
    for (const w of this.wheels) if (w.isInContact) s = s.add(w.contactNormal);
    if (s.isZero()) return this.body.rot.up;
    return s.normalized();
  }

  // --------------------------------------------------------------- pre tick
  preTick(world, dt) {
    const ev = world.events;
    if (this.isDemoed) {
      this.demoRespawnTimer = Math.max(this.demoRespawnTimer - dt, 0);
      if (this.demoRespawnTimer === 0) world.respawnCar(this);
      return;
    }
    const c = this.controls;
    const b = this.body;

    // updateVehicleFirst
    this._updateWheelTransforms();
    for (const w of this.wheels) this._rayCast(w, world);
    this._calcFrictionImpulses(dt);

    const jumpPressed = c.jump && !this.lastControls.jump;

    let numWheels = 0;
    for (let i = 0; i < 4; i++) {
      this.wheelsWithContact[i] = this.wheels[i].isInContact;
      numWheels += this.wheels[i].isInContact ? 1 : 0;
    }
    const wasOnGround = this.isOnGround;
    const prevWheels = this.numWheelsInContact;
    this.isOnGround = numWheels >= 3;
    this.numWheelsInContact = numWheels;
    if (numWheels > 0 && prevWheels === 0 && world.tick - this.lastLandTick > 12) {
      this.lastLandTick = world.tick;
      ev.push({ type: EV.LAND, carId: this.id, speed: Math.abs(b.vel.dot(this._upwardsDirFromWheelContacts())), pos: b.pos.clone() });
    }

    const forwardSpeed = b.vel.dot(b.rot.forward);
    this.forwardSpeed = forwardSpeed;
    this._updateWheels(dt, numWheels, forwardSpeed);

    if (numWheels < 3) this._updateAirTorque(dt, numWheels === 0);
    else this.isFlipping = false;

    this._updateJump(dt, jumpPressed, ev);
    this._updateAutoFlip(dt, jumpPressed);
    this._updateDoubleJumpOrFlip(dt, jumpPressed, forwardSpeed, ev);

    if (c.throttle && ((numWheels > 0 && numWheels < 4) || this.worldContact.hasContact))
      this._updateAutoRoll(dt, numWheels);

    this.worldContact.hasContact = false;

    // updateVehicleSecond
    this._updateSuspension(dt);
    this._applyFrictionImpulses(dt);

    this._updateBoost(dt, ev, world);

    // render-only wheel spin
    for (const w of this.wheels) {
      const sp = w.isInContact ? b.velAt(w.hardPoint.sub(b.pos)).dot(w.wFwd) : forwardSpeed * 0.98;
      w.spin += (sp / w.def.radius) * dt;
    }
  }

  _updateWheels(dt, numWheels, forwardSpeed) {
    const c = this.controls, b = this.body;
    const absFwd = Math.abs(forwardSpeed);
    let wheelsHaveWorldContact = false;
    for (const w of this.wheels) wheelsHaveWorldContact = wheelsHaveWorldContact || (w.isInContact && w.isWorld);

    this.handbrakeVal += (c.handbrake ? K.POWERSLIDE_RISE_RATE : -K.POWERSLIDE_FALL_RATE) * dt;
    this.handbrakeVal = clamp(this.handbrakeVal, 0, 1);

    let realThrottle = c.throttle;
    let realBrake = 0;
    if (c.boost && this.boost > 0) realThrottle = 1;

    {
      let driveSpeedScale = K.DRIVE_SPEED_TORQUE_FACTOR_CURVE.get(absFwd);
      let engineThrottle = realThrottle;
      if (c.handbrake) {
        // unchanged
      } else {
        const absThrottle = Math.abs(realThrottle);
        if (absThrottle >= K.THROTTLE_DEADZONE) {
          if (absFwd > K.STOPPING_FORWARD_VEL && sgn(realThrottle) !== sgn(forwardSpeed)) {
            realBrake = 1;
            if (absFwd > K.BRAKING_NO_THROTTLE_SPEED_THRESH) engineThrottle = 0;
          }
        } else {
          engineThrottle = 0;
          realBrake = absFwd < K.STOPPING_FORWARD_VEL ? 1 : K.COASTING_BRAKE_FACTOR;
        }
      }
      if (numWheels < 3) driveSpeedScale /= 4;
      const engineForce = engineThrottle * K.THROTTLE_TORQUE_AMOUNT * driveSpeedScale;
      const brakeForce = realBrake * K.BRAKE_TORQUE_AMOUNT;
      for (const w of this.wheels) { w.engineForce = engineForce; w.brake = brakeForce; }
    }

    {
      let steerAngle = K.STEER_ANGLE_FROM_SPEED_CURVE.get(absFwd);
      if (this.handbrakeVal) {
        steerAngle += (K.POWERSLIDE_STEER_ANGLE_FROM_SPEED_CURVE.get(absFwd) - steerAngle) * this.handbrakeVal;
      }
      steerAngle *= c.steer;
      this.wheels[0].steerAngle = steerAngle;
      this.wheels[1].steerAngle = steerAngle;
    }

    for (const w of this.wheels) {
      if (!w.isInContact) continue;
      const latDir = w.wRight;
      const longDir = latDir.cross(w.contactNormal);
      let frictionCurveInput = 0;
      const wheelDelta = w.hardPoint.sub(b.pos);
      const crossVec = b.angVel.cross(wheelDelta).add(b.vel);
      const baseFriction = Math.abs(crossVec.dot(latDir));
      if (baseFriction > 5) frictionCurveInput = baseFriction / (Math.abs(crossVec.dot(longDir)) + baseFriction);
      let latFriction = K.LAT_FRICTION_CURVE.get(frictionCurveInput);
      let longFriction = K.LONG_FRICTION_CURVE.get(frictionCurveInput);
      if (this.handbrakeVal) {
        const hb = this.handbrakeVal;
        latFriction *= (K.HANDBRAKE_LAT_FRICTION_FACTOR_CURVE.get(frictionCurveInput) - 1) * hb + 1;
        longFriction *= (K.HANDBRAKE_LONG_FRICTION_FACTOR_CURVE.get(frictionCurveInput) - 1) * hb + 1;
      } else {
        longFriction = 1;
      }
      if (realThrottle === 0) {
        const ns = K.NON_STICKY_FRICTION_FACTOR_CURVE.get(w.contactNormal.z);
        latFriction *= ns; longFriction *= ns;
      }
      w.latFriction = latFriction;
      w.longFriction = longFriction;
    }

    if (wheelsHaveWorldContact) {
      const upwardsDir = this._upwardsDirFromWheelContacts();
      const fullStick = realThrottle !== 0 || absFwd > K.STOPPING_FORWARD_VEL;
      let stickyForceScale = 0.5;
      if (fullStick) stickyForceScale += 1 - Math.abs(upwardsDir.z);
      b.applyCentralForce(upwardsDir.mul(stickyForceScale * K.GRAVITY_Z * K.CAR_MASS));
    }
  }

  _updateBoost(dt, ev, world) {
    const c = this.controls, b = this.body;
    const wasBoosting = this.isBoosting;
    if (world.unlimitedBoost && !this.isBot) this.boost = 100;
    if (this.boost > 0) {
      if (this.isBoosting) this.isBoosting = c.boost || this.boostingTime < K.BOOST_MIN_TIME;
      else if (c.boost) this.isBoosting = true;
    } else this.isBoosting = false;
    if (this.isBoosting) this.boostingTime += dt; else this.boostingTime = 0;
    if (this.isBoosting) {
      this.boost = Math.max(this.boost - K.BOOST_USED_PER_SECOND * dt, 0);
      const acc = this.isOnGround ? K.BOOST_ACCEL_GROUND : K.BOOST_ACCEL_AIR;
      b.applyCentralForce(b.rot.forward.mul(acc * K.CAR_MASS));
      this.timeSinceBoosted = 0;
    } else this.timeSinceBoosted += dt;
    this.boost = Math.min(this.boost, K.BOOST_MAX);
    if (this.isBoosting && !wasBoosting) ev.push({ type: EV.BOOST_START, carId: this.id });
    if (!this.isBoosting && wasBoosting) ev.push({ type: EV.BOOST_END, carId: this.id });
  }

  _updateJump(dt, jumpPressed, ev) {
    const b = this.body;
    if (this.isOnGround && !this.isJumping) {
      if (this.hasJumped && this.jumpTime < K.JUMP_MIN_TIME + K.JUMP_RESET_TIME_PAD) {
        // still leaving the ground
      } else {
        this.hasJumped = false;
        this.jumpTime = 0;
      }
    }
    if (this.isJumping) {
      this.isJumping = this.jumpTime < K.JUMP_MIN_TIME || (this.controls.jump && this.jumpTime < K.JUMP_MAX_TIME);
    } else if (this.isOnGround && jumpPressed) {
      this.isJumping = true;
      this.jumpTime = 0;
      b.applyCentralImpulse(b.rot.up.mul(K.JUMP_IMMEDIATE_FORCE * K.CAR_MASS));
      ev.push({ type: EV.JUMP, carId: this.id, pos: b.pos.clone() });
    }
    if (this.isJumping) {
      this.hasJumped = true;
      let f = K.JUMP_ACCEL;
      if (this.jumpTime < K.JUMP_MIN_TIME) f *= K.JUMP_PRE_MIN_ACCEL_SCALE;
      b.applyCentralForce(b.rot.up.mul(f * K.CAR_MASS));
    }
    if (this.isJumping || this.hasJumped) this.jumpTime += dt;
  }

  _updateAirTorque(dt, updateAirControl) {
    const c = this.controls, b = this.body;
    const R = b.rot;
    const dirPitch = R.right.neg(), dirYaw = R.up, dirRoll = R.forward.neg();
    let doAirControl = false;
    if (this.isFlipping) this.isFlipping = this.hasFlipped && this.flipTime < K.FLIP_TORQUE_TIME;
    if (this.isFlipping) {
      const rel = this.flipRelTorque.clone();
      if (!rel.isZero()) {
        let pitchScale = 1;
        if (rel.y !== 0 && c.pitch !== 0) {
          if (sgn(rel.y) === sgn(c.pitch)) {
            pitchScale = 1 - Math.min(Math.abs(c.pitch), 1);
            doAirControl = true;
          }
        }
        rel.y *= pitchScale;
        const local = new Vec3(rel.x * K.FLIP_TORQUE_X, rel.y * K.FLIP_TORQUE_Y, 0);
        b.angVel.addSelf(R.mulVec(local).mul(dt));
      } else {
        doAirControl = true; // stall
      }
    } else doAirControl = true;

    doAirControl = doAirControl && !this.isAutoFlipping && updateAirControl;
    if (doAirControl) {
      let pitchTorqueScale = 1;
      let torque = new Vec3();
      if (c.pitch || c.yaw || c.roll) {
        if (this.isFlipping) pitchTorqueScale = 0;
        else if (this.hasFlipped) {
          if (this.flipTime < K.FLIP_TORQUE_TIME + K.FLIP_PITCHLOCK_EXTRA_TIME) pitchTorqueScale = 0;
        }
        torque = dirPitch.mul(c.pitch * pitchTorqueScale * K.CAR_AIR_CONTROL_TORQUE.pitch)
          .add(dirYaw.mul(c.yaw * K.CAR_AIR_CONTROL_TORQUE.yaw))
          .add(dirRoll.mul(c.roll * K.CAR_AIR_CONTROL_TORQUE.roll));
      }
      const w = b.angVel;
      const dampPitch = dirPitch.dot(w) * K.CAR_AIR_CONTROL_DAMPING.pitch * (1 - Math.abs(c.pitch * pitchTorqueScale));
      const dampYaw = dirYaw.dot(w) * K.CAR_AIR_CONTROL_DAMPING.yaw * (1 - Math.abs(c.yaw));
      const dampRoll = dirRoll.dot(w) * K.CAR_AIR_CONTROL_DAMPING.roll;
      const damping = dirYaw.mul(dampYaw).add(dirPitch.mul(dampPitch)).add(dirRoll.mul(dampRoll));
      b.angVel.addSelf(torque.sub(damping).mul(K.CAR_TORQUE_SCALE * dt));
    }
    if (c.throttle !== 0) b.applyCentralForce(R.forward.mul(c.throttle * K.THROTTLE_AIR_ACCEL * K.CAR_MASS));
  }

  _updateDoubleJumpOrFlip(dt, jumpPressed, forwardSpeed, ev) {
    const c = this.controls, b = this.body;
    const tickTimeScale = dt / (1 / 120);
    if (this.isOnGround) {
      this.hasDoubleJumped = false;
      this.hasFlipped = false;
      this.airTime = 0;
      this.airTimeSinceJump = 0;
      this.flipTime = 0;
    } else {
      this.airTime += dt;
      if (this.hasJumped && !this.isJumping) this.airTimeSinceJump += dt;
      else this.airTimeSinceJump = 0;

      if (jumpPressed && this.airTimeSinceJump < K.DOUBLEJUMP_MAX_DELAY) {
        const inputMag = Math.abs(c.yaw) + Math.abs(c.pitch) + Math.abs(c.roll);
        const isFlipInput = inputMag >= (this.dodgeDeadzone ?? this.config.dodgeDeadzone);
        let canUse = !this.hasDoubleJumped && !this.hasFlipped;
        if (this.isAutoFlipping) canUse = false;
        if (canUse) {
          if (isFlipInput) {
            this.flipTime = 0;
            this.hasFlipped = true;
            this.isFlipping = true;
            const forwardSpeedRatio = Math.abs(forwardSpeed) / K.CAR_MAX_SPEED;
            let dodgeDir = new Vec3(-c.pitch, c.yaw + c.roll, 0);
            if (Math.abs(c.yaw + c.roll) < 0.1 && Math.abs(c.pitch) < 0.1) dodgeDir = new Vec3();
            else dodgeDir = dodgeDir.normalized();
            this.flipRelTorque = new Vec3(-dodgeDir.y / tickTimeScale, dodgeDir.x / tickTimeScale, 0);
            if (Math.abs(dodgeDir.x) < 0.1) dodgeDir.x = 0;
            if (Math.abs(dodgeDir.y) < 0.1) dodgeDir.y = 0;
            if (Math.abs(dodgeDir.x) > 1e-6 || Math.abs(dodgeDir.y) > 1e-6) {
              let backwards;
              if (Math.abs(forwardSpeed) < 100) backwards = dodgeDir.x < 0;
              else backwards = (dodgeDir.x >= 0) !== (forwardSpeed >= 0);
              const init = dodgeDir.mul(K.FLIP_INITIAL_VEL_SCALE);
              const maxSpeedScaleX = backwards ? K.FLIP_BACKWARD_IMPULSE_MAX_SPEED_SCALE : K.FLIP_FORWARD_IMPULSE_MAX_SPEED_SCALE;
              init.x *= ((maxSpeedScaleX - 1) * forwardSpeedRatio) + 1;
              init.y *= ((K.FLIP_SIDE_IMPULSE_MAX_SPEED_SCALE - 1) * forwardSpeedRatio) + 1;
              if (backwards) init.x *= K.FLIP_BACKWARD_IMPULSE_SCALE_X;
              const f2 = b.rot.forward.to2D().normalized();
              const r2 = new Vec3(-f2.y, f2.x, 0);
              const dv = f2.mul(init.x).add(r2.mul(init.y));
              b.applyCentralImpulse(dv.mul(K.CAR_MASS));
            }
            ev.push({ type: EV.DODGE, carId: this.id, dir: { x: dodgeDir.x, y: dodgeDir.y }, pos: b.pos.clone() });
          } else {
            b.applyCentralImpulse(b.rot.up.mul(K.JUMP_IMMEDIATE_FORCE * K.CAR_MASS));
            this.hasDoubleJumped = true;
            ev.push({ type: EV.DOUBLE_JUMP, carId: this.id, pos: b.pos.clone() });
          }
        }
      }
    }
    if (this.isFlipping) {
      this.flipTime += dt;
      if (this.flipTime <= K.FLIP_TORQUE_TIME) {
        if (this.flipTime >= K.FLIP_Z_DAMP_START && (b.vel.z < 0 || this.flipTime < K.FLIP_Z_DAMP_END)) {
          b.vel.z *= Math.pow(1 - K.FLIP_Z_DAMP_120, tickTimeScale);
        }
      }
    } else if (this.hasFlipped) {
      this.flipTime += dt;
    }
  }

  _updateAutoFlip(dt, jumpPressed) {
    const b = this.body;
    if (jumpPressed && this.worldContact.hasContact && this.worldContact.normal.z > K.CAR_AUTOFLIP_NORMZ_THRESH) {
      const ang = yprFromRotMat(b.rot);
      const absRoll = Math.abs(ang.roll);
      if (absRoll > K.CAR_AUTOFLIP_ROLL_THRESH) {
        this.autoFlipTimer = K.CAR_AUTOFLIP_TIME * (absRoll / Math.PI);
        this.autoFlipTorqueScale = ang.roll > 0 ? 1 : -1;
        this.isAutoFlipping = true;
        b.applyCentralImpulse(b.rot.up.mul(-K.CAR_AUTOFLIP_IMPULSE * K.CAR_MASS));
      }
    }
    if (this.isAutoFlipping) {
      if (this.autoFlipTimer <= 0) {
        this.isAutoFlipping = false;
        this.autoFlipTimer = 0;
      } else {
        b.angVel.addSelf(b.rot.forward.mul(K.CAR_AUTOFLIP_TORQUE * this.autoFlipTorqueScale * dt));
        this.autoFlipTimer -= dt;
      }
    }
  }

  _updateAutoRoll(dt, numWheels) {
    const b = this.body;
    const groundUp = numWheels > 0 ? this._upwardsDirFromWheelContacts() : this.worldContact.normal;
    const groundDown = groundUp.neg();
    const f = b.rot.forward, r = b.rot.right;
    const crossRight = groundUp.cross(f);
    const crossForward = groundDown.cross(crossRight);
    const rightTorqueFactor = 1 - clamp(r.dot(crossRight), 0, 1);
    const forwardTorqueFactor = 1 - clamp(f.dot(crossForward), 0, 1);
    const torqueDirRight = f.mul(r.dot(groundUp) >= 0 ? -1 : 1);
    const torqueDirForward = r.mul(f.dot(groundUp) >= 0 ? 1 : -1);
    const torque = torqueDirForward.mul(forwardTorqueFactor).add(torqueDirRight.mul(rightTorqueFactor));
    b.applyCentralForce(groundDown.mul(K.CAR_AUTOROLL_FORCE * K.CAR_MASS));
    b.angVel.addSelf(torque.mul(K.CAR_AUTOROLL_TORQUE * dt));
  }

  // -------------------------------------------------------------- post tick
  postTick(world, dt) {
    if (this.isDemoed) return;
    const b = this.body;
    const speed2 = b.vel.len2();
    const wasSS = this.isSupersonic;
    if (this.isSupersonic && this.supersonicTime < K.SUPERSONIC_MAINTAIN_MAX_TIME)
      this.isSupersonic = speed2 >= K.SUPERSONIC_MAINTAIN_MIN_SPEED ** 2;
    else this.isSupersonic = speed2 >= K.SUPERSONIC_START_SPEED ** 2;
    if (this.isSupersonic) this.supersonicTime += dt; else this.supersonicTime = 0;
    if (this.isSupersonic && !wasSS) world.events.push({ type: EV.SUPERSONIC_START, carId: this.id });
    if (this.carContact.cooldownTimer > 0) this.carContact.cooldownTimer = Math.max(this.carContact.cooldownTimer - dt, 0);
    this.lastControls = { ...this.controls };
  }

  finishTick() {
    if (this.isDemoed) return;
    const b = this.body;
    if (!b.velCache.isZero()) { b.vel.addSelf(b.velCache); b.velCache.set(0, 0, 0); }
    const v2 = b.vel.len2();
    if (v2 > K.CAR_MAX_SPEED ** 2) b.vel.mulSelf(K.CAR_MAX_SPEED / Math.sqrt(v2));
    const w2 = b.angVel.len2();
    if (w2 > K.CAR_MAX_ANG_SPEED ** 2) b.angVel.mulSelf(K.CAR_MAX_ANG_SPEED / Math.sqrt(w2));
  }

  // Convenience for bots / UI
  hasFlipOrJump() {
    return this.isOnGround || (!this.hasFlipped && !this.hasDoubleJumped && this.airTimeSinceJump < K.DOUBLEJUMP_MAX_DELAY);
  }
  hasFlipReset() { return !this.isOnGround && this.hasFlipOrJump() && !this.hasJumped; }
}
