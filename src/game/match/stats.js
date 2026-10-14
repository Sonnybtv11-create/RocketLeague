// Per-player stats & points (goals, assists, saves, shots, demos, score) and the
// detection of shots / saves / epic saves / clears / centres / aerial hits /
// first touch from ball touches + ball-trajectory prediction. See RULES.md.
import { EV } from '../../contracts.js';
import * as K from '../../sim/const.js';
import * as R from './rules.js';
import { createTrajectory } from './trajectory.js';

const GOAL_LINE_Y = 5120;
const TPS = K.TICK_RATE;

export function createStats({ world, emit, points = R.POINTS }) {
  const players = [];               // MatchView.players (objects updated in place)
  const byId = new Map();
  const traj = createTrajectory(R.PREDICT_SEC);
  const pending = new Map();        // carId -> open touch segment
  let history = [];                 // closed + open touch segments, newest last
  let possession = { carId: -1, credited: new Set() };
  let kickoffTouched = false;
  let lastDeviationCheck = -1000;
  const lastTouchPoints = new Map(); // carId -> tick of the last 2-point touch
  const tmp = { x: 0, y: 0, z: 0 };

  function player(carId) {
    let p = byId.get(carId);
    if (!p) {
      const car = world.getCar(carId);
      if (!car) return null;
      p = { carId, name: car.name, team: car.team, isBot: !!car.isBot, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, score: 0 };
      byId.set(carId, p);
      players.push(p);
    }
    return p;
  }
  function syncPlayers() { for (const c of world.cars) player(c.id); }
  syncPlayers();

  function award(carId, kind) {
    const p = player(carId);
    if (!p) return;
    const pts = points[kind] || 0;
    p.score += pts;
    emit({ type: EV.STAT, carId, kind, points: pts, label: R.STAT_LABELS[kind] || kind.toUpperCase(), team: p.team, name: p.name });
  }

  // ------------------------------------------------------------------ kickoff
  function onKickoff() {
    kickoffTouched = false;
    pending.clear();
    history = [];
    possession = { carId: -1, credited: new Set() };
    traj.invalidate();
  }

  // ------------------------------------------------------------------ demos
  function onDemo(e) {
    if (e.attackerId == null || e.attackerId < 0) return;
    const a = player(e.attackerId), v = player(e.victimId);
    if (!a || (v && v.team === a.team)) return;
    a.demos++;
    award(a.carId, 'demo');
    if (a.demos === R.EXTERMINATION_DEMOS) award(a.carId, 'extermination');
  }

  // ------------------------------------------------------------------ touches
  function startSegment(car, tick, enabled) {
    const b = world.ball.body;
    const before = traj.snapshot();
    const seg = {
      carId: car.id, team: car.team, startTick: tick, lastTick: tick,
      beforeGoalTeam: before.valid ? before.goalTeam : -1,
      beforeTTG: before.valid ? traj.timeToGoal(tick) : Infinity,
      beforeSource: before.sourceCarId,
      ball: { x: b.pos.x, y: b.pos.y, z: b.pos.z },
      aerial: car.numWheelsInContact === 0 && !car.isOnGround && b.pos.z > R.AERIAL_BALL_Z,
      backwards: car.isOnGround && car.forwardSpeed < -200,
      turtle: car.body.rot.up.z < -0.5,
    };
    pending.set(car.id, seg);
    history.push(seg);
    if (history.length > 64) history.splice(0, history.length - 64);
    if (possession.carId !== car.id) possession = { carId: car.id, credited: new Set() };
    if (!enabled) { kickoffTouched = true; return; }
    if (!kickoffTouched) {
      kickoffTouched = true;
      award(car.id, 'firstTouch');
    } else {
      const last = lastTouchPoints.get(car.id);
      if (last === undefined || tick - last >= R.TOUCH_POINTS_COOLDOWN_SEC * TPS) {
        lastTouchPoints.set(car.id, tick);
        const p = player(car.id);
        if (p) p.score += points.touch || 0;
      }
    }
    if (seg.aerial) award(car.id, 'aerialHit');
  }

  function ensureTrajectory(tick, sourceCarId) {
    if (!traj.pred.valid || traj.pred.startTick !== tick) traj.compute(world, sourceCarId);
    else traj.pred.sourceCarId = sourceCarId;
  }

  function finalize(seg, tick, enabled) {
    pending.delete(seg.carId);
    ensureTrajectory(tick, seg.carId);
    if (!enabled) return;
    const T = seg.team, s = T === 0 ? 1 : -1;
    const ownTTG = traj.timeToGoal(tick, 1 - T);   // ball going into own net
    const oppTTG = traj.timeToGoal(tick, T);       // ball going into opponent net
    let saved = false, shot = false;
    // save / epic save
    if (seg.beforeGoalTeam === 1 - T && seg.beforeTTG <= R.SAVE_MAX_SEC && seg.beforeSource !== seg.carId && ownTTG === Infinity) {
      saved = true;
      const distToLine = GOAL_LINE_Y + seg.ball.y * s; // distance from own goal line
      const epic = seg.beforeTTG <= R.EPIC_SAVE_SEC || distToLine <= R.EPIC_SAVE_DIST;
      const p = player(seg.carId);
      p.saves++;
      award(seg.carId, epic ? 'epicSave' : 'save');
      if (p.saves === R.FEAT_COUNT) award(seg.carId, 'savior');
    }
    // shot on goal
    if (oppTTG <= R.SHOT_MAX_SEC && !possession.credited.has('shot')) {
      shot = true;
      creditShot(seg.carId);
    }
    // clear
    if (!saved && seg.ball.y * s < -R.THIRD_Y && ownTTG === Infinity && !possession.credited.has('clear')) {
      if (traj.firstTime(R.CLEAR_MAX_SEC, (x, y) => y * s > 0) >= 0) {
        possession.credited.add('clear');
        award(seg.carId, 'clear');
      }
    }
    // centre
    if (!shot && seg.ball.y * s > R.THIRD_Y && Math.abs(seg.ball.x) > R.CENTRE_SIDE_X && !possession.credited.has('centre')) {
      if (traj.firstTime(R.CENTRE_MAX_SEC, (x, y, z) => Math.abs(x) < R.CENTRE_SLOT_X && y * s > R.CENTRE_SLOT_Y && z < 900) >= 0) {
        possession.credited.add('centre');
        award(seg.carId, 'centre');
      }
    }
  }

  function creditShot(carId) {
    possession.credited.add('shot');
    const p = player(carId);
    if (!p) return;
    p.shots++;
    award(carId, 'shot');
  }

  // Called every physics tick while the ball is in play.
  // enabled = false: track touches / trajectory only (free play), no stats.
  function onTick(worldEvents, enabled) {
    const tick = world.tick;
    if (enabled) for (const e of worldEvents) if (e.type === EV.DEMO) onDemo(e);
    for (const id of world.ballTouchedThisTick) {
      const car = world.getCar(id);
      if (!car) continue;
      const seg = pending.get(id);
      if (seg && tick - seg.lastTick < R.TOUCH_GAP_TICKS) { seg.lastTick = tick; continue; }
      if (seg) finalize(seg, tick, enabled);
      startSegment(car, tick, enabled);
    }
    for (const seg of [...pending.values()]) if (tick - seg.lastTick >= R.TOUCH_GAP_TICKS) finalize(seg, tick, enabled);
    // keep the free-ball trajectory honest (scripted teleports, wheel pushes, ...)
    if (pending.size === 0 && tick - lastDeviationCheck >= 6) {
      lastDeviationCheck = tick;
      const b = world.ball.body;
      const p = traj.posAt(tick, tmp);
      if (!p || Math.abs(p.x - b.pos.x) + Math.abs(p.y - b.pos.y) + Math.abs(p.z - b.pos.z) > 40) {
        traj.compute(world, world.lastTouch ? world.lastTouch.carId : -1);
      }
    }
  }

  // Demos while the ball is out of play (goal celebration) still count.
  function onDemosOnly(worldEvents) { for (const e of worldEvents) if (e.type === EV.DEMO) onDemo(e); }

  // ------------------------------------------------------------------ goals
  // Returns {scorerId, assistId, ownGoal}. Awards goal/assist/shot/bonus points.
  function onGoal(team, { overtime = false, enabled = true } = {}) {
    const tick = world.tick;
    for (const seg of [...pending.values()]) finalize(seg, tick, enabled);
    const last = history[history.length - 1];
    let scorerSeg = null;
    for (let i = history.length - 1; i >= 0; i--) if (history[i].team === team) { scorerSeg = history[i]; break; }
    const ownGoal = !!last && last.team !== team;
    const scorerId = scorerSeg ? scorerSeg.carId : -1;
    let assistId = -1;
    if (scorerSeg && !ownGoal) {
      for (let i = history.indexOf(scorerSeg) - 1; i >= 0; i--) {
        const h = history[i];
        if (h.carId === scorerId) continue;
        if (tick - h.lastTick > R.ASSIST_WINDOW_SEC * TPS) break;
        if (h.team === team) { assistId = h.carId; break; }
      }
    }
    if (enabled && scorerId >= 0) {
      const s = team === 0 ? 1 : -1;
      if (!ownGoal && !(possession.carId === scorerId && possession.credited.has('shot'))) creditShot(scorerId);
      const p = player(scorerId);
      p.goals++;
      award(scorerId, 'goal');
      if (!ownGoal) {
        if (scorerSeg.aerial) award(scorerId, 'aerialGoal');
        if (scorerSeg.backwards) award(scorerId, 'backwardsGoal');
        if (scorerSeg.turtle) award(scorerId, 'turtleGoal');
        if (scorerSeg.ball.y * s < R.LONG_GOAL_Y) award(scorerId, 'longGoal');
      }
      if (overtime) award(scorerId, 'overtimeGoal');
      if (p.goals === R.FEAT_COUNT) award(scorerId, 'hatTrick');
      if (assistId >= 0) {
        const a = player(assistId);
        a.assists++;
        award(assistId, 'assist');
        if (a.assists === R.FEAT_COUNT) award(assistId, 'playmaker');
      }
    }
    pending.clear();
    traj.invalidate();
    return { scorerId, assistId, ownGoal };
  }

  // MVP: highest score on the winning team; ties -> alphabetical by name (RL rule).
  function mvp(winner) {
    let best = null;
    for (const p of players) {
      if (p.team !== winner) continue;
      if (!best || p.score > best.score || (p.score === best.score && p.name.localeCompare(best.name) < 0)) best = p;
    }
    return best ? best.carId : null;
  }

  return {
    players, player, syncPlayers, onKickoff, onTick, onDemosOnly, onGoal, mvp,
    get kickoffTouched() { return kickoffTouched; },
    trajectory: traj,
    get history() { return history; },
  };
}
