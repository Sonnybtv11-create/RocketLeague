// =============================================================================
// TURBO PITCH — shared contracts (owned by the lead; do not edit without the lead)
// =============================================================================
// Every module codes against this file. It defines:
//   * arena dimensions (Unreal Units, 1 uu = 1 cm, Z-up, RL/RocketSim coordinates)
//   * team colours
//   * sim -> render conversion (RL is left-handed; we mirror by swapping Y/Z)
//   * the world-state schema produced by the simulation every tick
//   * the input (controls) schema consumed by the simulation
//   * the event schema (goal, demo, ballHit, ...)
//
// Coordinate conventions (simulation):
//   Field centre is the origin. Blue defends -Y, Orange defends +Y. Z is up.
//   Car local axes: X forward, Y right, Z up. Car rotation is a 3x3 matrix whose
//   COLUMNS are forward / right / up in world space (RocketSim "rotMat").
//   Yaw 0 faces +X; a blue kickoff yaw of PI/2 faces +Y.
//
// Render conventions (Three.js):
//   Y-up, metres. toRender(x,y,z) = (x, z, y) * 0.01. Swapping Y and Z is a
//   mirror, which turns RL's left-handed world into Three's right-handed one so
//   that "right" in the sim is "right" on screen.
// =============================================================================

export const UU_TO_M = 0.01;

export const ARENA = Object.freeze({
  EXTENT_X: 4096,          // side walls at x = ±4096
  EXTENT_Y: 5120,          // back walls (goal line) at y = ±5120
  HEIGHT: 2044,            // ceiling
  GOAL_DEPTH_Y: 6000,      // back of the net at y = ±6000 (depth 880)
  GOAL_HALF_WIDTH: 892.755,
  GOAL_HEIGHT: 642.775,
  CORNER_CATHETUS: 1152,   // 45° corner walls cut 1152 off each axis
  FLOOR_FILLET: 256,       // curved floor->wall transition radius
  CEIL_FILLET: 256,        // curved wall->ceiling transition radius
  CORNER_ROUND: 200,       // rounding of the vertical edges of the octagon
  GOAL_SCORE_Y: 5124.25,   // goal when |ball.y| > GOAL_SCORE_Y + ball radius
});

export const BALL_RADIUS = 91.25;

export const TEAM = Object.freeze({ BLUE: 0, ORANGE: 1 });

export const TEAM_COLORS = Object.freeze({
  0: { primary: 0x1f6bff, light: 0x6fa8ff, dark: 0x0a2a7a, glow: 0x2a8cff, css: '#2f7bff', name: 'BLUE' },
  1: { primary: 0xff7a14, light: 0xffb067, dark: 0x7a3000, glow: 0xff8a1f, css: '#ff8a1f', name: 'ORANGE' },
});

// ---- sim -> render conversion --------------------------------------------
// Position: (x, y, z)_sim  ->  (x, z, y)_three * 0.01
export function toRenderPos(v, out) {
  out.x = v.x * UU_TO_M;
  out.y = v.z * UU_TO_M;
  out.z = v.y * UU_TO_M;
  return out;
}
// Rotation: sim rotMat (columns fwd,right,up) -> Three.js Matrix4 elements.
// R_three = P * R_sim * P where P swaps y/z. P*R*P is a proper rotation.
// `m` is a rotMat object {m: Float64Array(9)} row-major (see sim/math.js),
// `out` is a THREE.Matrix4 (or anything with .set(...16 numbers)).
export function rotMatToRender(rm, out) {
  const a = rm.m; // row-major: a[r*3+c]
  // P R P: swap rows 1<->2 and columns 1<->2
  out.set(
    a[0], a[2], a[1], 0,
    a[6], a[8], a[7], 0,
    a[3], a[5], a[4], 0,
    0, 0, 0, 1
  );
  return out;
}
// Direction vector (no scaling)
export function toRenderDir(v, out) {
  out.x = v.x; out.y = v.z; out.z = v.y; return out;
}

// ---- Car body presets (hitbox classes) -----------------------------------
// Names of the six hitbox presets. Geometry lives in sim/carconfig.js.
export const HITBOX_PRESETS = ['OCTANE', 'DOMINUS', 'PLANK', 'BREAKOUT', 'HYBRID', 'MERC'];

// Original body designs offered in the garage. `hitbox` tells which preset
// the body uses. Car model agent builds one mesh per body id.
export const CAR_BODIES = [
  { id: 'vector',   name: 'Vector',   hitbox: 'OCTANE' },
  { id: 'lancer',   name: 'Lancer',   hitbox: 'DOMINUS' },
  { id: 'stingray', name: 'Stingray', hitbox: 'PLANK' },
  { id: 'arrowhead',name: 'Arrowhead',hitbox: 'BREAKOUT' },
  { id: 'nomad',    name: 'Nomad',    hitbox: 'HYBRID' },
  { id: 'bulwark',  name: 'Bulwark',  hitbox: 'MERC' },
];

// ---- Controls (input) schema ---------------------------------------------
// One per car per tick. Analog values are already deadzoned/sensitivity-scaled.
export function makeControls() {
  return {
    throttle: 0,   // -1..1
    steer: 0,      // -1..1  (+ = right)
    pitch: 0,      // -1..1  (+ = nose up; stick back)
    yaw: 0,        // -1..1  (+ = right)
    roll: 0,       // -1..1  (+ = roll right)
    jump: false,
    boost: false,
    handbrake: false,
    // not sim inputs, but carried through for UI/camera:
    ballCam: false,
  };
}

// ---- World state schema (read-only for everyone except the sim) -----------
// world.cars[i] (CarState) fields every consumer may read:
//   id, team (0/1), name, isBot, bodyId, hitbox (preset name)
//   pos {x,y,z}, vel {x,y,z}, angVel {x,y,z}, rot (RotMat, columns fwd/right/up)
//   boost (0..100), isBoosting, isSupersonic, supersonicTime
//   isOnGround, wheelsWithContact [4 bools] (FL, FR, BL, BR)
//   wheels: [ {suspLen, restLen, radius, steer, spin, contact, offset:{x,y,z}} x4 ]
//           offset = wheel hard point in car-local coords (for rendering)
//           suspLen = current suspension length (uu) along -up from hard point
//           spin = accumulated wheel rotation angle (rad), steer = steer angle (rad)
//   handbrakeVal, hasJumped, hasDoubleJumped, hasFlipped, isFlipping, isJumping
//   airTimeSinceJump, flipTime, isDemoed, demoRespawnTimer
//   controls (last applied Controls)
// world.ball: pos, vel, angVel, rot (RotMat)
// world.pads[i]: { pos {x,y,z}, isBig, isActive, cooldown }
// world.tick (int), world.time (s)
//
// Interpolation: renderers receive `alpha` in [0,1] and the previous snapshot
// (world.prev) — use sim/math.js lerp helpers or the provided
// `interp` object the game loop builds (see main.js: renderState).

// ---- Events ----------------------------------------------------------------
// Emitted by the sim / match into a per-tick array: world.events
// Each event: { type, tick, ...payload }
export const EV = Object.freeze({
  BALL_HIT: 'ballHit',          // {carId, impulse (uu/s delta-v on ball), pos, ballVel}
  BALL_BOUNCE: 'ballBounce',    // {pos, normal, speed}  (ball vs world)
  CAR_BUMP: 'carBump',          // {attackerId, victimId, pos, speed}
  DEMO: 'demo',                 // {attackerId, victimId, pos}
  RESPAWN: 'respawn',           // {carId}
  JUMP: 'jump',                 // {carId}
  DOUBLE_JUMP: 'doubleJump',    // {carId}
  DODGE: 'dodge',               // {carId, dir:{x,y}}
  LAND: 'land',                 // {carId, speed (vertical impact speed), pos}
  WALL_SCRAPE: 'wallScrape',    // {carId, pos, speed}
  SUPERSONIC_START: 'supersonicStart', // {carId}
  BOOST_START: 'boostStart',    // {carId}
  BOOST_END: 'boostEnd',        // {carId}
  PAD_PICKUP: 'padPickup',      // {carId, padIndex, isBig, pos}
  GOAL: 'goal',                 // {team (scoring team), scorerId, assistId, pos, ballSpeed}
  KICKOFF_COUNTDOWN: 'kickoffCountdown', // {n: 3|2|1}
  KICKOFF_GO: 'kickoffGo',      // {}
  MATCH_END: 'matchEnd',        // {winner}
  OVERTIME: 'overtime',         // {}
  STAT: 'stat',                 // {carId, kind: 'goal'|'assist'|'save'|'epicSave'|'shot'|'demo'|'clear'|'centre'|'aerialHit'|'firstTouch', points}
  QUICK_CHAT: 'quickChat',      // {carId, text}
  REPLAY_START: 'replayStart',  // {}
  REPLAY_END: 'replayEnd',      // {}
});

// ---- Quality presets -------------------------------------------------------
export const QUALITY = Object.freeze({
  // maxPixelRatio caps devicePixelRatio (Retina 2.0 is too many pixels for 120 Hz with MSAA+bloom);
  // msaa = scene MSAA samples (0 = FXAA/none); bloomScale = bloom chain resolution relative to the canvas.
  low:    { name: 'Low',    shadowMap: 1024, particles: 0.35, renderScale: 0.75, maxPixelRatio: 1.0,  msaa: 0, bloomScale: 0,   bloom: false, ssao: false, crowd: 0.25, reflections: 0, antialias: false },
  medium: { name: 'Medium', shadowMap: 1024, particles: 0.6,  renderScale: 1.0,  maxPixelRatio: 1.25, msaa: 2, bloomScale: 0.5, bloom: true,  ssao: false, crowd: 0.5,  reflections: 1, antialias: true },
  high:   { name: 'High',   shadowMap: 2048, particles: 1.0,  renderScale: 1.0,  maxPixelRatio: 1.5,  msaa: 4, bloomScale: 0.5, bloom: true,  ssao: false, crowd: 1.0,  reflections: 1, antialias: true },
  ultra:  { name: 'Ultra',  shadowMap: 4096, particles: 1.5,  renderScale: 1.0,  maxPixelRatio: 2.0,  msaa: 4, bloomScale: 1.0, bloom: true,  ssao: true,  crowd: 1.0,  reflections: 2, antialias: true },
});

export const GAME_TITLE = 'TURBO PITCH';
