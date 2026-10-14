// TURBO PITCH bots — kickoff routines.
//
// Spawn classes (car.kickoffSpawnIndex, or classified from the position):
//   'diag' (0/1)  'off' (2/3 off-centre)  'back' (4 back centre)
// Taker routines by difficulty:
//   allstar: speed-flip (diagonal dodge cancelled while boosting) then a dodge
//            into the ball ('speedflip');
//   pro:     full boost straight at the ball + dodge into it ('boostflip');
//            ('flip' = early front flip variant, kept for experiments: it is
//            slower in this sim because the car can't boost while flipping)
//   rookie:  boost straight at the ball, dodges into it only sometimes.
// Non-takers: grab the nearest own-half corner boost (second man) or go to net.
// The speed-flip parameters were found by a search in the real sim (blue, left
// side of the field from the team's view); other spawns are mirrored.
import { SpeedFlip, Flip, recover } from './mechanics.js';
import { localTarget, steerPD, dist2D, vnorm, vsub, carFwd, clamp } from './util.js';

export const KICKOFF_PARAMS = {
  diag: { aimX: 381.5, aimY: -197.3, t0: 52, sf: { h: 4, w: 1, ky: 0.345, cd: 0, cl: 33, r: 0.171, yy: -0.308 }, s: 1, fd: 648 },
  off: { aimX: -388.5, aimY: -57.4, t0: 48, sf: { h: 5, w: 1, ky: 0.61, cd: 1, cl: 76, r: 0.078, yy: 0.975 }, s: -1, fd: 405 },
  back: { aimX: -340, aimY: -31.9, t0: 48, sf: { h: 1, w: 5, ky: 0.328, cd: 0, cl: 57, r: 0.535, yy: 0.157 }, s: -1, fd: 543 },
};
// pro front-flip kickoff: jump at tick t0 (speed ~1000), final dodge at fd
const PRO = { diag: { t0: 34, fd: 560 }, off: { t0: 34, fd: 520 }, back: { t0: 40, fd: 520 } };

export function spawnClass(car) {
  const i = car.kickoffSpawnIndex;
  if (i === 0 || i === 1) return 'diag';
  if (i === 2 || i === 3) return 'off';
  if (i === 4) return 'back';
  const ax = Math.abs(car.body.pos.x);
  if (ax > 1000) return 'diag';
  if (ax > 100) return 'off';
  return 'back';
}

export class Kickoff {
  constructor(bot, car, isTaker) {
    this.isTaker = isTaker;
    this.k = 0;
    this.cls = spawnClass(car);
    const s = bot.team === 0 ? 1 : -1;
    // position in the blue frame; mirrored if on the right half (blue frame x > 0)
    const bx = car.body.pos.x * s;
    this.mirror = bx > 1 ? -1 : 1;
    this.tsign = s;
    const P = KICKOFF_PARAMS[this.cls];
    this.P = P;
    // aim offset in world coords
    this.aim = { x: P.aimX * this.mirror * s, y: P.aimY * s, z: 0 };
    this.side = P.s * this.mirror;
    this.maneuver = null;
    this.phase = 'drive';
    this.finalFlip = false;
    this.target = null;
    this.style = bot.skill.kickoff; // 'speedflip' | 'flip' | 'drive'
    // rookies only sometimes dodge into the ball
    this.finalFlipOk = this.style !== 'drive' || bot.rng() < 0.35;
  }

  // returns true when finished
  step(bot, car, c, world) {
    const k = this.k++;
    const ball = world.ball.body.pos;
    if (!this.isTaker) return this.nonTaker(bot, car, c, world);
    if (this.maneuver) {
      if (this.maneuver.step(bot, car, c, world)) this.maneuver = null;
      return false;
    }
    const d = dist2D(car.body.pos, ball);
    if (this.style === 'speedflip' && this.phase === 'drive' && k >= this.P.t0) {
      this.phase = 'flipped';
      this.maneuver = new SpeedFlip(this.side, ball, this.P.sf);
      this.maneuver.step(bot, car, c, world);
      return false;
    }
    if (this.style === 'flip' && this.phase === 'drive' && k >= PRO[this.cls].t0) {
      this.phase = 'flipped';
      this.maneuver = new Flip(1, 0, { jumpTicks: 4, gap: 2, boost: true });
      this.maneuver.step(bot, car, c, world);
      return false;
    }
    if (!car.isOnGround) { recover(car, c, vsub(ball, car.body.pos)); c.boost = false; return false; }
    // drive: early on toward the offset aim point, then at the ball
    const aimPt = (this.phase === 'drive' && this.style === 'speedflip')
      ? { x: ball.x + this.aim.x, y: ball.y + this.aim.y, z: 0 } : ball;
    const loc = localTarget(car, aimPt);
    const ang = Math.atan2(loc.y, loc.x);
    c.steer = steerPD(car, ang);
    c.throttle = 1;
    c.boost = Math.abs(ang) < 0.5;
    const fd = this.style === 'speedflip' ? this.P.fd : this.style === 'flip' ? PRO[this.cls].fd : 500;
    if (!this.finalFlip && this.finalFlipOk && d < fd && Math.abs(ang) < 0.3) {
      this.finalFlip = true;
      const lb = localTarget(car, ball);
      this.maneuver = new Flip(lb.x, lb.y * 0.4, { jumpTicks: 2, gap: 1, name: 'kickoffDodge' });
      this.maneuver.step(bot, car, c, world);
    }
    return k > 600;
  }

  nonTaker(bot, car, c, world) {
    // second man: corner boost on own half (if low), then a support spot;
    // last man: straight back to net.
    const s = this.tsign;
    const p = car.body.pos;
    if (!this.target) {
      const mates = world.cars.filter((o) => o.team === car.team && o.id !== car.id);
      const behind = mates.filter((o) => o.body.pos.y * s < p.y * s - 100).length;
      if (behind === 0 && mates.length >= 2) this.target = { x: 0, y: -s * 4900, z: 0, net: true };
      else {
        // nearest own-half big pad
        let best = null, bd = 1e9;
        for (const pad of world.pads) {
          if (!pad.isBig || pad.pos.y * s > 100) continue;
          const dd = dist2D(pad.pos, p);
          if (dd < bd) { bd = dd; best = pad; }
        }
        this.target = best ? { x: best.pos.x, y: best.pos.y, z: 0, pad: true } : { x: 0, y: -s * 3000, z: 0 };
      }
    }
    const t = this.target;
    const loc = localTarget(car, t);
    const ang = Math.atan2(loc.y, loc.x);
    const d = dist2D(p, t);
    c.steer = steerPD(car, ang);
    c.throttle = t.net ? clamp(d / 600, 0, 1) : 1;
    c.boost = !t.net && Math.abs(ang) < 0.3 && d > 1200 && car.boost > 10;
    if (Math.abs(ang) > 1.8 && car.forwardSpeed > 400) c.handbrake = true;
    if (!car.isOnGround) recover(car, c, null);
    return false;
  }
}
