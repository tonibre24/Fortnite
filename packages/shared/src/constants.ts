/**
 * Tuning constants shared by every layer of the game.
 *
 * Anything that influences simulation outcome lives here so client prediction and
 * server authority cannot drift apart. Values are intentionally "game feel" numbers
 * rather than physically realistic ones.
 */

/** Bumped whenever the wire format changes in a non-backwards-compatible way. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Simulation timing
// ---------------------------------------------------------------------------

/** Fixed simulation steps per second. Both sides step movement at exactly this rate. */
export const SIM_HZ = 60;
export const FIXED_DT = 1 / SIM_HZ;
export const FIXED_DT_MS = 1000 / SIM_HZ;

/** Authoritative state broadcast rate (Colyseus patch rate). */
export const SERVER_TICK_HZ = 20;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;

/** How often the client flushes batched input commands. */
export const INPUT_SEND_HZ = 30;
export const INPUT_SEND_MS = 1000 / INPUT_SEND_HZ;

/** Upper bound on commands carried by a single input batch message. */
export const MAX_COMMANDS_PER_BATCH = 12;

/** Remote entities are rendered this far in the past so interpolation always has two samples. */
export const INTERPOLATION_DELAY_MS = 100;

// ---------------------------------------------------------------------------
// Player physics
// ---------------------------------------------------------------------------

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE_HEIGHT = 1.62;
/** Vertical offset of the capsule centre used for hit detection. */
export const PLAYER_HEAD_HEIGHT = 1.55;
export const PLAYER_HEAD_RADIUS = 0.26;

export const WALK_SPEED = 6.2;
export const SPRINT_SPEED = 9.4;
export const AIM_SPEED = 3.4;
export const CROUCH_SPEED = 3.0; // reserved: no crouch in the vertical slice

export const GROUND_ACCELERATION = 70;
export const AIR_ACCELERATION = 14;
export const GROUND_FRICTION = 12;
export const AIR_DRAG = 0.2;

export const GRAVITY = 25;
export const TERMINAL_VELOCITY = 55;
export const JUMP_VELOCITY = 8.4;
/** Minimum time between jumps; prevents infinite/bunny jumping through input spam. */
export const JUMP_COOLDOWN_MS = 300;
/** Grace period after leaving a ledge during which jumping is still allowed. */
export const COYOTE_TIME_MS = 90;
/** Maximum ledge height the controller walks up without jumping (stairs and ramps). */
export const STEP_HEIGHT = 0.45;
/** Falling below this Y respawns the player (safety net, the arena is walled). */
export const KILL_PLANE_Y = -12;

// ---------------------------------------------------------------------------
// Health and combat
// ---------------------------------------------------------------------------

export const MAX_HEALTH = 100;
export const MAX_SHIELD = 50;
export const SPAWN_PROTECTION_MS = 1500;
export const RESPAWN_DELAY_MS = 3000;
export const LOW_HEALTH_THRESHOLD = 35;

// ---------------------------------------------------------------------------
// Match rules
// ---------------------------------------------------------------------------

export const MATCH_MIN_PLAYERS = 2;
/** Allows solo testing of the full match flow without a second browser. */
export const MATCH_MIN_PLAYERS_SOLO = 1;
export const MATCH_MAX_PLAYERS = 8;
export const MATCH_COUNTDOWN_MS = 5000;
export const MATCH_DURATION_MS = 5 * 60 * 1000;
export const MATCH_SCORE_LIMIT = 20;
export const MATCH_RESULTS_MS = 10000;
export const ROOM_CODE_LENGTH = 5;

// ---------------------------------------------------------------------------
// Anti-cheat / validation limits
// ---------------------------------------------------------------------------

/** Simulated commands accepted per second before the connection is throttled. */
export const MAX_COMMANDS_PER_SECOND = Math.ceil(SIM_HZ * 1.5);
/** Network messages of any type accepted per second. */
export const MAX_MESSAGES_PER_SECOND = 120;
/** Multiplier applied to the theoretical max speed before a correction is forced. */
export const SPEED_VALIDATION_TOLERANCE = 1.4;
/** Positional delta in one simulation step that is treated as a teleport attempt. */
export const MAX_STEP_DISTANCE = 1.5;
/** Hard cap on how far back hitscan shots may be rewound. */
export const LAG_COMPENSATION_MAX_MS = 250;
/** Length of the retained position history per player. */
export const LAG_COMPENSATION_HISTORY_MS = 1000;
export const MAX_DISPLAY_NAME_LENGTH = 16;
export const MIN_DISPLAY_NAME_LENGTH = 1;
/** Simultaneous WebSocket connections accepted from a single remote address. */
export const MAX_CONNECTIONS_PER_ADDRESS = 12;
/** Fire-rate slack (ms) that absorbs jitter without allowing meaningful rate hacks. */
export const FIRE_RATE_GRACE_MS = 25;

// ---------------------------------------------------------------------------
// Client presentation defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MOUSE_SENSITIVITY = 0.0022;
export const MIN_MOUSE_SENSITIVITY = 0.0004;
export const MAX_MOUSE_SENSITIVITY = 0.008;
export const MAX_PITCH = Math.PI / 2 - 0.05;
export const CAMERA_DISTANCE = 4.2;
export const CAMERA_DISTANCE_AIMING = 2.2;
export const CAMERA_HEIGHT = 1.75;
export const CAMERA_SHOULDER_OFFSET = 0.65;
export const CAMERA_COLLISION_PADDING = 0.35;
export const KILL_FEED_MAX_ENTRIES = 5;
export const KILL_FEED_ENTRY_TTL_MS = 6000;
