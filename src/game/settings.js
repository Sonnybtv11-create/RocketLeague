// Settings, key bindings and lifetime stats persisted in localStorage.
// Every storage access is wrapped in try/catch: the game runs without storage.

const KEY = 'turbopitch.v1';

export const DEFAULT_BINDINGS = {
  // keyboard/mouse: values are KeyboardEvent.code or 'Mouse0'/'Mouse1'/'Mouse2'
  kb: {
    throttle: ['KeyW'],
    reverse: ['KeyS'],
    steerLeft: ['KeyA'],
    steerRight: ['KeyD'],
    pitchUp: ['ArrowDown'],      // nose up (pull back)
    pitchDown: ['ArrowUp'],      // nose down
    yawLeft: ['ArrowLeft'],
    yawRight: ['ArrowRight'],
    jump: ['Mouse2'],
    boost: ['Mouse0'],
    powerslide: ['ShiftLeft'],
    airRollLeft: ['KeyQ'],
    airRollRight: ['KeyE'],
    ballCam: ['Space'],
    resetBall: ['KeyR'],
    scoreboard: ['Tab'],
    pause: ['Escape'],
  },
  // gamepad: standard mapping button indices / axes
  pad: {
    throttle: 'b7',      // RT (analog)
    reverse: 'b6',       // LT (analog)
    jump: 'b0',          // A
    boost: 'b1',         // B
    powerslide: 'b2',    // X
    ballCam: 'b3',       // Y
    airRollLeft: 'b4',   // LB
    airRollRight: 'b5',  // RB
    scoreboard: 'b8',    // Back/View
    pause: 'b9',         // Start/Menu
    resetBall: 'b12',    // dpad up
    steerAxis: 'a0',
    pitchAxis: 'a1',
    lookX: 'a2',
    lookY: 'a3',
  },
};

export const DEFAULT_SETTINGS = {
  camera: {
    fov: 110, distance: 270, height: 100, angle: -4, stiffness: 0.45,
    swivelSpeed: 5, transitionSpeed: 1.2, shake: true, ballCamDefault: true, ballCamMode: 'toggle', // or 'hold'
    invertSwivel: false,
  },
  controls: {
    deadzone: 0.2,          // controller stick deadzone
    dodgeDeadzone: 0.5,
    aerialSensitivity: 1.0,
    steeringSensitivity: 1.0,
    deadzoneShape: 'cross',
    mouseAirPitch: false,   // mouse movement controls air pitch/yaw
    mouseSensitivity: 1.0,
    kbAirRollMode: 'yaw',   // A/D: 'yaw' in air (default) ; with powerslide held = roll
    invertPitch: false,
  },
  bindings: JSON.parse(JSON.stringify(DEFAULT_BINDINGS)),
  graphics: { quality: 'high', motionBlur: false, fpsCap: 0, showFps: false, nameplates: true, renderScale: 1.0 },
  audio: { master: 0.8, sfx: 0.9, crowd: 0.7, music: 0.0 },
  game: {
    playerName: 'Player', carBody: 'vector', accent: '#e8e8e8', team: 0,
    lastMode: { teamSize: 1, difficulty: 'pro' },
    freeplay: { predictionLine: true, unlimitedBoost: true },
  },
};

export const DEFAULT_STATS = { matches: 0, wins: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, mvps: 0 };

function deepMerge(base, over) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over === undefined ? base : over;
  const out = {};
  for (const k of Object.keys(base)) out[k] = deepMerge(base[k], over ? over[k] : undefined);
  if (over && typeof over === 'object') for (const k of Object.keys(over)) if (!(k in out)) out[k] = over[k];
  return out;
}

export function loadAll() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
  return {
    settings: deepMerge(DEFAULT_SETTINGS, raw && raw.settings),
    stats: deepMerge(DEFAULT_STATS, raw && raw.stats),
  };
}

export function saveAll(settings, stats) {
  try { localStorage.setItem(KEY, JSON.stringify({ settings, stats })); return true; } catch (e) { return false; }
}

export function resetSettings() { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
