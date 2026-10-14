// Match-flow constants (Soccar). Values and sources are documented in RULES.md
// next to this file. Times in seconds, distances in Unreal Units.

// ---- Points table ---------------------------------------------------------
// Current online table (rocketleague.fandom.com/wiki/Points, 2021+ revision).
// Demolition, First Touch and Aerial Hit pay 0 points in the current game but
// are still reported as stat events (kind + label) so the UI can show them.
export const POINTS = Object.freeze({
  goal: 100,
  assist: 50,
  save: 50,
  epicSave: 75,
  shot: 10,
  centre: 10,
  clear: 20,
  demo: 0,
  firstTouch: 0,
  aerialHit: 0,
  // bonus feats (stack on top of the base event)
  aerialGoal: 20,
  backwardsGoal: 20,
  longGoal: 20,
  turtleGoal: 20,
  overtimeGoal: 25,
  hatTrick: 25,
  playmaker: 25,
  savior: 25,
  extermination: 20,
  // every ordinary ball touch (not the first touch); quick repeats pay once.
  // Added to the score silently (no EV.stat event), like RL.
  touch: 2,
});

// Legacy (2017–2019) table, kept for reference / a possible "classic scoring" toggle.
export const POINTS_LEGACY = Object.freeze({
  ...POINTS, shot: 20, centre: 20, demo: 10, firstTouch: 10, aerialHit: 10, overtimeGoal: 25,
});

export const STAT_LABELS = Object.freeze({
  goal: 'GOAL', assist: 'ASSIST', save: 'SAVE', epicSave: 'EPIC SAVE', shot: 'SHOT ON GOAL',
  centre: 'CENTER BALL', clear: 'CLEAR BALL', demo: 'DEMOLITION', firstTouch: 'FIRST TOUCH',
  aerialHit: 'AERIAL HIT', aerialGoal: 'AERIAL GOAL', backwardsGoal: 'BACKWARDS GOAL',
  longGoal: 'LONG GOAL', turtleGoal: 'TURTLE GOAL', overtimeGoal: 'OVERTIME GOAL',
  hatTrick: 'HAT TRICK', playmaker: 'PLAYMAKER', savior: 'SAVIOR', extermination: 'EXTERMINATION',
});

// ---- Timings ----------------------------------------------------------------
export const COUNTDOWN_SEC = 3;            // 3-2-1-GO
export const GO_SHOWN_SEC = 1;             // MatchView.countdown stays 0 ("GO!") this long after GO
export const KICKOFF_CLOCK_FALLBACK_SEC = 5; // clock starts anyway if nobody touches the ball
export const CELEBRATION_SEC = 3;          // goal explosion / celebration before the replay
export const FREEPLAY_RESPAWN_SEC = 2;     // free play: ball respawns this long after a goal
export const REPLAY_BEFORE_SEC = 6;        // replay shows this much before the goal ...
export const REPLAY_AFTER_SEC = 1.25;      // ... and this much after it
export const REPLAY_BUFFER_SEC = 12;       // ring buffer length (>= celebration + replay window)

// ---- Goal explosion blast -----------------------------------------------------
export const BLAST_RADIUS = 1500;          // cars within this distance of the ball are pushed
export const BLAST_MAX_SPEED = 2000;       // added speed at the centre (falls off linearly)
export const BLAST_UP_BIAS = 0.35;         // extra upward component added to the push direction
export const BLAST_MAX_SPIN = 4;           // rad/s random tumble at the centre

// ---- Zero-second rule -------------------------------------------------------
export const FLOOR_NORMAL_Z = 0.7;         // a bounce with normal.z above this is "the floor"
export const ROLLING_Z = 100;              // ball centre below this ...
export const ROLLING_VZ = 160;             // ... with |vz| below this = rolling / touching the floor

// ---- Stat detection -----------------------------------------------------------
export const PREDICT_SEC = 6;              // trajectory horizon after each touch
export const SHOT_MAX_SEC = 5;             // a touch is a shot if the ball would score within this
export const SAVE_MAX_SEC = 4;             // a save stops a ball that would have scored within this
export const EPIC_SAVE_SEC = 0.35;         // ... epic if it was this close to going in
export const EPIC_SAVE_DIST = 350;         // ... or the ball was this close to the goal line
export const CLEAR_MAX_SEC = 3;            // clear: ball reaches the other half within this
export const CENTRE_MAX_SEC = 2.5;         // centre: ball reaches the slot in front of goal within this
export const ASSIST_WINDOW_SEC = 5;        // assister's touch at most this long before the goal
export const TOUCH_GAP_TICKS = 3;          // contact ticks closer than this are one touch
export const TOUCH_POINTS_COOLDOWN_SEC = 1; // "hit multiple times quickly -> only 2 points"
export const THIRD_Y = 5120 / 3;           // defensive / attacking third boundary
export const CENTRE_SIDE_X = 1100;         // centre: hit from wider than this ...
export const CENTRE_SLOT_X = 900;          // ... to inside this |x| ...
export const CENTRE_SLOT_Y = 3100;         // ... and deeper than this toward the opponent goal
export const AERIAL_BALL_Z = 642.775;      // aerial hit: ball above goal height, car airborne
export const LONG_GOAL_Y = 0;              // long goal: touched from your own half
export const EXTERMINATION_DEMOS = 7;
export const FEAT_COUNT = 3;               // hat trick / playmaker / savior
