// Ball: sphere rigid body (RocketSim Ball.cpp port, soccar only).
import { Vec3, RotMat } from './math.js';
import { RigidBody, ballWorldContact, solveContacts, integrateBody } from './physics.js';
import * as K from './const.js';

export class Ball {
  constructor() {
    const r = K.BALL_RADIUS, m = K.BALL_MASS;
    const I = 0.4 * m * r * r; // btSphereShape::calculateLocalInertia
    this.body = new RigidBody(m, new Vec3(I, I, I));
    this.radius = r;
    this.reset();
  }
  reset(x = 0, y = 0, z = K.BALL_KICKOFF_Z) {
    const b = this.body;
    b.pos.set(x, y, z);
    b.vel.set(0, 0, 0);
    b.angVel.set(0, 0, 0);
    b.rot = new RotMat();
    b.velCache.set(0, 0, 0);
    b.force.set(0, 0, 0);
  }
  get pos() { return this.body.pos; }
  get vel() { return this.body.vel; }
  get angVel() { return this.body.angVel; }
  get rot() { return this.body.rot; }

  isSleeping() { const b = this.body; return b.vel.len2() === 0 && b.angVel.len2() === 0; }

  // Velocity integration part of btRigidBody (gravity + damping); sleeping ball stays put
  integrateVelocity(dt) {
    const b = this.body;
    b.vel.z += K.GRAVITY_Z * dt;
    b.vel.addScaledSelf(b.force, b.invMass * dt);
    b.force.set(0, 0, 0);
    b.vel.mulSelf(Math.pow(1 - K.BALL_DRAG, dt));
  }

  worldContact() {
    const b = this.body;
    const c = ballWorldContact(b, K.BALL_RADIUS, K.BALL_REST_Z, 0.05);
    if (!c) return null;
    return {
      a: b, b: null, pA: c.pA, pB: c.pA, n: c.n, depth: c.depth,
      friction: K.BALL_FRICTION, restitution: K.BALL_RESTITUTION, kind: 'ballWorld',
    };
  }

  finishTick() {
    const b = this.body;
    if (!b.velCache.isZero()) { b.vel.addSelf(b.velCache); b.velCache.set(0, 0, 0); }
    const v2 = b.vel.len2();
    if (v2 > K.BALL_MAX_SPEED ** 2) b.vel.mulSelf(K.BALL_MAX_SPEED / Math.sqrt(v2));
    const w2 = b.angVel.len2();
    if (w2 > K.BALL_MAX_ANG_SPEED ** 2) b.angVel.mulSelf(K.BALL_MAX_ANG_SPEED / Math.sqrt(w2));
  }
}

// Ball-only step (same code path as the full world for ball vs arena) — used for
// prediction. `ballLike` = {pos, vel, angVel} plain object copy is advanced in place.
export class BallPredictor {
  constructor() { this.ball = new Ball(); }
  // returns array of {t, pos:{x,y,z}, vel:{x,y,z}} sampled every `every` ticks
  predict(state, seconds = 6, every = 1) {
    const ball = this.ball, b = ball.body;
    b.pos.copy(state.pos); b.vel.copy(state.vel); b.angVel.copy(state.angVel);
    b.velCache.set(0, 0, 0); b.force.set(0, 0, 0);
    const dt = K.TICK_TIME;
    const n = Math.round(seconds / dt);
    const out = [];
    for (let i = 1; i <= n; i++) {
      stepBallAlone(ball, dt);
      if (i % every === 0) out.push({ t: i * dt, pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z }, vel: { x: b.vel.x, y: b.vel.y, z: b.vel.z } });
    }
    return out;
  }
}

export function stepBallAlone(ball, dt) {
  const b = ball.body;
  if (b.vel.len2() === 0 && b.angVel.len2() === 0) return;
  ball.integrateVelocity(dt);
  const c = ball.worldContact();
  if (c) solveContacts([c], dt);
  integrateBody(b, dt);
  ball.finishTick();
}
