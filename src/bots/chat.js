// TURBO PITCH bots — human-sounding quick chat, rate limited.
// Pushes {type:'quickChat', carId, text} into bot.events.
const MIN_GAP = 9;          // s between two messages from the same bot
const SAME_TEXT_GAP = 4;    // s before any bot repeats the same text

const shared = new WeakMap(); // world -> { lastText: Map(text -> time) }

export class QuickChat {
  constructor(bot) {
    this.bot = bot;
    this.last = -1e9;
    this.prevGoal = null;
    this.prevThreat = false;
    this.prevState = null;
    this.committedAt = -1e9;
    this.lastTouchTick = -1;
  }

  say(world, text, prob = 1) {
    const bot = this.bot;
    const now = world.time;
    if (now - this.last < MIN_GAP) return false;
    if (bot.rng() > prob) return false;
    let sh = shared.get(world);
    if (!sh) { sh = { lastText: new Map() }; shared.set(world, sh); }
    if (now - (sh.lastText.get(text) ?? -1e9) < SAME_TEXT_GAP) return false;
    sh.lastText.set(text, now);
    this.last = now;
    bot.events.push({ type: 'quickChat', carId: bot.carId, text, tick: world.tick });
    return true;
  }

  update(world, mv, car) {
    const bot = this.bot;
    // goals (world.goalScored is set the tick the ball crosses the line)
    const g = world.goalScored;
    if (g && !this.prevGoal) {
      const lt = world.lastTouch;
      const scorer = lt ? world.getCar(lt.carId) : null;
      if (g.team === bot.team) {
        if (scorer && scorer.id === bot.carId) this.say(world, bot.rng() < 0.5 ? 'Calculated.' : 'What a play!', 0.35);
        else this.say(world, 'Nice shot!', 0.6);
      } else if (scorer && scorer.id === bot.carId) this.say(world, 'Whoops...', 0.7);
      else if (scorer && scorer.team === bot.team) this.say(world, 'No problem.', 0.4);
      else this.say(world, bot.rng() < 0.5 ? 'Nice shot!' : 'Wow!', 0.15);
    }
    this.prevGoal = g;
    // saves: the ball was going into a net and a touch stopped it
    if (bot.threat !== undefined) {
      const threat = bot.threat >= 0;
      if (this.prevThreat && !threat && world.lastTouch && world.lastTouch.tick >= world.tick - 3) {
        const saver = world.getCar(world.lastTouch.carId);
        if (saver && saver.id !== bot.carId && saver.team === bot.team) this.say(world, 'What a save!', 0.7);
        else if (saver && saver.team !== bot.team) this.say(world, 'Great pass!', 0.05);
      }
      this.prevThreat = threat;
    }
    // own touches: centring passes
    const lt = world.lastTouch;
    if (lt && lt.carId === bot.carId && lt.tick !== this.lastTouchTick) {
      this.lastTouchTick = lt.tick;
      if (bot.icpt && bot.icpt.shotKind === 'centre' && bot.teamSize > 1) this.say(world, 'Centering!', 0.5);
    }
    this.prevState = mv ? mv.state : null;
  }

  onCommit(world) {
    const bot = this.bot;
    if (bot.teamSize < 2) return;
    if (world.time - this.committedAt > 25) {
      this.committedAt = world.time;
      if (bot.icpt && bot.icpt.found && bot.icpt.t < 1.2) this.say(world, 'I got it!', 0.12);
    }
    // teammate in front of the opponent goal while we bring the ball: ask for the shot
    if (bot.icpt && bot.icpt.shotKind === 'centre') {
      for (const o of world.cars) {
        if (o.team === bot.team && o.id !== bot.carId && o.body.pos.y * bot.s > 3000 && Math.abs(o.body.pos.x) < 1500) {
          this.say(world, 'Take the shot!', 0.02);
          break;
        }
      }
    }
  }
}
