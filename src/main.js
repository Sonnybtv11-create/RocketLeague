// TURBO PITCH — main integration (lead-owned).
// Fixed 120 Hz simulation with an accumulator (max 8 ticks/frame), uncapped
// rendering with interpolation between the last two physics states.
import * as THREE from 'three';
import { World } from './sim/world.js';
import { BallPredictor } from './sim/ball.js';
import * as K from './sim/const.js';
import { arenaSDF, arenaNormal, arenaRaycast, arenaRing, arenaProfile, ARENA_PARAMS } from './sim/arena.js';
import { CAR_CONFIGS } from './sim/carconfig.js';
import { QUALITY, CAR_BODIES, EV, TEAM_COLORS, makeControls, GAME_TITLE } from './contracts.js';
import { captureFrame, interpolateFrames } from './game/view.js';
import { loadAll, saveAll } from './game/settings.js';
import { simToThree } from './render/util.js';
import { createEnvironment } from './render/environment.js';
import { createCarModel, createBallModel } from './render/cars.js';
import { createVFX } from './render/vfx.js';
import { createPost } from './render/post.js';
import { createCameraController } from './camera/camera.js';
import { createInput } from './input/input.js';
import { createAudio } from './audio/audio.js';
import { createUI } from './ui/ui.js';
import { createBot } from './bots/bot.js';
import { createMatch } from './game/match.js';

const params = new URLSearchParams(location.search);
const { settings, stats } = loadAll();
if (params.get('q')) settings.graphics.quality = params.get('q');

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('shot') });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 2000);

const ctx = {
  THREE, renderer, scene, camera, canvas, settings,
  get quality() { return QUALITY[settings.graphics.quality] || QUALITY.high; },
  get qualityName() { return settings.graphics.quality; },
  arena: { sdf: arenaSDF, normal: arenaNormal, raycast: arenaRaycast, ring: arenaRing, profile: arenaProfile, params: ARENA_PARAMS },
  carConfigs: CAR_CONFIGS,
};

let _lastSize = '';
function applyRenderScale() {
  const q = ctx.quality;
  const pr = Math.min(devicePixelRatio || 1, q.maxPixelRatio || 2) * q.renderScale * (settings.graphics.renderScale || 1);
  const key = `${innerWidth}x${innerHeight}@${pr}`;
  if (key === _lastSize) return; // avoid canvas / render-target reallocation when nothing changed
  _lastSize = key;
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  post && post.setSize(innerWidth, innerHeight, pr);
}

// ---------------------------------------------------------------- modules
const env = createEnvironment(ctx);
scene.add(env.object3d);
const post = createPost(ctx);
const vfx = createVFX(ctx);
const camCtl = createCameraController(ctx);
const audio = createAudio({ settings });
const ballModel = createBallModel(ctx);
scene.add(ballModel.object3d);
applyRenderScale();
let _resizeT = 0;
addEventListener('resize', () => { clearTimeout(_resizeT); _resizeT = setTimeout(applyRenderScale, 120); });

let carModels = new Map(); // carId -> model
function syncCarModels(world) {
  const ids = new Set(world.cars.map((c) => c.id));
  for (const [id, m] of carModels) if (!ids.has(id)) { scene.remove(m.object3d); m.dispose && m.dispose(); carModels.delete(id); }
  for (const c of world.cars) {
    const key = `${c.bodyId}|${c.team}|${c.accent}`;
    let m = carModels.get(c.id);
    if (m && m._key !== key) { scene.remove(m.object3d); m.dispose && m.dispose(); m = null; }
    if (!m) {
      m = createCarModel(ctx, { bodyId: c.bodyId, hitbox: c.hitbox, team: c.team, accent: c.accent, name: c.name, isPlayer: !c.isBot });
      m._key = key;
      scene.add(m.object3d);
      carModels.set(c.id, m);
    }
  }
}

// ---------------------------------------------------------------- game session
const game = {
  world: null, match: null, bots: new Map(), playerCarId: -1, mode: 'menu',
  prevFrame: null, curFrame: null, acc: 0, paused: false, cfg: null,
  events: [], predictor: new BallPredictor(),
};
window.__game = game; // debug / automation hook
window.__render = { renderer, scene, camera, ctx };

const MENU_CAR_SHIFT = -90; // uu; negative moves the car left on screen
const BOT_NAMES = ['Nova', 'Blitz', 'Comet', 'Rook', 'Viper', 'Echo', 'Jolt', 'Titan', 'Pulse', 'Drift'];

function bodyHitbox(bodyId) { return (CAR_BODIES.find((b) => b.id === bodyId) || CAR_BODIES[0]).hitbox; }

function newSession(cfg, mode) {
  const world = new World();
  game.world = world; game.cfg = cfg; game.mode = mode;
  game.bots = new Map();
  const playerTeam = cfg.playerTeam ?? settings.game.team ?? 0;
  const teamSize = cfg.teamSize || 1;
  const bodyId = cfg.bodyId || settings.game.carBody;
  const player = cfg.spectate ? null : world.addCar({ team: playerTeam, hitbox: bodyHitbox(bodyId), bodyId, name: settings.game.playerName || 'Player', isBot: false });
  if (player) { player.accent = cfg.accent || settings.game.accent; player.dodgeDeadzone = settings.controls.dodgeDeadzone; }
  game.playerCarId = player ? player.id : -1;
  if (mode === 'exhibition') {
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const bodies = CAR_BODIES.map((b) => b.id);
    for (let t = 0; t < 2; t++) {
      const size = t === 0 ? (cfg.blueSize || teamSize) : (cfg.orangeSize || teamSize);
      const n = Math.max(0, size - (player && player.team === t ? 1 : 0));
      for (let i = 0; i < n; i++) {
        const bid = bodies[Math.floor(Math.random() * bodies.length)];
        const diff = (t === playerTeam ? cfg.teammateDifficulty : cfg.opponentDifficulty) || cfg.difficulty || 'pro';
        const car = world.addCar({ team: t, hitbox: bodyHitbox(bid), bodyId: bid, name: names.pop() || 'Bot', isBot: true });
        car.accent = '#d0d0d0';
        car.difficulty = diff;
        game.bots.set(car.id, createBot({ difficulty: diff, carId: car.id, team: t, rng: Math.random }));
      }
    }
  }
  world.unlimitedBoost = mode === 'freeplay' && settings.game.freeplay.unlimitedBoost;
  world.resetKickoff();
  if (mode === 'freeplay' && player) {
    player.setSpawn(0, -2500, K.CAR_SPAWN_REST_Z, Math.PI / 2, 100);
    world.ball.reset(0, 0, K.BALL_REST_Z + 300);
    world.ball.body.vel.set(0, 0, -1);
  }
  game.match = createMatch({ world, mode, teamSize, durationSec: cfg.durationSec || 300, rng: Math.random });
  syncCarModels(world);
  vfx.clear && vfx.clear();
  game.prevFrame = captureFrame(world, game.match);
  game.curFrame = game.prevFrame;
  game.acc = 0;
  game.paused = false;
  input.setEnabled(true);
  input.resetBallCam && input.resetBallCam();
  ui.hideMenus();
  audio.unlock && audio.unlock();
}

// Menu background: a car on the pitch, slow orbit camera
function menuScene() {
  const world = new World();
  const bodyId = settings.game.carBody;
  const car = world.addCar({ team: settings.game.team || 0, hitbox: bodyHitbox(bodyId), bodyId, name: settings.game.playerName, isBot: false });
  car.accent = settings.game.accent;
  car.setSpawn(0, -600, K.CAR_SPAWN_REST_Z, Math.PI / 2 + 0.6);
  world.ball.reset(0, 2600, K.BALL_KICKOFF_Z);
  for (let i = 0; i < 60; i++) world.step();
  game.world = world; game.match = null; game.mode = 'menu'; game.bots = new Map(); game.playerCarId = car.id;
  syncCarModels(world);
  game.prevFrame = captureFrame(world, null); game.curFrame = game.prevFrame;
  input.setEnabled(false);
}

// ---------------------------------------------------------------- input / UI
const input = createInput({ canvas, settings, onAction });
game.input = input;
function onAction(name, down = true) {
  audio.unlock && audio.unlock();
  if (name === 'pause') {
    if (game.mode === 'menu') return;
    if (game.match && game.match.isEnded && game.match.isEnded()) return;
    if (game.paused) {
      if (ui.handleBack && ui.handleBack()) return; // Esc/B goes back one menu level first
      api.resumeGame();
    } else pauseGame();
  } else if (name === 'resetBall') {
    if (game.mode === 'freeplay') api.resetBall();
  } else if (name === 'debug') {
    debugOn = !debugOn; ui.setDebug && ui.setDebug(debugOn);
  } else if (name === 'skipReplay') {
    game.match && game.match.skipReplay();
  } else if (name === 'scoreboard') {
    scoreboardOpen = !!down;
    ui.showScoreboard && ui.showScoreboard(down);
  }
}
let debugOn = false;
let scoreboardOpen = false;
function pauseGame() { game.paused = true; input.setEnabled(false); ui.showPause(); audio.setPaused && audio.setPaused(true); }

let _appliedQuality = settings.graphics.quality;
const api = {
  startMatch(cfg) { settings.game.lastMode = { ...settings.game.lastMode, ...cfg }; saveAll(settings, stats); newSession(cfg, 'exhibition'); },
  startFreePlay(cfg = {}) { newSession({ teamSize: 1, ...cfg }, 'freeplay'); },
  resumeGame() { game.paused = false; input.setEnabled(true); ui.hideMenus(); audio.setPaused && audio.setPaused(false); },
  quitToMenu() { game.paused = false; menuScene(); ui.showMainMenu(); audio.setPaused && audio.setPaused(false); },
  rematch() { if (game.cfg) newSession(game.cfg, game.mode === 'menu' ? 'exhibition' : game.mode); },
  settingsChanged() {
    applyRenderScale();
    if (settings.graphics.quality !== _appliedQuality) {
      _appliedQuality = settings.graphics.quality;
      env.setQuality && env.setQuality(settings.graphics.quality);
      post.setQuality && post.setQuality(settings.graphics.quality);
      vfx.setQuality && vfx.setQuality(settings.graphics.quality);
    }
    audio.setVolumes && audio.setVolumes(settings.audio);
    for (const c of game.world ? game.world.cars : []) if (!c.isBot) c.dodgeDeadzone = settings.controls.dodgeDeadzone;
    if (game.world && game.mode === 'freeplay') game.world.unlimitedBoost = settings.game.freeplay.unlimitedBoost;
    saveAll(settings, stats);
  },
  saveSettings() { saveAll(settings, stats); },
  getInput() { return input; },
  getSettings() { return settings; },
  getStats() { return stats; },
  async runSelfTests(onLine) {
    const mod = await import('./tests/selftest.js');
    return mod.runAllAsync(null, onLine || console.log);
  },
  setPreviewCar(bodyId, accent, team) {
    settings.game.carBody = bodyId; if (accent) settings.game.accent = accent; if (team !== undefined) settings.game.team = team;
    if (game.mode === 'menu') menuScene();
  },
  skipReplay() { game.match && game.match.skipReplay(); },
  resetBall() {
    if (game.mode !== 'freeplay' || !game.world) return;
    const w = game.world, car = w.getCar(game.playerCarId);
    w.ball.reset(0, 0, K.BALL_REST_Z + 300); w.ball.body.vel.set(0, 0, -1);
    if (car) car.setSpawn(0, -2500, K.CAR_SPAWN_REST_Z, Math.PI / 2, 100);
    game.prevFrame = captureFrame(w, game.match); game.curFrame = game.prevFrame;
    game.match && game.match.resetBall && game.match.resetBall();
  },
  getGame() { return game; },
  isFreePlay() { return game.mode === 'freeplay'; },
};
const ui = createUI({ root: document.getElementById('ui-root'), api, settings, stats });

// ---------------------------------------------------------------- prediction line (free play)
const predLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.8 }));
predLine.frustumCulled = false;
scene.add(predLine);
let predTick = -1;
function updatePrediction() {
  const show = game.mode === 'freeplay' && settings.game.freeplay.predictionLine && game.world;
  predLine.visible = !!show;
  if (!show || predTick === game.world.tick) return;
  // recompute only after a touch/bounce or every 0.25 s (the ball's path is deterministic otherwise)
  const touched = game.world.ballTouchedThisTick.length > 0 || game.world.events.some((e) => e.type === EV.BALL_BOUNCE);
  if (!touched && predTick >= 0 && game.world.tick - predTick < 30 && game.world.tick > predTick) return;
  predTick = game.world.tick;
  const b = game.world.ball.body;
  const pts = game.predictor.predict({ pos: b.pos, vel: b.vel, angVel: b.angVel }, 4, 4).map((p) => simToThree(p.pos));
  predLine.geometry.setFromPoints(pts);
}

// ---------------------------------------------------------------- module guard
const _errOnce = new Set();
function safe(name, fn) {
  try { return fn(); } catch (e) {
    if (!_errOnce.has(name)) { _errOnce.add(name); console.error(`[${name}]`, e); }
  }
}

// ---------------------------------------------------------------- main loop
let last = performance.now();
let fps = 60, fpsAcc = 0, fpsN = 0;
const frameEvents = [];

function physicsTick() {
  const w = game.world, m = game.match;
  // human input (sampled every tick from the latest state; presses are buffered)
  if (game.playerCarId >= 0) {
    const car = w.getCar(game.playerCarId);
    if (car) car.controls = input.sampleTick();
  }
  for (const [id, bot] of game.bots) {
    const car = w.getCar(id);
    if (!car) continue;
    car.controls = bot.tick(w, m ? m.getView() : null, w.dt);
    if (bot.events && bot.events.length) { frameEvents.push(...bot.events); bot.events.length = 0; }
  }
  m && m.preTick();
  w.step();
  frameEvents.push(...w.events);
  if (m) {
    const mev = m.postTick(w.events);
    if (mev && mev.length) frameEvents.push(...mev);
  }
  game.prevFrame = game.curFrame;
  game.curFrame = captureFrame(w, m);
  m && m.recordFrame && m.recordFrame(game.curFrame);
}

function frame(now) {
  requestAnimationFrame(frame);
  const cap = settings.graphics.fpsCap || 0;
  if (cap > 0 && now - last < 1000 / cap - 1) return;
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.25) dt = 0.25;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

  input.poll(now);
  let view, camOpts;
  const w = game.world;
  if (!w) return;

  const replay = game.match && game.match.getReplayView ? game.match.getReplayView() : null;
  if (game.mode === 'menu') {
    // idle showroom: keep stepping so suspension settles; slow orbit
    game.acc += dt;
    let n = 0;
    while (game.acc >= K.TICK_TIME && n < 8) { w.step(); game.prevFrame = game.curFrame; game.curFrame = captureFrame(w, null); game.acc -= K.TICK_TIME; n++; }
    view = interpolateFrames(game.prevFrame, game.curFrame, game.acc / K.TICK_TIME);
    // showroom turntable: car ~35-40% of screen width, framed in the left part of the screen
    const t = now / 1000 * 0.18;
    const car = view.cars[0];
    const R = 380, cx = Math.cos(t), cy = Math.sin(t);
    // shift the look target sideways (perpendicular to the view) so the car sits left of centre
    const side = MENU_CAR_SHIFT;
    const tx = car.pos.x + (-cy) * side, ty = car.pos.y + cx * side;
    camOpts = { mode: 'fixed', fixed: { fov: 34, pos: { x: car.pos.x + cx * R, y: car.pos.y + cy * R, z: 110 }, target: { x: tx, y: ty, z: 35 } } };
  } else if (!game.paused) {
    if (game.match && game.match.frameUpdate) game.match.frameUpdate(dt);
    const inReplay = game.match && game.match.state === 'replay';
    if (!inReplay) {
      game.acc += dt;
      let n = 0;
      while (game.acc >= K.TICK_TIME && n < 8) { physicsTick(); game.acc -= K.TICK_TIME; n++; }
      if (n === 8) game.acc = 0; // clamp (tab switch etc.)
    }
  }
  if (game.mode !== 'menu') {
    if (replay) {
      view = replay.view; view.isReplay = true;
      camOpts = { mode: 'replay', hint: replay.cameraHint, targetCarId: replay.cameraHint && replay.cameraHint.targetCarId };
    } else {
      view = interpolateFrames(game.prevFrame, game.curFrame, Math.min(game.acc / K.TICK_TIME, 1));
      camOpts = { mode: game.playerCarId >= 0 ? 'car' : 'spectator', targetCarId: game.playerCarId, ballCam: input.isBallCam(), look: input.getLook() };
    }
  }
  view.match = game.match ? game.match.getView() : null;
  view.hideNameplates = game.mode === 'menu' || game.paused || scoreboardOpen || !!(ui.isMenuOpen && ui.isMenuOpen()) || !!(view.match && view.match.state === 'ended');
  if (params.has('cam')) {
    const c = params.get('cam').split(',').map(Number);
    camOpts = { mode: 'fixed', fixed: { pos: { x: c[0], y: c[1], z: c[2] }, target: { x: c[3], y: c[4], z: c[5] } } };
  }

  // render modules
  safe('env', () => env.update(view, dt));
  safe('ball', () => ballModel.update(view.ball, dt, view));
  safe('cars', () => {
    for (const cv of view.cars) {
      const m = carModels.get(cv.id);
      if (m) m.update(cv, dt, view);
    }
  });
  const evs = frameEvents.splice(0);
  safe('vfx.events', () => vfx.onEvents(evs, view));
  safe('camera', () => camCtl.update(view, camOpts, dt));
  safe('vfx', () => vfx.update(view, dt, camera));
  safe('prediction', updatePrediction);
  const pc = view.cars.find((c) => c.id === game.playerCarId);
  safe('audio.events', () => audio.onEvents(evs, view));
  safe('audio', () => audio.update(view, { pos: camera.position, quaternion: camera.quaternion, playerCarId: game.playerCarId, camera }, dt));
  safe('ui.events', () => ui.onEvents(evs, view));
  safe('ui', () => ui.update(view, dt, { fps, playerCarId: game.playerCarId, tick: w.tick, ballCam: input.isBallCam(), inputDevice: input.lastDevice, mode: game.mode, paused: game.paused, playerCar: pc, world: w }));
  game.fps = fps;
  for (const e of evs) {
    if (e.type === EV.MATCH_END) onMatchEnd(e);
    if ((e.type === EV.DEMO || e.type === EV.GOAL) && settings.camera.shake) camCtl.shake(e.type === EV.GOAL ? 1 : 0.6);
  }
  safe('post', () => post.render());
}

function onMatchEnd(e) {
  const mv = game.match.getView();
  const me = mv.players && mv.players.find((p) => p.carId === game.playerCarId);
  stats.matches++;
  if (me) {
    if (mv.winner === me.team) stats.wins++;
    stats.goals += me.goals || 0; stats.assists += me.assists || 0; stats.saves += me.saves || 0;
    stats.shots += me.shots || 0; stats.demos += me.demos || 0;
    if (mv.mvpId === me.carId) stats.mvps++;
  }
  saveAll(settings, stats);
  input.setEnabled(false);
  ui.showEndScreen(mv);
}

// ---------------------------------------------------------------- boot
document.title = GAME_TITLE;
menuScene();
const scen = params.get('scene');
if (scen === 'kickoff' || scen === 'match') newSession({ teamSize: Number(params.get('size') || 3), difficulty: params.get('diff') || 'allstar', playerTeam: 0 }, 'exhibition');
else if (scen === 'freeplay') api.startFreePlay({});
else if (scen === 'spectate') newSession({ teamSize: Number(params.get('size') || 3), difficulty: params.get('diff') || 'allstar', spectate: true }, 'exhibition');
else ui.showMainMenu();
// optional: advance simulated time for screenshots (?advance=seconds)
if (params.get('advance') && game.world) {
  const n = Math.round(Number(params.get('advance')) * 120);
  for (let i = 0; i < n; i++) physicsTick();
  game.prevFrame = game.curFrame;
}
if (params.has('debug')) { debugOn = true; ui.setDebug && ui.setDebug(true); }
requestAnimationFrame((t) => { last = t; frame(t); });
// Precompile every shader (incl. VFX that first appear at GO / first goal / first demo) so play never hitches.
(async () => {
  const restore = vfx.prewarm ? vfx.prewarm() : null;
  try { if (renderer.compileAsync) await renderer.compileAsync(scene, camera); } catch (e) { /* optional */ }
  if (restore) restore();
})();
window.__ready = true;
