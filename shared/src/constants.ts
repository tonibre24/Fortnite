/**
 * Every tunable number in the game lives here. Nothing else in the codebase
 * should contain a magic number.
 */

// ---------------------------------------------------------------- networking

export const PROTOCOL_VERSION = 1;

/** Server simulation rate. The client predicts at exactly the same rate. */
export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

export const DEFAULT_PORT = 8080;

/** Commands re-sent with every input packet so one dropped packet is harmless. */
export const INPUT_REDUNDANCY = 3;
/** Hard cap on queued commands per player (anti-flood). */
export const INPUT_QUEUE_MAX = 40;
/** Commands a player may consume in a single tick when catching up after jitter. */
export const INPUT_CREDIT_MAX = 3;
/** Ticks of input starvation tolerated before the server simulates the player idle. */
export const INPUT_STARVE_GRACE_TICKS = 8;

/** Snapshots retained server-side for delta baselines and lag compensation. */
export const SNAPSHOT_HISTORY = 64;

/** Render remote players this far in the past to hide jitter. */
export const INTERP_DELAY_MS = 100;
/** Buffer of snapshots kept client-side for interpolation. */
export const SNAPSHOT_BUFFER_SIZE = 32;
/** Beyond this the client stops extrapolating remote players and freezes them. */
export const EXTRAPOLATION_LIMIT_MS = 250;
/** How fast the interpolation clock drifts toward later-arriving snapshots. */
export const INTERP_OFFSET_DRIFT = 0.01;
/** Ticks the client may simulate in one frame after a stall (e.g. a background tab). */
export const CLIENT_MAX_CATCHUP_TICKS = 5;

/** Ping interval used for round-trip and clock offset estimation. */
export const PING_INTERVAL_MS = 1000;

/** Prediction error above this (in units) triggers a visible correction. */
export const RECONCILE_EPSILON = 0.001;
/** Prediction error above this snaps instantly instead of smoothing. */
export const RECONCILE_SNAP_DISTANCE = 2.0;
/** Time constant for smoothing away a reconciliation correction. */
export const RECONCILE_SMOOTH_TIME = 0.1;

/** Drop a connection that has not produced a packet in this long. */
export const CONNECTION_TIMEOUT_MS = 15000;

// ------------------------------------------------------------------ quantization

/** Radians of yaw per pixel of raw mouse movement. */
export const MOUSE_SENSITIVITY = 0.0022;

export const YAW_BITS = 16;
export const YAW_STEPS = 1 << YAW_BITS;
/**
 * Pitch is signed so that a quantized zero means "looking level". An unsigned
 * encoding would make the default-initialised value mean "looking straight
 * down", which is exactly the kind of trap that only shows up on screen.
 */
export const PITCH_SCALE = 32767;
export const MAX_PITCH = Math.PI / 2 - 0.01;

// ---------------------------------------------------------------------- world

export const MAP_SIZE = 500;
export const MAP_HALF = MAP_SIZE / 2;
/** Height of the invisible walls around the play area. */
export const MAP_WALL_HEIGHT = 60;
export const MAP_WALL_THICKNESS = 4;
/** Broadphase grid cell size for collision queries. */
export const COLLISION_CELL_SIZE = 16;

export const GROUND_Y = 0;

// --------------------------------------------------------------------- player

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE_HEIGHT = 1.65;
export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_MAX_SHIELD = 100;

// ------------------------------------------------------------------ movement

export const WALK_SPEED = 5.5;
export const SPRINT_SPEED = 8.5;
/**
 * Acceleration scales, in units of target-speeds per second. Friction is
 * applied every tick even while accelerating, so top speed settles at
 * `accel * targetSpeed / friction`; keeping accel above friction is what lets a
 * player actually reach the speed they are aiming for.
 */
export const GROUND_ACCEL = 12;
export const AIR_ACCEL = 1.2;
/** Fraction of horizontal velocity shed per second while grounded. */
export const GROUND_FRICTION = 11;
/** Fraction of horizontal velocity shed per second while airborne. */
export const AIR_FRICTION = 0.2;
export const GRAVITY = 24;
export const JUMP_VELOCITY = 8.4;
export const TERMINAL_VELOCITY = 80;
/** Ledges up to this height are climbed automatically. */
export const STEP_HEIGHT = 0.55;
/** Player-vs-geometry separation kept after a collision resolve. */
export const COLLISION_SKIN = 0.001;
/** Grace period after leaving a ledge during which jumping still works. */
export const COYOTE_TIME = 0.1;
export const COYOTE_TICKS = Math.round(COYOTE_TIME * TICK_RATE);
/** Penetration resolve iterations per axis. */
export const MAX_RESOLVE_PASSES = 4;
/** Saturation value for the "ticks since grounded" counter (fits in a byte). */
export const SINCE_GROUNDED_MAX = 255;

// ------------------------------------------------------------ map generation

export const POI_COUNT = 8;
/** POIs are placed on a jittered grid of this many cells per axis. */
export const POI_GRID = 3;
/** Fraction of a grid cell a POI centre may wander from the cell centre. */
export const POI_JITTER = 0.22;
export const POI_MIN_BUILDINGS = 3;
export const POI_MAX_BUILDINGS = 6;
export const POI_RADIUS = 34;

export const BUILDING_MIN_SIZE = 8;
export const BUILDING_MAX_SIZE = 18;
export const BUILDING_STOREY_HEIGHT = 3.6;
export const BUILDING_MAX_STOREYS = 2;
export const BUILDING_WALL_THICKNESS = 0.4;
export const BUILDING_DOOR_WIDTH = 2.4;
export const BUILDING_DOOR_HEIGHT = 2.6;
/** Chance a building gets an external ramp to its roof / upper floor. */
export const BUILDING_RAMP_CHANCE = 0.55;
export const RAMP_STEP_COUNT = 8;
export const RAMP_WIDTH = 2.2;

export const HILL_COUNT = 26;
export const HILL_MIN_RADIUS = 8;
export const HILL_MAX_RADIUS = 22;
export const HILL_MIN_TIERS = 2;
export const HILL_MAX_TIERS = 5;
export const HILL_TIER_HEIGHT = 0.5;

export const TREE_COUNT = 320;
export const TREE_TRUNK_RADIUS = 0.35;
export const TREE_MIN_HEIGHT = 4;
export const TREE_MAX_HEIGHT = 9;
export const TREE_CANOPY_SCALE = 2.6;

export const ROCK_COUNT = 90;
export const ROCK_MIN_SIZE = 1.2;
export const ROCK_MAX_SIZE = 3.4;

/** Keep scatter props this far away from POI centres so streets stay clear. */
export const SCATTER_POI_CLEARANCE = 6;

// -------------------------------------------------------------------- spawns

/**
 * Radius of the ring players start on. Small enough that everyone can see
 * everyone else immediately, which is what makes movement and interpolation
 * verifiable by eye. The bus drop replaces this in a later phase.
 */
export const SPAWN_RING_RADIUS = 25;
export const SPAWN_HEIGHT_PROBE = 80;

// -------------------------------------------------------------------- colors

export const COLOR_SKY = 0x8fb6d8;
export const COLOR_GROUND = 0x4f7a3a;
export const COLOR_HILL = 0x5c8a44;
export const COLOR_TREE_TRUNK = 0x5a4028;
export const COLOR_TREE_CANOPY = 0x2f6b34;
export const COLOR_ROCK = 0x7d7d82;
export const COLOR_WALL = 0xb9b0a2;
export const COLOR_WALL_ALT = 0xa3a99f;
export const COLOR_FLOOR = 0x8a7f70;
export const COLOR_ROOF = 0x8c4a3a;
export const COLOR_RAMP = 0x9a9184;
export const COLOR_BOUNDARY = 0x6a4b8a;
export const COLOR_SELF = 0x3f7fd0;
export const COLOR_ENEMY = 0xd03030;
export const COLOR_STORM = 0x8a3fd0;

// ------------------------------------------------------------------ gameplay

export const MAX_PLAYERS = 20;
