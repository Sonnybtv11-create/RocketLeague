// TURBO PITCH — main integration (lead-owned).
// Fixed 120 Hz simulation with an accumulator (max 8 ticks/frame), uncapped
// rendering with interpolation between the last two physics states.
import * as THREE from 'three';
import { World } from './sim/world.js';
import { BallPredictor } from './sim/ball.js';
import { applyModifiers } from './game/modifiers.js';
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
import { createNetHost, createNetClient } from './net/session.js';

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
  net: null,      // LAN session: createNetHost() / createNetClient() result
  lan: null,      // 'host' | 'client' while a LAN match is running
};
window.__game = game; // debug / automation hook
window.__render = { renderer, scene, camera, ctx };

const MENU_CAR_SHIFT = -40;   // uu; negative moves the car left on screen
const MENU_CAM_ANGLE = -0.8;  // camera bearing relative to the car's heading (rad): nose towards screen-left
const MENU_CAM_DIST = 290;
const BOT_NAMES = ['Nova', 'Blitz', 'Comet', 'Rook', 'Viper', 'Echo', 'Jolt', 'Titan', 'Pulse', 'Drift'];

const DEFAULT_DODGE_DEADZONE = 0.5;
function rosterOf(world) {
  return world.cars.map((c) => ({ id: c.id, team: c.team, name: c.name, isBot: !!c.isBot, bodyId: c.bodyId, hitbox: c.hitbox, accent: c.accent }));
}
function bodyHitbox(bodyId) { return (CAR_BODIES.find((b) => b.id === bodyId) || CAR_BODIES[0]).hitbox; }

function newSession(cfg, mode) {
  applyModifiers(cfg);
  const world = new World();
  game.world = world; game.cfg = cfg; game.mode = mode;
  game.bots = new Map();
  const playerTeam = cfg.playerTeam ?? settings.game.team ?? 0;
  const teamSize = cfg.teamSize || 1;
  const bodyId = cfg.bodyId || settings.game.carBody;
  const player = cfg.spectate ? null : world.addCar({ team: playerTeam, hitbox: bodyHitbox(bodyId), bodyId, name: settings.game.playerName || 'Player', isBot: false });
  if (player) { player.accent = cfg.accent || settings.game.accent; player.dodgeDeadzone = settings.controls.dodgeDeadzone; }
  game.playerCarId = player ? player.id : -1;
  // LAN: one car per connected joiner (their controls arrive over the network)
  const humans = [0, 0];
  if (player) humans[player.team]++;
  const lanSlots = game.lan === 'host' && game.net ? game.net.connected() : [];
  for (const s of lanSlots) {
    const car = world.addCar({ team: s.team, hitbox: bodyHitbox(s.bodyId), bodyId: s.bodyId, name: s.name, isBot: false });
    car.accent = s.accent; car.dodgeDeadzone = DEFAULT_DODGE_DEADZONE;
    s.carId = car.id; s.queue.length = 0;
    humans[s.team]++;
  }
  if (mode === 'exhibition') {
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const bodies = CAR_BODIES.map((b) => b.id);
    for (let t = 0; t < 2; t++) {
      const size = cfg.noBots ? 0 : t === 0 ? (cfg.blueSize || teamSize) : (cfg.orangeSize || teamSize);
      const n = Math.max(0, size - humans[t]);
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
  if (lanSlots.length) {
    const roster = rosterOf(world);
    for (const s of lanSlots) s.link.send({ t: 'start', you: s.carId, roster, cfg: { teamSize, durationSec: cfg.durationSec || 300 } });
    game.netSentTick = -1; game.netMvAt = 0;
  }
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
  car.setSpawn(-900, -1500, K.CAR_SPAWN_REST_Z, Math.PI / 2 + 0.6); // clear of boost pads, stands behind
  world.ball.reset(0, 2600, K.BALL_KICKOFF_Z);
  for (let i = 0; i < 60; i++) world.step();
  game.world = world; game.match = null; game.mode = 'menu'; game.bots = new Map(); game.playerCarId = car.id;
  syncCarModels(world);
  game.prevFrame = captureFrame(world, null); game.curFrame = game.prevFrame;
  input.setEnabled(false);
}

// ---------------------------------------------------------------- LAN play
// Host: runs the real simulation and match, takes joiners' controls each tick, streams snapshots,
// events and the match view. Joiner: renders the host's snapshots with a local copy of the arena.
function lanChanged() { ui.refreshMenu && ui.refreshMenu(); }
function lanClose() {
  if (game.net) { game.net.close(); game.net = null; }
  game.lan = null;
}
function hostPlayerLeft(s) {
  // mid-match: a bot takes over the car
  if (game.lan !== 'host' || !game.world) return;
  const car = game.world.getCar(s.carId);
  if (!car || game.bots.has(car.id)) return;
  car.isBot = true; car.difficulty = 'pro';
  game.bots.set(car.id, createBot({ difficulty: 'pro', carId: car.id, team: car.team, rng: Math.random }));
  game.net.broadcast({ t: 'ev', e: [{ type: 'netLeave', name: s.name }] });
}
function clientStart(m) {
  const world = new World();
  for (const r of [...m.roster].sort((a, b) => a.id - b.id)) {
    const car = world.addCar({ team: r.team, hitbox: r.hitbox, bodyId: r.bodyId, name: r.name, isBot: r.isBot });
    car.id = r.id; car.accent = r.accent;
  }
  world.resetKickoff();
  world.carsFrozen = true;
  const client = game.net;
  client.setStatic(m.roster, world.pads);
  client.matchView = {
    mode: 'exhibition', state: 'countdown', clockSec: (m.cfg && m.cfg.durationSec) || 300, isOvertime: false, overtimeSec: 0, countdown: 3,
    scores: [0, 0], players: m.roster.map((r) => ({ carId: r.id, name: r.name, team: r.team, isBot: r.isBot, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, score: 0 })),
    lastGoal: null, winner: null, mvpId: null, replayActive: false, ballHidden: false, waitingForBallToLand: false, isKickoffPause: false,
  };
  game.world = world; game.mode = 'exhibition'; game.lan = 'client'; game.cfg = { teamSize: (m.cfg && m.cfg.teamSize) || 1, lan: true };
  game.bots = new Map(); game.playerCarId = m.you;
  game.match = {
    get state() { return client.matchView.state; },
    getView: () => client.matchView,
    isEnded: () => client.matchView.state === 'ended',
    getReplayView: () => null,
    skipReplay() {}, frameUpdate() {}, preTick() {}, postTick() { return []; }, recordFrame() {}, resetBall() {},
  };
  syncCarModels(world);
  vfx.clear && vfx.clear();
  game.prevFrame = captureFrame(world, null); game.curFrame = game.prevFrame;
  game.acc = 0; game.paused = false;
  input.setEnabled(true);
  input.resetBallCam && input.resetBallCam();
  ui.hideMenus();
  audio.unlock && audio.unlock();
}
function clientLeft(reason) {
  game.lanNotice = reason;
  const wasPlaying = game.lan === 'client';
  game.net = null; game.lan = null;
  if (wasPlaying) { game.paused = false; menuScene(); }
  ui.showLanMenu ? ui.showLanMenu() : ui.showMainMenu();
}
// host: after the frame's ticks, stream the world (60 Hz), events and match info to joiners
function hostSend(evs, replay, now) {
  const net = game.net;
  if (!net.connected().length) return;
  if (replay) {
    if (now - (game.netReplayAt || 0) >= 15) { game.netReplayAt = now; net.sendFrame(replay.view, replay.cameraHint || { mode: 'wide' }); }
  } else if (game.curFrame && game.curFrame.tick - game.netSentTick >= 2) {
    game.netSentTick = game.curFrame.tick;
    net.sendFrame(game.curFrame, null);
  }
  const mv = game.match && game.match.getView();
  if (mv && (evs.length || now - game.netMvAt > 100 || mv.state !== game.netMvState)) {
    game.netMvAt = now; game.netMvState = mv.state;
    net.broadcast({ t: 'mv', v: mv });
  }
  if (evs.length) net.broadcast({ t: 'ev', e: evs });
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
    if (game.lan !== 'client') game.match && game.match.skipReplay();
  } else if (name === 'scoreboard') {
    scoreboardOpen = !!down;
    ui.showScoreboard && ui.showScoreboard(down);
  }
}
let debugOn = false;
let scoreboardOpen = false;
function pauseGame() {
  game.paused = true; input.setEnabled(false); ui.showPause();
  if (!game.lan) audio.setPaused && audio.setPaused(true); // LAN matches keep running behind the menu
}

let _appliedQuality = settings.graphics.quality;
const api = {
  startMatch(cfg) { lanClose(); settings.game.lastMode = { ...settings.game.lastMode, ...cfg }; saveAll(settings, stats); newSession(cfg, 'exhibition'); },
  startFreePlay(cfg = {}) { lanClose(); newSession({ teamSize: 1, ...cfg }, 'freeplay'); },
  resumeGame() { game.paused = false; input.setEnabled(true); ui.hideMenus(); audio.setPaused && audio.setPaused(false); },
  quitToMenu() { lanClose(); game.paused = false; menuScene(); ui.showMainMenu(); audio.setPaused && audio.setPaused(false); },
  rematch() { if (game.lan === 'client') return; if (game.cfg) newSession(game.cfg, game.mode === 'menu' ? 'exhibition' : game.mode); },
  settingsChanged() {
    applyRenderScale();
    if (settings.graphics.quality !== _appliedQuality) {
      _appliedQuality = settings.graphics.quality;
      env.setQuality && env.setQuality(settings.graphics.quality);
      post.setQuality && post.setQuality(settings.graphics.quality);
      vfx.setQuality && vfx.setQuality(settings.graphics.quality);
    }
    env.setGrass && env.setGrass(settings.graphics.grass !== false);
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

  // ---- LAN play (see src/net/)
  lanSupported() { return typeof WebSocket !== 'undefined'; },
  lanRole() { return game.net ? game.net.role : null; },
  lanInMatch() { return !!game.lan; },
  lanHost() { return lanHost(); },
  lanState() {
    const n = game.net;
    return {
      role: n ? n.role : null, notice: game.lanNotice || '',
      slots: n && n.role === 'host' ? n.slots.map((s) => ({ id: s.id, status: s.status, team: s.team, name: s.name, mode: s.mode })) : [],
      code: n && n.role === 'host' ? n.code : '', relayStatus: n && n.role === 'host' ? n.relayStatus : 'off', relayError: n && n.role === 'host' ? n.relayError : '',
      client: n && n.role === 'client' ? { status: n.status, error: n.error, reason: n.reason, lobby: n.lobby, mode: n.mode } : null,
    };
  },
  lanRetryCode() { const h = lanHost(); return h.openLobby(); },
  lanSetTeam(id, team) {
    const n = game.net;
    if (!n || n.role !== 'host') return;
    if (id === 'host') { settings.game.team = team; n.hostTeam = team; n.sendLobby(); saveAll(settings, stats); if (game.mode === 'menu') menuScene(); } else n.setTeam(id, team);
  },
  lanSetInfo(text) { const n = game.net; if (n && n.role === 'host' && n.lobbyInfo !== text) { n.lobbyInfo = text; n.sendLobby(); } },
  lanRemove(id) { game.net && game.net.role === 'host' && game.net.remove(id); },
  lanStart(cfg) {
    const n = lanHost();
    n.hostName = settings.game.playerName || 'Host';
    settings.game.lastLan = { ...cfg };
    saveAll(settings, stats);
    game.lan = 'host';
    newSession({ ...cfg, playerTeam: settings.game.team || 0, bodyId: settings.game.carBody, accent: settings.game.accent }, 'exhibition');
  },
  async lanJoin(code) {
    if (game.net && game.net.role === 'host') lanClose();
    if (game.net) { game.net.close(); game.net = null; }
    game.lanNotice = '';
    const client = createNetClient({ onChange: lanChanged, onStart: clientStart, onEvents: (e) => frameEvents.push(...e), onLeave: clientLeft });
    game.net = client;
    const profile = { name: settings.game.playerName || 'Player', bodyId: settings.game.carBody, accent: settings.game.accent };
    const digits = String(code || '').replace(/\D/g, '');
    if (digits.length !== 6) { client.error = 'Game codes are 6 digits — check the number on the host’s screen.'; lanChanged(); return ''; }
    return client.joinCode(digits, profile);
  },
  lanLeave() { if (!game.lan) lanClose(); },
};
function lanHost() {
  if (game.net && game.net.role === 'host') return game.net;
  lanClose();
  game.lanNotice = '';
  const n = createNetHost({ onChange: lanChanged, onLeave: hostPlayerLeft });
  n.hostName = settings.game.playerName || 'Host';
  n.hostTeam = settings.game.team || 0;
  game.net = n;
  n.openLobby();
  return n;
}
window.__api = api; // debug / automation hook
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
  if (game.lan === 'host') {
    for (const c of w.cars) {
      if (c.isBot || c.id === game.playerCarId) continue;
      const k = game.net.takeControls(c.id);
      if (k) c.controls = k;
    }
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

  let replay = game.match && game.match.getReplayView ? game.match.getReplayView() : null;
  let netView = null;
  if (game.lan === 'client') {
    // joiner: sample controls at 120 Hz and send them; the host simulates
    game.acc += dt;
    let n = 0;
    const list = [];
    while (game.acc >= K.TICK_TIME && n < 8) { list.push(game.paused ? makeControls() : input.sampleTick()); game.acc -= K.TICK_TIME; n++; }
    if (n === 8) game.acc = 0;
    if (list.length && game.net) game.net.sendInputs(list);
    netView = game.net ? game.net.buildView(now) : null;
    if (netView && netView.hint) replay = { view: netView.view, cameraHint: netView.hint };
  } else if (game.mode === 'menu') {
    // idle showroom: keep stepping so suspension settles; slow orbit
    game.acc += dt;
    let n = 0;
    while (game.acc >= K.TICK_TIME && n < 8) { w.step(); game.prevFrame = game.curFrame; game.curFrame = captureFrame(w, null); game.acc -= K.TICK_TIME; n++; }
    view = interpolateFrames(game.prevFrame, game.curFrame, game.acc / K.TICK_TIME);
    // showroom: fixed three-quarter front view (nose towards screen-left) with a slow gentle sway,
    // car large and left of centre so the menu list overlaps its lower left like the classic stadium menu
    const car = view.cars[0];
    const heading = Math.atan2(car.forward.y, car.forward.x);
    const t = heading + MENU_CAM_ANGLE + Math.sin(now / 1000 * 0.22) * 0.1;
    const R = MENU_CAM_DIST, cx = Math.cos(t), cy = Math.sin(t);
    const side = MENU_CAR_SHIFT;
    const tx = car.pos.x + (-cy) * side, ty = car.pos.y + cx * side;
    camOpts = { mode: 'fixed', fixed: { fov: 38, pos: { x: car.pos.x + cx * R, y: car.pos.y + cy * R, z: 118 }, target: { x: tx, y: ty, z: 34 } } };
  } else if (!game.paused || game.lan) {
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
    } else if (game.lan === 'client') {
      view = netView ? netView.view : interpolateFrames(game.prevFrame, game.curFrame, 1);
      camOpts = { mode: 'car', targetCarId: game.playerCarId, ballCam: input.isBallCam(), look: input.getLook() };
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
  if (game.lan === 'host' && game.net) safe('net', () => hostSend(evs, replay, now));
  safe('vfx.events', () => vfx.onEvents(evs, view));
  safe('camera', () => camCtl.update(view, camOpts, dt));
  safe('vfx', () => vfx.update(view, dt, camera));
  safe('prediction', updatePrediction);
  const pc = view.cars.find((c) => c.id === game.playerCarId);
  safe('audio.events', () => audio.onEvents(evs, view));
  safe('audio', () => audio.update(view, { pos: camera.position, quaternion: camera.quaternion, playerCarId: game.playerCarId, camera }, dt));
  safe('ui.events', () => ui.onEvents(evs, view));
  safe('ui', () => ui.update(view, dt, { fps, playerCarId: game.playerCarId, tick: w.tick, ballCam: input.isBallCam(), inputDevice: input.lastDevice, mode: game.mode, paused: game.paused, playerCar: pc, world: w, lan: game.lan }));
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
