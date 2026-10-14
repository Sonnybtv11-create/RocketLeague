// TURBO PITCH — bots (owner: bots agent).
// createBot({ difficulty: 'rookie'|'pro'|'allstar', carId, team, rng })
//   -> { tick(world, matchView, dt) -> Controls, events: [], stats, difficulty }
//
// Bots drive the same car simulation with the same Controls as a player; they
// only READ world state (perfect information, like RLBot) and never write it.
//
// Layers:
//   perception  shared incremental ball prediction (predict.js), stale by the
//               difficulty's reaction delay; shared team coordinator (roles,
//               ETAs, kickoff taker) in strategy.js
//   decision    kickoff routine / attack (earliest reachable intercept + shot
//               direction) / support / last-man & shadow defence / saves /
//               boost pads / demos / recovery & unstuck
//   control     ground PD steering, arrival-time throttle & boost, powerslide,
//               reverse, half-flip; maneuvers (mechanics.js) for flips, jump
//               shots, aerials, speed-flips, recovery.
import { makeControls } from '../contracts.js';
import { getTrajectory, TrajView } from './predict.js';
import { tables, jumpTimeTo } from './tables.js';
import {
  clamp, clamp1, dist, carFwd, carUp, localTarget, steerPD, clampToField, FIELD_Y, GOAL_HW,
} from './util.js';
import { Flip, HalfFlip, JumpShot, Aerial, Unstuck, recover, autoFlipInput } from './mechanics.js';
import { coordinator, kickoffTakers, findIntercept, goalThreat, speedForRadius, approachPath, turnRadius, APPROACH_R } from './strategy.js';
import { Kickoff } from './kickoff.js';
import { QuickChat } from './chat.js';

export const SKILLS = {
  rookie: {
    name: 'rookie', delay: 48, aimNoise: 0.28, posNoise: 120, jumpShots: false, doubleJumps: false, aerials: false,
    aerialAcc: 0, aerialMaxZ: 0, aerialDouble: false, dodgeShots: 0.3, speedFlips: false, halfFlip: false,
    frontFlipSpeed: false, demos: false, wall: false, pads: false, boostUse: 0.6, boostMinDist: 2200, maxCut: 0.9,
    rotation: 'basic', kickoff: 'drive', groundSpeed: 1200, handbrakeAngle: 2.3, jumpDodge: false, throttleCap: 1, reverse: true,
    shadow: false, maxSpeedFrac: 1,
  },
  pro: {
    name: 'pro', delay: 24, aimNoise: 0.1, posNoise: 40, jumpShots: true, doubleJumps: true, aerials: true,
    aerialAcc: 1058 * 0.62, aerialMaxZ: 1200, aerialDouble: false, dodgeShots: 0.85, speedFlips: false, halfFlip: false,
    frontFlipSpeed: true, demos: false, wall: false, pads: true, boostUse: 0.9, boostMinDist: 900, maxCut: 1.15,
    rotation: 'basic', kickoff: 'boostflip', groundSpeed: 1500, handbrakeAngle: 1.8, jumpDodge: true, throttleCap: 1, reverse: true,
    shadow: true, maxSpeedFrac: 1,
  },
  allstar: {
    name: 'allstar', delay: 12, aimNoise: 0.025, posNoise: 0, jumpShots: true, doubleJumps: true, aerials: true,
    aerialAcc: 1058 * 0.86, aerialMaxZ: 1900, aerialDouble: true, dodgeShots: 1, speedFlips: true, halfFlip: true,
    frontFlipSpeed: true, demos: true, wall: true, pads: true, boostUse: 1, boostMinDist: 600, maxCut: 1.3,
    rotation: 'full', kickoff: 'speedflip', groundSpeed: 1700, handbrakeAngle: 1.6, jumpDodge: true, throttleCap: 1, reverse: true,
    shadow: true, maxSpeedFrac: 1,
  },
};

let botCount = 0;
const DEBUG_STUCK = typeof process !== 'undefined' && process.env && process.env.DEBUG_STUCK;


class Bot {
  constructor({ difficulty = 'pro', carId, team, rng }) {
    this.difficulty = SKILLS[difficulty] ? difficulty : 'pro';
    this.skill = SKILLS[this.difficulty];
    this.carId = carId;
    this.team = team;
    this.s = team === 0 ? 1 : -1;            // attack direction along y
    this.rng = rng || Math.random;
    this.events = [];
    this.traj = new TrajView();
    this.icpt = { found: false };
    this.icptTick = -100;
    this.icptTrajId = -1;
    this.maneuver = null;
    this.kickoff = null;
    this.stuckT = 0;
    this.roofT = 0;
    this.phase = (botCount++) % 6;           // stagger expensive searches
    this.mode = 'idle';
    this.demoTarget = -1; this.demoUntil = 0;
    this.padTarget = null; this.padUntil = 0;
    this.aimErr = 0; this.aimErrUntil = -1;
    this.stats = { flips: 0, halfFlips: 0, aerials: 0, aerialTouches: 0, jumpShots: 0, doubleJumpShots: 0, dodgeShots: 0,
      kickoffs: 0, speedFlips: 0, demoAttempts: 0, unstucks: 0, ticks: 0, timeMs: 0 };
    this.chat = new QuickChat(this);
    tables(); // calibrate once
  }

  // ---------------------------------------------------------------- entry
  tick(world, mv, dt) {
    const c = makeControls();
    const car = world.getCar(this.carId);
    if (!car) return c;
    this.world = world; this.car = car;
    const state = mv ? mv.state : 'playing';
    this.chat.update(world, mv, car);
    if (this.maneuver && this.maneuver.name === 'aerial' && !this.maneuver.touched) {
      for (const e of world.events) {
        if (e.type === 'ballHit' && e.carId === this.carId) { this.maneuver.touched = true; this.stats.aerialTouches++; break; }
      }
    }
    if (car.isDemoed) { this.maneuver = null; this.kickoff = null; this.icpt.found = false; return c; }
    if (state === 'countdown' || world.carsFrozen) {
      this.maneuver = null; this.kickoff = null; this.icpt.found = false; this.stuckT = 0;
      return c;
    }
    if (state === 'goal' || (mv && mv.ballHidden)) { this.kickoff = null; return this.postGoal(world, car, c); }
    if (state !== 'playing') { this.maneuver = null; this.kickoff = null; return this.idle(car, c); }
    this.stats.ticks++;
    this.perceive(world, car);
    // kickoff
    if (this.isKickoffBall(world)) {
      if (!this.kickoff) {
        const takers = kickoffTakers(world, this.co);
        this.kickoff = new Kickoff(this, car, takers[this.team] === this.carId);
        if (this.kickoff.isTaker) { this.stats.kickoffs++; if (this.skill.kickoff === 'speedflip') this.stats.speedFlips++; }
        this.maneuver = null;
      }
      this.kickoff.step(this, car, c, world);
      return c;
    }
    this.watchdog(car, world);
    if (this.kickoff) {
      // kickoff over: let a running dodge finish
      if (this.kickoff.maneuver && !car.isOnGround) this.maneuver = this.kickoff.maneuver;
      this.kickoff = null;
    }
    if (this.maneuver) {
      if (this.maneuver.step(this, car, c, world)) this.maneuver = null;
      else return c;
    }
    // airborne / not on wheels
    if (!car.isOnGround) {
      if (this.onRoofOrSide(car, c, world)) return c;
      if (car.numWheelsInContact === 0) {
        if (this.tryAirShot(car, c, world)) return c;
        recover(car, c, null);
        return c;
      }
    }
    if (car.isOnGround && car.body.rot.m[8] < -0.7) { // on the ceiling: drop off
      c.jump = (world.tick % 20) < 3; c.throttle = 0; return c;
    }
    this.play(car, c, world);
    this.antiStuck(car, c, world);
    return c;
  }

  // After a goal the ball is hidden (parked behind a net): ignore it, drive back
  // toward our half and top up boost.
  postGoal(world, car, c) {
    if (this.maneuver) { if (this.maneuver.step(this, car, c, world)) this.maneuver = null; return c; }
    if (!car.isOnGround) { recover(car, c, null); return c; }
    this.world = world;
    const p = car.body.pos;
    let tx = clamp(p.x * 0.5, -2500, 2500), ty = -this.s * 2600;
    if (car.boost < 70) {
      let best = null, bd = 1e9;
      for (const pad of world.pads) {
        if (!pad.isActive) continue;
        const d = Math.hypot(pad.pos.x - p.x, pad.pos.y - p.y) - (pad.isBig ? 1200 : 0);
        if (d < bd) { bd = d; best = pad; }
      }
      if (best) { tx = best.pos.x; ty = best.pos.y; }
    }
    this.mode = 'postGoal';
    this.driveTo(car, c, tx, ty, 0, { speed: 1300, boost: false });
    return c;
  }

  idle(car, c) {
    // goal celebration / replay / ended: coast, land on wheels
    if (!car.isOnGround) recover(car, c, null);
    return c;
  }

  // ---------------------------------------------------------------- perception
  perceive(world, car) {
    const delay = this.skill.delay;
    getTrajectory(world, this.traj, delay, 2);
    this.co = coordinator(world);
    this.role = this.co.role.get(this.carId) || 1;
    this.teamSize = 0; this.lastMan = true;
    for (const o of world.cars) {
      if (o.team !== this.team) continue;
      this.teamSize++;
      if (o.id !== this.carId && !o.isDemoed && o.body.pos.y * this.s < car.body.pos.y * this.s - 150) this.lastMan = false;
    }
    if (this.aimErrUntil < world.tick) { // slowly varying aim error (sloppiness)
      this.aimErr = (this.rng() * 2 - 1) * this.skill.aimNoise;
      this.aimErrUntil = world.tick + 120 + Math.floor(this.rng() * 120);
    }
    this.threat = goalThreat(this.traj, this.s);
  }

  ballAt(T) {
    const tv = this.traj;
    const i = tv.at(T);
    return tv.pos(i, { x: 0, y: 0, z: 0 });
  }
  ballNow() { return this.traj.pos(0, { x: 0, y: 0, z: 0 }); }
  isKickoffBall(world) {
    const b = world.ball.body;
    return !world.lastTouch && Math.abs(b.pos.x) < 1 && Math.abs(b.pos.y) < 1 && b.vel.x === 0 && b.vel.y === 0 && b.vel.z === 0;
  }
  aerialSlack() {
    const oe = this.co ? this.co.oppEta[this.team] : 6;
    // how much earlier an aerial must be than a ground/jump touch to be worth it
    const pro = this.skill.name !== 'allstar';
    return oe > 2.5 ? (pro ? 0.9 : 0.6) : (pro ? 0.4 : 0.15);
  }

  // ---------------------------------------------------------------- intercept
  refreshIntercept(world, car, force) {
    const ic = this.icpt;
    const stale = force || !ic.found || this.traj.id !== this.icptTrajId || ic.tick < world.tick ||
      (world.tick - this.icptTick >= 6 && (world.tick + this.phase) % 2 === 0) || world.tick - this.icptTick >= 8;
    if (!stale) return ic;
    this.icptTick = world.tick; this.icptTrajId = this.traj.id;
    return findIntercept(this, car, this.traj, ic);
  }

  // ---------------------------------------------------------------- decisions
  play(car, c, world) {
    const sk = this.skill;
    const ic = this.refreshIntercept(world, car, false);
    const p = car.body.pos;
    const ball = this.ballNow();
    const co = this.co;
    const oppEta = co.oppEta[this.team];
    const myEta = ic ? ic.t : 6;
    // ---- demos (all-star): opportunistic when supersonic-ish and not needed on the ball
    if (sk.demos && this.tryDemo(car, c, world, myEta)) return;
    // ---- saves: ball heading into our net
    if (this.threat >= 0 && (this.role === 1 || this.lastMan || this.threat < 1.5)) {
      if (ic && ic.t < this.threat + 0.05) { this.mode = 'save'; this.executeShot(car, c, world, ic, true); return; }
      this.mode = 'block'; this.goalLine(car, c, world); return;
    }
    const role = this.teamSize === 1 ? 1 : this.role;
    if (role === 1) {
      if (!ic) { this.mode = 'chase'; this.driveTo(car, c, ball.x, ball.y, 0, { speed: 1600, boost: true }); return; }
      const goalSide = (ic.y - p.y) * this.s > -100;
      if (sk.rotation !== 'none' && this.lastMan) {
        // retreat if the opponent will get there first and we're on the wrong side
        if (!goalSide && oppEta < myEta + 0.15 && ball.y * this.s < 1500) { this.mode = 'retreat'; this.backPost(car, c, world, true); return; }
        if (sk.shadow && goalSide && oppEta + 0.45 < myEta && ball.y * this.s < -300 && this.oppComingAtUs(world)) { this.mode = 'shadow'; this.shadow(car, c, world); return; }
        // bad touch that would only push the ball back toward our net from the wrong side
        if (ic.shotKind === 'cut' && !goalSide && oppEta < myEta + 0.8 && ic.y * this.s < 0) { this.mode = 'retreat'; this.backPost(car, c, world, true); return; }
      }
      // low on boost and no immediate play: grab a pad on the way
      if (sk.pads && car.boost < (this.padTarget ? 40 : 20) && myEta > 1.6 && oppEta > 1.0 && this.threat < 0 &&
          this.maybePads(car, c, world, ic.x, ic.y, 30, true)) { this.mode = 'attack+pad'; return; }
      this.mode = 'attack';
      this.chat.onCommit(world);
      this.executeShot(car, c, world, ic, false);
      return;
    }
    if (role === 2) { this.mode = 'support'; this.support(car, c, world); return; }
    this.mode = 'goalie'; this.goalie(car, c, world);
  }

  // Drive to and hit the intercept; trigger jump shots / dodges / aerials.
  executeShot(car, c, world, ic, urgent) {
    const sk = this.skill;
    const p = car.body.pos;
    const remT = Math.max((ic.tick - world.tick) / 120, 0);
    const b = this.ballAt(remT);
    // aim error (sloppiness) rotates the shot direction
    let sdx = ic.sdx, sdy = ic.sdy;
    if (this.aimErr) { const ca = Math.cos(this.aimErr), sa = Math.sin(this.aimErr); const x = sdx * ca - sdy * sa; sdy = sdx * sa + sdy * ca; sdx = x; }
    const kind = ic.kind;
    if (kind === 'aerial') {
      const loc = localTarget(car, b);
      const ang = Math.atan2(loc.y, loc.x);
      if (car.isOnGround && Math.abs(ang) < 0.5 && car.body.rot.m[8] > 0.9) {
        const tgt = (T) => { const bb = this.ballAt(T); return { x: bb.x - sdx * 70, y: bb.y - sdy * 70, z: bb.z - 25 }; };
        this.maneuver = new Aerial(ic.tick, tgt, { dbl: ic.dbl, dodge: sk.name === 'allstar' });
        this.stats.aerials++;
        this.aerialStart = world.tick;
        this.maneuver.step(this, car, c, world);
        return;
      }
      // turn toward it first
      this.driveTo(car, c, b.x - sdx * 300, b.y - sdy * 300, 0, { speed: 900, boost: false });
      return;
    }
    if (kind === 'wall') {
      // drive up the wall toward the ball, dodge into it when close
      const tx = b.x - sdx * 120, ty = b.y - sdy * 120;
      const loc = localTarget(car, { x: tx, y: ty, z: b.z });
      const ang = Math.atan2(loc.y, loc.x);
      c.steer = steerPD(car, ang);
      c.throttle = 1;
      c.boost = Math.abs(ang) < 0.3 && car.forwardSpeed < 2200 && remT > 0.4;
      if (Math.abs(ang) > 1.7 && car.forwardSpeed > 500 && car.body.rot.m[8] > 0.8) c.handbrake = true;
      const d3 = dist(p, b);
      if (d3 < 330 && remT < 0.35 && car.body.rot.m[8] < 0.7 && sk.jumpDodge) {
        const lb = localTarget(car, b);
        this.maneuver = new Flip(lb.x, lb.y, { jumpTicks: 3, gap: 1, name: 'wallDodge' });
        this.maneuver.step(this, car, c, world);
      }
      return;
    }
    const off = kind === 'ground' ? 150 : 105;
    const cx = b.x - sdx * off, cy = b.y - sdy * off;
    const d = Math.hypot(cx - p.x, cy - p.y);
    // line + arc approach: arrive at C heading along the shot direction
    const vf0 = Math.max(car.forwardSpeed, 0);
    const r = turnRadius(clamp(Math.max(vf0, 1000), 900, 1700)) * APPROACH_R;
    const ap = approachPath(p.x, p.y, cx, cy, sdx, sdy, r);
    const A = clampToField({ x: ap.tx, y: ap.ty, z: 0 }, 120);
    const pathLen = ap.len;
    const needed = pathLen / Math.max(remT, 0.02);
    let desired = needed;
    if (kind === 'ground') desired = Math.max(desired, urgent ? 2300 : d > 250 ? sk.groundSpeed : 900);
    if (urgent) desired = Math.max(desired, 1600);
    // boost only when the timing needs it (or the ball is contested / urgent)
    const contested = this.co.oppEta[this.team] < remT + 0.6;
    const boostSpeed = urgent || contested ? desired : needed;
    this.driveTo(car, c, A.x, A.y, 0, { speed: desired, boostSpeed, boost: true, flipOk: remT > 1.6 && d > 1800 });
    if (this.maneuver) return;
    const fwd = carFwd(car);
    const lb = localTarget(car, b);
    const angB = Math.atan2(lb.y, lb.x);
    const vf = car.forwardSpeed;
    if (kind === 'ground') {
      // dodge into the ball for power
      const d2b0 = Math.hypot(b.x - p.x, b.y - p.y);
      const tHit = (d2b0 - 140) / Math.max(vf, 1);
      // where the ball will be when we arrive
      const bh = this.ballAt(clamp(tHit, 0, 1));
      const d2b = Math.hypot(bh.x - p.x, bh.y - p.y);
      lb.x = localTarget(car, bh).x; lb.y = localTarget(car, bh).y;
      const angH = Math.atan2(lb.y, lb.x);
      const shotOk = fwd.x * sdx + fwd.y * sdy > 0.55 || urgent;
      if (car.isOnGround && sk.dodgeShots > 0 && tHit < 0.22 && tHit > 0 && d2b < 450 && vf > 500 && Math.abs(angH) < 0.35 && Math.abs(lb.y) < 110 && shotOk && bh.z < 170 &&
          car.body.rot.m[8] > 0.9 && this.rollDodge(world)) {
        this.maneuver = new Flip(lb.x, lb.y, { jumpTicks: 2, gap: 1, name: 'dodgeShot' });
        this.stats.dodgeShots++;
        this.maneuver.step(this, car, c, world);
      }
      return;
    }
    // jump shots
    const dbl = kind === 'dbl';
    const need = b.z - 17 - 75;
    const tj = jumpTimeTo(Math.max(need, 1), dbl);
    if (tj < 0) return;
    const lateral = Math.abs(localTarget(car, { x: cx, y: cy, z: 0 }).y);
    if (car.isOnGround && remT <= tj + 1 / 60 && remT > tj - 0.12 && lateral < 110 && Math.abs(angB) < 0.35 && car.body.rot.m[8] > 0.9) {
      this.maneuver = new JumpShot(ic.tick, dbl, sk.jumpDodge && !dbl);
      if (dbl) this.stats.doubleJumpShots++; else this.stats.jumpShots++;
      this.maneuver.step(this, car, c, world);
    }
  }

  // the opponent closest to the ball is moving it toward our half
  oppComingAtUs(world) {
    const id = this.co.oppFirst[this.team];
    const o = id >= 0 ? world.getCar(id) : null;
    if (!o) return false;
    const ball = this.ballNow();
    return (ball.y - o.body.pos.y) * this.s < 200 && o.body.vel.y * this.s < 300;
  }

  rollDodge(world) {
    // rookies dodge into the ball only sometimes (decided once per approach)
    if (this.skill.dodgeShots >= 1) return true;
    if (this._dodgeRollTick === undefined || world.tick - this._dodgeRollTick > 90) {
      this._dodgeRollTick = world.tick; this._dodgeRoll = this.rng() < this.skill.dodgeShots;
    }
    return this._dodgeRoll;
  }

  // Already in the air (after a jump/flip that ended, falling off a wall...):
  // all-stars can chain into an aerial when one is feasible.
  tryAirShot(car, c, world) {
    if (!this.skill.aerials || this.skill.name !== 'allstar' || car.boost < 15) return false;
    if (car.body.pos.z < 250) return false;
    const ic = this.refreshIntercept(world, car, false);
    if (!ic || ic.kind !== 'aerial') return false;
    const sdx = ic.sdx, sdy = ic.sdy;
    const tgt = (T) => { const bb = this.ballAt(T); return { x: bb.x - sdx * 70, y: bb.y - sdy * 70, z: bb.z - 25 }; };
    this.maneuver = new Aerial(ic.tick, tgt, { dbl: false, dodge: true });
    this.stats.aerials++;
    this.aerialStart = world.tick;
    this.maneuver.step(this, car, c, world);
    return true;
  }

  // ---------------------------------------------------------------- positioning
  support(car, c, world) {
    const s = this.s;
    const ball = this.ballNow();
    const firstId = this.co.first[this.team];
    const first = firstId >= 0 ? world.getCar(firstId) : null;
    // ball deep in our half: second man becomes a defender
    const ownY = -FIELD_Y * s;
    let tx, ty;
    const back = ball.y * s < -1000 ? 1500 : 2300;
    ty = ball.y - s * back;
    // offset to the opposite side of the first man, towards the middle
    const fx = first ? first.body.pos.x : ball.x;
    tx = clamp(ball.x * 0.35 + (fx > ball.x ? -1 : 1) * 900, -2600, 2600);
    if (ty * s < ownY * s + 700) ty = ownY + s * 700;
    if (ty * s > 2500) ty = 2500 * s;
    if (this.maybePads(car, c, world, tx, ty, 50)) return;
    this.position(car, c, world, tx, ty, ball);
  }

  goalie(car, c, world) {
    const s = this.s;
    const ball = this.ballNow();
    const ownY = -FIELD_Y * s;
    const dGoal = Math.hypot(ball.x, ball.y - ownY);
    const k = clamp(1200 / Math.max(dGoal, 1), 0.12, 0.45);
    let tx = ball.x * k, ty = ownY + (ball.y - ownY) * k;
    tx = clamp(tx, -GOAL_HW + 150, GOAL_HW - 150);
    if (ty * s < ownY * s + 250) ty = ownY + s * 250;
    if (this.maybePads(car, c, world, tx, ty, 35)) return;
    // rotating back from upfield: go via the far (back) post
    if ((car.body.pos.y - ball.y) * s > 300) { this.backPost(car, c, world, false); return; }
    this.position(car, c, world, tx, ty, ball);
  }

  // 1v1 / last man: stay between ball and goal at a distance matching the ball pace
  shadow(car, c, world) {
    const s = this.s;
    const ball = this.ballNow();
    const ownY = -FIELD_Y * s;
    const gx = clamp(ball.x * 0.25, -500, 500);
    let dx = gx - ball.x, dy = ownY - ball.y;
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const D = clamp(l * 0.45, 900, 2200);
    const tx = ball.x + dx * D, ty = ball.y + dy * D;
    if (this.maybePads(car, c, world, tx, ty, 30)) return;
    const bv = this.traj.vel(0, { x: 0, y: 0, z: 0 });
    this.position(car, c, world, tx, ty, ball, bv);
  }

  // Back-post rotation: drive to the post away from the ball, then face the play.
  backPost(car, c, world, urgent) {
    const s = this.s;
    const ball = this.ballNow();
    const ownY = -FIELD_Y * s;
    const p = car.body.pos;
    const far = ball.x >= 0 ? -1 : 1;
    let tx = far * (GOAL_HW - 50), ty = ownY + s * 350;
    // if we're already level with the post, cut to the goal centre
    if ((p.y - ownY) * s < 900) { tx = far * 300; ty = ownY + s * 200; }
    const d = Math.hypot(tx - p.x, ty - p.y);
    if (d < 400) { this.position(car, c, world, tx * 0.5, ownY + s * 300, ball); return; }
    if (!urgent && this.maybePads(car, c, world, tx, ty, 40)) return;
    this.driveTo(car, c, tx, ty, 0, { speed: 2300, boost: urgent || d > 3000, flipOk: true });
  }

  goalLine(car, c, world) {
    // can't intercept in time: get in front of where the ball crosses the line
    const s = this.s;
    const ownY = -FIELD_Y * s;
    let cx = 0;
    for (let i = 0; i < this.traj.n; i += 2) {
      if (this.traj.py(i) * s < -(FIELD_Y - 50)) { cx = this.traj.px(i); break; }
    }
    const ball = this.ballNow();
    const p = car.body.pos;
    const tx = clamp(cx, -GOAL_HW + 100, GOAL_HW - 100), ty = ownY + s * 120;
    const d = Math.hypot(tx - p.x, ty - p.y);
    if (d > 300) this.driveTo(car, c, tx, ty, 0, { speed: 2300, boost: true });
    else {
      // face the ball, jump when it's about to arrive above us
      const loc = localTarget(car, ball);
      c.steer = steerPD(car, Math.atan2(loc.y, loc.x));
      c.throttle = 0.4;
      if (car.isOnGround && car.body.rot.m[8] > 0.9) this.settledTick = world.tick;
      const db = dist(p, ball);
      if (this.skill.jumpShots && db < 500 && ball.z > 150 && car.isOnGround) {
        this.maneuver = new JumpShot(world.tick + 30, ball.z > 350 && this.skill.doubleJumps, false);
        this.maneuver.step(this, car, c, world);
      }
    }
  }

  // Arrive at (tx, ty) and settle facing `face` (a point); optional pace matching
  position(car, c, world, tx, ty, face, paceVel) {
    const p = car.body.pos;
    const T = clampToField({ x: tx, y: ty, z: 0 }, 200);
    const d = Math.hypot(T.x - p.x, T.y - p.y);
    if (d > 250) {
      let speed = Math.min(2300, Math.sqrt(2 * 2200 * Math.max(d - 150, 0)) + 200);
      if (paceVel) speed = Math.max(speed * 0.8, Math.abs(paceVel.y) + 300);
      this.driveTo(car, c, T.x, T.y, 0, { speed, boost: d > 2000, flipOk: true, halfFlipOk: true });
      return;
    }
    // close: turn to face the play (holding position on purpose)
    if (car.isOnGround && car.body.rot.m[8] > 0.9) this.settledTick = world.tick;
    const loc = localTarget(car, face);
    const ang = Math.atan2(loc.y, loc.x);
    if (Math.abs(ang) < 0.5) { c.throttle = car.forwardSpeed > 100 ? -0.3 : 0; c.steer = steerPD(car, ang); return; }
    c.throttle = car.forwardSpeed < 400 ? 0.6 : 0.1;
    c.steer = ang > 0 ? 1 : -1;
    if (Math.abs(ang) > 2 && car.forwardSpeed > 250) c.handbrake = true;
  }

  // Pick up a boost pad on the way when low
  maybePads(car, c, world, tx, ty, threshold, attacking = false) {
    const sk = this.skill;
    if (!sk.pads || car.boost >= threshold) { this.padTarget = null; return false; }
    const p = car.body.pos;
    if (this.padTarget && (!this.padTarget.isActive && this.padTarget.cooldown > 1 || world.tick > this.padUntil)) this.padTarget = null;
    if (!this.padTarget) {
      const direct = Math.hypot(tx - p.x, ty - p.y);
      let best = null, bestCost = 1e9;
      const vel = car.body.vel;
      for (const pad of world.pads) {
        const d1 = Math.hypot(pad.pos.x - p.x, pad.pos.y - p.y);
        const arrive = d1 / 1600;
        if (!pad.isActive && pad.cooldown > arrive) continue;
        // don't go upfield of the ball for boost when defending
        const ball = this.ballNow();
        if (!attacking && (pad.pos.y - ball.y) * this.s > 800 && this.mode !== 'support') continue;
        const d2 = Math.hypot(tx - pad.pos.x, ty - pad.pos.y);
        // heading change needed to go for the pad
        const fw = carFwd(car);
        const cosA = (fw.x * (pad.pos.x - p.x) + fw.y * (pad.pos.y - p.y)) / Math.max(d1, 1);
        const turnA = Math.acos(clamp(cosA, -1, 1));
        if (attacking && turnA > 0.35) continue;
        const detour = d1 + d2 - direct + turnA * 500;
        const limit = attacking ? (pad.isBig ? 900 : 200) : (pad.isBig ? 2000 : 450);
        if (detour > limit) continue;
        const cost = detour - (pad.isBig ? 900 : 0) + d1 * 0.15;
        if (cost < bestCost) { bestCost = cost; best = pad; }
      }
      if (best) { this.padTarget = best; this.padUntil = world.tick + 360; }
    }
    if (!this.padTarget) return false;
    const pad = this.padTarget;
    this.mode += '+pad';
    this.driveTo(car, c, pad.pos.x, pad.pos.y, 0, { speed: 2300, boostSpeed: attacking ? 2300 : 0, boost: attacking, flipOk: true });
    return true;
  }

  // Demolition attempt (all-star): only when fast, opponent ahead & grounded
  tryDemo(car, c, world, myEta) {
    const v = car.body.vel;
    const speed = Math.hypot(v.x, v.y, v.z);
    if (!car.isOnGround || car.body.rot.m[8] < 0.9) return false;
    const now = world.tick;
    if (this.demoTarget >= 0 && now > this.demoUntil) { this.demoTarget = -1; this.demoCooldown = now + 600; }
    if (this.demoTarget < 0) {
      if ((this.demoCooldown || 0) > now) return false;
      if (speed < 1900 || car.boost < 25) return false;
      if (this.role === 1 && myEta < 2.5) return false;
      if (this.lastMan && this.teamSize > 1) return false;
      if (this.threat >= 0) return false;
      const f = carFwd(car);
      for (const o of world.cars) {
        if (o.team === this.team || o.isDemoed || !o.isOnGround) continue;
        const dx = o.body.pos.x - car.body.pos.x, dy = o.body.pos.y - car.body.pos.y;
        const d = Math.hypot(dx, dy);
        if (d > 2200 || d < 200) continue;
        if ((f.x * dx + f.y * dy) / d < 0.93) continue;
        this.demoTarget = o.id; this.demoUntil = now + 180; this.stats.demoAttempts++;
        break;
      }
      if (this.demoTarget < 0) return false;
    }
    const o = world.getCar(this.demoTarget);
    if (!o || o.isDemoed) { this.demoTarget = -1; return false; }
    const d = dist(o.body.pos, car.body.pos);
    const t = d / Math.max(speed, 1000);
    const tx = o.body.pos.x + o.body.vel.x * t, ty = o.body.pos.y + o.body.vel.y * t;
    this.mode = 'demo';
    this.driveTo(car, c, tx, ty, 0, { speed: 2300, boost: true });
    c.boost = car.boost > 0 && car.forwardSpeed < 2290;
    return true;
  }

  // ---------------------------------------------------------------- driving
  // Ground driving toward a point with a target speed (uu/s).
  driveTo(car, c, tx, ty, tz, o) {
    const sk = this.skill;
    if (sk.posNoise) { tx += Math.sin(this.world.tick * 0.013 + this.carId) * sk.posNoise; ty += Math.cos(this.world.tick * 0.011 + this.carId * 3) * sk.posNoise; }
    // inside a goal with a target outside it: leave through the goal mouth first
    const pp = car.body.pos;
    if (Math.abs(pp.y) > FIELD_Y - 60 && (Math.abs(tx) > GOAL_HW - 250 || Math.abs(ty) < Math.abs(pp.y) - 200)) {
      const gy = Math.sign(pp.y);
      if (Math.abs(tx) > GOAL_HW - 250 || Math.abs(pp.x) > GOAL_HW - 250) {
        tx = clamp(tx, -GOAL_HW + 350, GOAL_HW - 350) * 0.5; ty = gy * (FIELD_Y - 500); tz = 0;
      }
    }
    const loc = localTarget(car, { x: tx, y: ty, z: tz });
    const ang = Math.atan2(loc.y, loc.x);
    const p = car.body.pos;
    const d = Math.hypot(tx - p.x, ty - p.y);
    const vf = car.forwardSpeed;
    const flatGround = car.isOnGround && car.body.rot.m[8] > 0.9;
    const aang = Math.abs(ang);
    // reverse to nearby targets behind us
    if (sk.reverse && aang > 2.4 && d < 900 && vf < 300 && flatGround) {
      const angB = Math.atan2(loc.y, -loc.x);
      c.throttle = -1;
      c.steer = clamp1(angB * 3);
      return;
    }
    // half-flip to turn around for far targets behind
    if (sk.halfFlip && aang > 2.7 && d > 1800 && vf < 350 && vf > -1000 && flatGround && car.boost > 5) {
      this.maneuver = new HalfFlip();
      this.maneuver.step(this, car, c, this.world);
      return;
    }
    c.steer = steerPD(car, ang);
    if (aang > sk.handbrakeAngle && vf > 500 && flatGround) c.handbrake = true;
    let desired = Math.min(o.speed, 2300 * sk.maxSpeedFrac);
    // slow down enough to make the turn: radius of the circle tangent to our
    // heading through the target
    if (flatGround && Math.abs(loc.y) > 1) {
      const R = (loc.x * loc.x + loc.y * loc.y) / (2 * Math.abs(loc.y));
      if (aang < 1.6 || d < 1500) desired = Math.min(desired, Math.max(speedForRadius(R) * 1.1, 500));
    }
    if (desired > vf + 40) {
      c.throttle = 1;
      const bs = Math.min(o.boostSpeed ?? desired, 2300);
      const boostOk = o.boost && car.boost > 0 && aang < 0.3 && vf < 2250 && car.isOnGround &&
        (bs > vf + 250 || (vf > 1600 && bs > 2000)) && (d > sk.boostMinDist || bs > vf + 600);
      if (boostOk) c.boost = true;
    } else if (desired < vf - 450) c.throttle = -1;
    else if (desired < vf - 120) c.throttle = 0;
    else c.throttle = clamp((desired - vf) / 150 + 0.05, 0.02, 1);
    // front flip for speed on long straights
    if (o.flipOk && sk.frontFlipSpeed && flatGround && aang < 0.06 && vf > 1050 && vf < 1950 && d > vf * 1.4 + 500 &&
        desired > vf + 300 && !c.boost && Math.abs(car.body.angVel.z) < 0.3) {
      this.maneuver = new Flip(1, 0, { jumpTicks: 4, gap: 2, name: 'speedFlip' });
      this.maneuver.step(this, car, c, this.world);
    }
  }

  // ---------------------------------------------------------------- robustness
  onRoofOrSide(car, c, world) {
    const up = carUp(car);
    if (car.numWheelsInContact === 0 && car.worldContact.hasContact && (up.z < -0.3 || (Math.abs(up.z) < 0.5 && Math.hypot(car.body.vel.x, car.body.vel.y, car.body.vel.z) < 150))) {
      this.roofT += 1 / 120;
      if (this.roofT > 0.15) { autoFlipInput(car, c, world.tick); return true; }
      return false;
    }
    this.roofT = 0;
    return false;
  }

  antiStuck(car, c, world) {
    const v = car.body.vel;
    const speed = Math.hypot(v.x, v.y, v.z);
    const pushing = Math.abs(c.throttle) > 0.5 || c.boost;
    if (pushing && speed < 120) this.stuckT += 1 / 120; else this.stuckT = Math.max(0, this.stuckT - 2 / 120);
    if (this.stuckT > 0.9) { this.stuckT = 0; this.escape(car, c.throttle < 0, c.steer); }
  }

  // Position-based watchdog (runs every tick while playing, also while a
  // maneuver or recovery is active): no progress for 1.5 s -> escape maneuver,
  // escalating reverse -> jump out -> reverse the other way + jump.
  watchdog(car, world) {
    if (world.tick % 30 !== 0) return;
    const h = this.posHist || (this.posHist = []);
    const p = car.body.pos;
    h.push(p.x, p.y, p.z);
    if (h.length > 18) h.splice(0, 3);
    if (h.length < 18) return;
    const d = Math.hypot(p.x - h[0], p.y - h[1], p.z - h[2]);
    const settled = world.tick - (this.settledTick || -1e9) < 90;
    if (d < 90 && !settled) {
      h.length = 0;
      this.escape(car, false, 0, 'watchdog');
    }
  }

  escape(car, wasReversing, steer, why = 'push') {
    this.stats.unstucks++;
    if (DEBUG_STUCK) console.log('escape', why, this.skill.name, this.mode, this.maneuver && this.maneuver.name, car.body.pos.x | 0, car.body.pos.y | 0, car.body.pos.z | 0, 'up', car.body.rot.m[8].toFixed(2), 'wheels', car.numWheelsInContact, 'v', Math.hypot(car.body.vel.x, car.body.vel.y) | 0);
    const lvl = this.stuckLevel = ((this.stuckLevel || 0) + 1) % 3;
    const onWheels = car.isOnGround && car.body.rot.m[8] > 0.5;
    if (!car.isOnGround) {
      // wedged on 1-2 wheels (e.g. against a goal wall): no jump possible,
      // drive along the surface forward / backward instead
      this.maneuver = new Unstuck(0, 60, lvl === 1 ? -1 : 1);
    } else if (lvl === 1 && onWheels && !wasReversing) this.maneuver = new Unstuck(steer >= 0 ? -1 : 1, 70);
    else if (lvl === 2 && onWheels) this.maneuver = new Unstuck(steer >= 0 ? 1 : -1, 50);
    else this.maneuver = new Flip(0, 0, { jumpTicks: 10, gap: 4, name: 'jumpOut' });
  }
}

export function createBot(opts) {
  return new Bot(opts || {});
}
