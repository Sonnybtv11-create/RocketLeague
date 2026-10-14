// Port of RocketSim's RLConst.h (https://github.com/ZealanL/RocketSim, MIT License,
// Copyright (c) 2022 ZealanL). All values in Unreal Units (uu), seconds, radians.
// Bullet-unit constants (UU_TO_BT = 1/50) are converted to uu: every formula in
// the vehicle model is linear in length, so forces are expressed in kg·uu/s².

import { Curve } from './math.js';

export const TICK_RATE = 120;
export const TICK_TIME = 1 / TICK_RATE;

export const GRAVITY_Z = -650;

export const CAR_MASS = 180;
export const BALL_MASS = CAR_MASS / 6;

export const CARBALL_FRICTION = 2.0, CARBALL_RESTITUTION = 0.0;
export const CARWORLD_FRICTION = 0.3, CARWORLD_RESTITUTION = 0.3;
export const CARCAR_FRICTION = 0.09, CARCAR_RESTITUTION = 0.1;

export const BALL_RADIUS = 91.25;
export const BALL_REST_Z = 93.15;          // radius + arena collision margin
export const BALL_WORLD_MARGIN = BALL_REST_Z - BALL_RADIUS;
export const BALL_MAX_SPEED = 6000;
export const BALL_MAX_ANG_SPEED = 6;
export const BALL_DRAG = 0.03;
export const BALL_FRICTION = 0.35;
export const BALL_RESTITUTION = 0.6;
export const BALL_KICKOFF_Z = 92.75;

export const CAR_MAX_SPEED = 2300;
export const CAR_MAX_ANG_SPEED = 5.5;
export const SUPERSONIC_START_SPEED = 2200;
export const SUPERSONIC_MAINTAIN_MIN_SPEED = 2100;
export const SUPERSONIC_MAINTAIN_MAX_TIME = 1;

export const BOOST_MAX = 100;
export const BOOST_USED_PER_SECOND = BOOST_MAX / 3;
export const BOOST_MIN_TIME = 0.1;
export const BOOST_ACCEL_GROUND = 2975 / 3;
export const BOOST_ACCEL_AIR = 3175 / 3;
export const BOOST_SPAWN_AMOUNT = BOOST_MAX / 3;

export const POWERSLIDE_RISE_RATE = 5;
export const POWERSLIDE_FALL_RATE = 2;

// Forces (kg·uu/s²). THROTTLE: 4 wheels × 72000 / 180 kg = 1600 uu/s²
export const THROTTLE_TORQUE_AMOUNT = CAR_MASS * 400;
export const BRAKE_TORQUE_AMOUNT = CAR_MASS * (14.25 + 1 / 3);
export const STOPPING_FORWARD_VEL = 25;
export const COASTING_BRAKE_FACTOR = 0.15;
export const BRAKING_NO_THROTTLE_SPEED_THRESH = 0.01;
export const THROTTLE_DEADZONE = 0.001;
export const THROTTLE_AIR_ACCEL = 200 / 3;

export const JUMP_ACCEL = 4375 / 3;
export const JUMP_IMMEDIATE_FORCE = 875 / 3;
export const JUMP_MIN_TIME = 0.025;
export const JUMP_RESET_TIME_PAD = 1 / 40;
export const JUMP_MAX_TIME = 0.2;
export const JUMP_PRE_MIN_ACCEL_SCALE = 0.62;
export const DOUBLEJUMP_MAX_DELAY = 1.25;

export const FLIP_Z_DAMP_120 = 0.35;
export const FLIP_Z_DAMP_START = 0.15;
export const FLIP_Z_DAMP_END = 0.21;
export const FLIP_TORQUE_TIME = 0.65;
export const FLIP_TORQUE_MIN_TIME = 0.41;
export const FLIP_PITCHLOCK_TIME = 1;
export const FLIP_PITCHLOCK_EXTRA_TIME = 0.3;
export const FLIP_INITIAL_VEL_SCALE = 500;
export const FLIP_TORQUE_X = 260;
export const FLIP_TORQUE_Y = 224;
export const FLIP_FORWARD_IMPULSE_MAX_SPEED_SCALE = 1;
export const FLIP_SIDE_IMPULSE_MAX_SPEED_SCALE = 1.9;
export const FLIP_BACKWARD_IMPULSE_MAX_SPEED_SCALE = 2.5;
export const FLIP_BACKWARD_IMPULSE_SCALE_X = 16 / 15;

export const SOCCAR_GOAL_SCORE_BASE_THRESHOLD_Y = 5124.25;

export const CAR_TORQUE_SCALE = (2 * Math.PI / (1 << 16)) * 1000;
export const CAR_AIR_CONTROL_TORQUE = { pitch: 130, yaw: 95, roll: 400 };
export const CAR_AIR_CONTROL_DAMPING = { pitch: 30, yaw: 20, roll: 50 };

export const CAR_AUTOFLIP_IMPULSE = 200;
export const CAR_AUTOFLIP_TORQUE = 50;
export const CAR_AUTOFLIP_TIME = 0.4;
export const CAR_AUTOFLIP_NORMZ_THRESH = Math.SQRT1_2;
export const CAR_AUTOFLIP_ROLL_THRESH = 2.8;
export const CAR_AUTOROLL_FORCE = 100;
export const CAR_AUTOROLL_TORQUE = 80;

export const BALL_CAR_EXTRA_IMPULSE_Z_SCALE = 0.35;
export const BALL_CAR_EXTRA_IMPULSE_FORWARD_SCALE = 0.65;
export const BALL_CAR_EXTRA_IMPULSE_MAXDELTAVEL_UU = 4600;

export const CAR_SPAWN_REST_Z = 17;
export const CAR_RESPAWN_Z = 36;
export const BUMP_COOLDOWN_TIME = 0.25;
export const BUMP_MIN_FORWARD_DIST = 64.5;
export const DEMO_RESPAWN_TIME = 3;

// btVehicleRL
export const SUSPENSION_FORCE_SCALE_FRONT = 36 - 1 / 4;
export const SUSPENSION_FORCE_SCALE_BACK = 54 + 1 / 4 + 1.5 / 100;
export const SUSPENSION_STIFFNESS = 500;
export const WHEELS_DAMPING_COMPRESSION = 25;
export const WHEELS_DAMPING_RELAXATION = 40;
export const MAX_SUSPENSION_TRAVEL = 12;
export const SUSPENSION_SUBTRACTION = 0.05 * 50; // 0.05 bt -> uu
export const ROLLING_FRICTION_SCALE_MAGIC = 113.73963;

// Solver (Bullet defaults as configured by RocketSim)
export const SOLVER_ITERATIONS = 10;
export const SOLVER_ERP = 0.2;
export const SOLVER_ERP2 = 0.8;
export const RESTITUTION_VEL_THRESHOLD = 0.2 * 50; // 0.2 bt/s

// Boost pads
export const PAD = {
  CYL_HEIGHT: 95, CYL_RAD_BIG: 208, CYL_RAD_SMALL: 144,
  BOX_HEIGHT: 64, BOX_RAD_BIG: 160, BOX_RAD_SMALL: 120,
  COOLDOWN_BIG: 10, COOLDOWN_SMALL: 4,
  BOOST_AMOUNT_BIG: 100, BOOST_AMOUNT_SMALL: 12,
};
export const PAD_LOCS_BIG = [
  [-3584, 0, 73], [3584, 0, 73], [-3072, 4096, 73], [3072, 4096, 73], [-3072, -4096, 73], [3072, -4096, 73],
];
export const PAD_LOCS_SMALL = [
  [0, -4240, 70], [-1792, -4184, 70], [1792, -4184, 70], [-940, -3308, 70], [940, -3308, 70],
  [0, -2816, 70], [-3584, -2484, 70], [3584, -2484, 70], [-1788, -2300, 70], [1788, -2300, 70],
  [-2048, -1036, 70], [0, -1024, 70], [2048, -1036, 70], [-1024, 0, 70], [1024, 0, 70],
  [-2048, 1036, 70], [0, 1024, 70], [2048, 1036, 70], [-1788, 2300, 70], [1788, 2300, 70],
  [-3584, 2484, 70], [3584, 2484, 70], [0, 2816, 70], [-940, 3308, 70], [940, 3308, 70],
  [-1792, 4184, 70], [1792, 4184, 70], [0, 4240, 70],
];

// Kickoff / respawn (blue; orange mirrors x & y and adds PI to yaw)
export const CAR_SPAWN_LOCATIONS = [
  { x: -2048, y: -2560, yaw: Math.PI / 4 },
  { x: 2048, y: -2560, yaw: Math.PI / 4 * 3 },
  { x: -256, y: -3840, yaw: Math.PI / 2 },
  { x: 256, y: -3840, yaw: Math.PI / 2 },
  { x: 0, y: -4608, yaw: Math.PI / 2 },
];
export const CAR_RESPAWN_LOCATIONS = [
  { x: -2304, y: -4608, yaw: Math.PI / 2 },
  { x: -2688, y: -4608, yaw: Math.PI / 2 },
  { x: 2304, y: -4608, yaw: Math.PI / 2 },
  { x: 2688, y: -4608, yaw: Math.PI / 2 },
];

// Curves
export const STEER_ANGLE_FROM_SPEED_CURVE = new Curve([[0, 0.53356], [500, 0.31930], [1000, 0.18203], [1500, 0.10570], [1750, 0.08507], [3000, 0.03454]]);
export const POWERSLIDE_STEER_ANGLE_FROM_SPEED_CURVE = new Curve([[0, 0.39235], [2500, 0.12610]]);
export const DRIVE_SPEED_TORQUE_FACTOR_CURVE = new Curve([[0, 1.0], [1400, 0.1], [1410, 0.0]]);
export const NON_STICKY_FRICTION_FACTOR_CURVE = new Curve([[0, 0.1], [0.7075, 0.5], [1, 1.0]]);
export const LAT_FRICTION_CURVE = new Curve([[0, 1.0], [1, 0.2]]);
export const LONG_FRICTION_CURVE = new Curve([]); // empty curve -> 1
export const HANDBRAKE_LAT_FRICTION_FACTOR_CURVE = new Curve([[0, 0.1]]);
export const HANDBRAKE_LONG_FRICTION_FACTOR_CURVE = new Curve([[0, 0.5], [1, 0.9]]);
export const BALL_CAR_EXTRA_IMPULSE_FACTOR_CURVE = new Curve([[0, 0.65], [500, 0.65], [2300, 0.55], [4600, 0.30]]);
export const BUMP_VEL_AMOUNT_GROUND_CURVE = new Curve([[0, 5 / 6], [1400, 1100], [2200, 1530]]);
export const BUMP_VEL_AMOUNT_AIR_CURVE = new Curve([[0, 5 / 6], [1400, 1390], [2200, 1945]]);
export const BUMP_UPWARD_VEL_AMOUNT_CURVE = new Curve([[0, 2 / 6], [1400, 278], [2200, 417]]);
