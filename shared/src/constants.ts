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

/**
 * POIs occupy the eight non-centre cells of a 3x3 grid. Leaving the middle
 * empty keeps the lobby spawn ring clear of buildings.
 */
export const POI_GRID = 3;
export const POI_COUNT = POI_GRID * POI_GRID - 1;
/** Fraction of a grid cell a POI centre may wander from the cell centre. */
export const POI_JITTER = 0.22;
export const POI_MIN_BUILDINGS = 3;
export const POI_MAX_BUILDINGS = 6;
export const POI_RADIUS = 34;
/** Rejection-sampling budget when fitting a building into a POI. */
export const BUILDING_PLACEMENT_ATTEMPTS = 24;
/** Clear ground kept between neighbouring buildings. */
export const BUILDING_GAP = 3;

export const BUILDING_MIN_SIZE = 9;
export const BUILDING_MAX_SIZE = 18;
export const BUILDING_STOREY_HEIGHT = 3.6;
export const BUILDING_MAX_STOREYS = 2;
export const BUILDING_WALL_THICKNESS = 0.4;
export const BUILDING_FLOOR_THICKNESS = 0.3;
export const BUILDING_DOOR_WIDTH = 2.4;
export const BUILDING_DOOR_HEIGHT = 2.6;
/** Chance a building gets an external stair up to its roof. */
export const BUILDING_RAMP_CHANCE = 0.55;

/** Rise per step. Must stay below STEP_HEIGHT or stairs become unclimbable. */
export const STAIR_RISE = 0.45;
export const STAIR_RUN = 0.62;
export const STAIR_WIDTH = 2.2;

export const HILL_COUNT = 26;
export const HILL_MIN_RADIUS = 8;
export const HILL_MAX_RADIUS = 22;
export const HILL_MIN_TIERS = 2;
export const HILL_MAX_TIERS = 12;
/** Also a step height, so hillsides stay walkable. */
export const HILL_TIER_HEIGHT = 0.5;

export const TREE_COUNT = 320;
export const TREE_TRUNK_RADIUS = 0.35;
export const TREE_MIN_HEIGHT = 4;
export const TREE_MAX_HEIGHT = 9;
export const TREE_CANOPY_SCALE = 2.6;

export const ROCK_COUNT = 90;
export const ROCK_MIN_SIZE = 1.2;
export const ROCK_MAX_SIZE = 3.4;

/** Keep scatter props outside the built-up part of a POI so streets stay clear. */
export const SCATTER_POI_CLEARANCE = 6;
/** Scatter placement attempts before giving up on a prop. */
export const SCATTER_ATTEMPTS = 8;
/** Radius around the map centre kept free of props, for the lobby spawn ring. */
export const SPAWN_CLEARANCE_RADIUS = 38;

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

// ------------------------------------------------------------------ combat

/** Hitscan range. Beyond this a shot simply misses. */
export const WEAPON_MAX_RANGE = 260;
/** Top slice of the player box that counts as a head. */
export const HEAD_HEIGHT = 0.4;
export const HEADSHOT_MULTIPLIER = 2;

/**
 * How far back the server will rewind to honour a client's reported view.
 * Anything older is a client claiming to have seen the distant past.
 */
export const MAX_LAG_COMP_TICKS = 20;
/** Fixed-point scale for the render tick a client reports with each command. */
export const RENDER_TICK_SCALE = 16;

/** Ticks a shot's tracer stays on screen. */
export const TRACER_LIFETIME_MS = 90;
/** Ticks a hit marker stays on screen. */
export const HIT_MARKER_MS = 180;
/** Entries kept in the kill feed, and how long each survives. */
export const KILL_FEED_MAX = 5;
export const KILL_FEED_MS = 6000;

/** Damage indicator arc lifetime. */
export const DAMAGE_FLASH_MS = 400;

// -------------------------------------------------------------------- loot

export const INVENTORY_SLOTS = 5;
/** How close you must be to pick something up. */
export const PICKUP_RANGE = 2.6;
/** Ground items bob and spin; this is the vertical amplitude. */
export const LOOT_BOB_HEIGHT = 0.12;
export const LOOT_SIZE = 0.42;
export const CHEST_SIZE = 0.9;
export const CHEST_HEIGHT = 0.7;

/** Floor loot per building, and the chance a building also gets a chest. */
export const FLOOR_LOOT_MIN = 1;
export const FLOOR_LOOT_MAX = 3;
export const CHEST_CHANCE = 0.55;
/** Items a chest coughs up when opened. */
export const CHEST_ITEMS_MIN = 2;
export const CHEST_ITEMS_MAX = 3;
/** How far opened-chest loot scatters. */
export const CHEST_SCATTER = 1.3;

/** Rarity weights for floor loot and for chests. Chests skew better. */
export const FLOOR_RARITY_WEIGHTS = [46, 27, 16, 8, 3] as const;
export const CHEST_RARITY_WEIGHTS = [18, 26, 27, 19, 10] as const;
/** Share of loot rolls that produce a consumable rather than a gun. */
export const CONSUMABLE_CHANCE = 0.34;

export const MEDKIT_HEAL = 100;
export const MEDKIT_USE_TICKS = 60;
export const MEDKIT_STACK = 3;
export const SHIELD_POTION_GAIN = 50;
export const SHIELD_POTION_USE_TICKS = 40;
export const SHIELD_POTION_STACK = 3;

// --------------------------------------------------------------- round flow

/** Players needed before a round will start. */
export const LOBBY_MIN_PLAYERS = 2;
export const LOBBY_COUNTDOWN_TICKS = 5 * TICK_RATE;
/** How long the results screen stays up before the next round. */
export const ROUND_END_TICKS = 8 * TICK_RATE;

export const BUS_ALTITUDE = 140;
export const BUS_DURATION_TICKS = 25 * TICK_RATE;
/** The bus flies a chord this much longer than the map so it starts and ends outside. */
export const BUS_PATH_OVERSHOOT = 1.45;
export const BUS_SIZE_X = 9;
export const BUS_SIZE_Y = 3.4;
export const BUS_SIZE_Z = 4;
/** Riders are spread along the bus so they are not all in the same spot. */
export const BUS_RIDER_SPACING = 0.6;

// ------------------------------------------------------------ skydive

/** Terminal speed in a head-down dive, and how hard you can steer. */
export const FREEFALL_TERMINAL = 55;
export const FREEFALL_MAX_SPEED = 30;
export const FREEFALL_ACCEL = 16;
/** Below this height the glider opens by itself. */
export const GLIDE_ALTITUDE = 60;
export const GLIDE_FALL_SPEED = 9;
export const GLIDE_MAX_SPEED = 14;
export const GLIDE_ACCEL = 12;
/** Drag applied to horizontal drift while airborne under a glider. */
export const GLIDE_FRICTION = 1.6;

// -------------------------------------------------------------------- storm

export const STORM_PHASES = 6;
/** Radius before the first shrink, then after each of the six phases. */
export const STORM_RADII: readonly number[] = [230, 155, 104, 66, 38, 17, 0];
/** Ticks the circle holds still before each shrink. */
export const STORM_WAIT_TICKS = [30, 25, 20, 16, 13, 10].map((s) => s * TICK_RATE);
/** Ticks each shrink takes. */
export const STORM_SHRINK_TICKS = [25, 22, 20, 18, 15, 12].map((s) => s * TICK_RATE);
/** Damage per second outside the circle, per phase. */
export const STORM_DAMAGE: readonly number[] = [1, 2, 4, 7, 11, 16];
/** How far inside the previous circle the next centre may sit, as a fraction. */
export const STORM_CENTRE_DRIFT = 0.55;
/** Vertical extent of the drawn storm wall. */
export const STORM_WALL_HEIGHT = 90;

// ------------------------------------------------------------------- minimap

export const MINIMAP_SIZE = 190;
/** Redraw the static layer only when the map changes; this is the padding. */
export const MINIMAP_PADDING = 4;
export const MINIMAP_PLAYER_SIZE = 5;

// -------------------------------------------------------- performance readout

/** Frames averaged before the HUD updates its frame-time figure. */
export const PERF_SAMPLE_FRAMES = 30;

// -------------------------------------------------------------------- visuals

/**
 * Late afternoon. Committing to one time of day is what makes the palette
 * coherent: a low sun gives long shadows that show which way a surface faces,
 * which is how a player reads geometry at a glance.
 */
export const SUN_AZIMUTH = 2.35;
export const SUN_ELEVATION = 0.42;
export const SUN_INTENSITY = 2.9;
export const SUN_COLOR = 0xffe6c2;
/** Sky and bounce fill, so shadowed faces stay readable instead of going black. */
export const HEMI_SKY_COLOR = 0x9fc4e8;
export const HEMI_GROUND_COLOR = 0x6b7a4a;
export const HEMI_INTENSITY = 1.45;

/** Sky gradient, top to horizon, plus the warm band the sun sits in. */
export const SKY_TOP_COLOR = 0x4f8fd6;
export const SKY_HORIZON_COLOR = 0xbcd8e8;
export const SKY_HAZE_COLOR = 0xf2d3a8;
/** Where the horizon band sits in the gradient, 0 = bottom, 1 = top. */
export const SKY_HORIZON_HEIGHT = 0.5;
export const SKY_HAZE_WIDTH = 0.09;

/** Fog is matched to the horizon so the map edge dissolves rather than ends. */
export const FOG_NEAR = 120;
export const FOG_FAR = 460;

/**
 * The shadow frustum follows the player rather than covering the map. A 500x500
 * map in one map would be unusably coarse; this keeps texels small where they
 * are actually looked at.
 */
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_RADIUS = 55;
export const SHADOW_DEPTH = 260;
export const SHADOW_BIAS = -0.0012;
export const SHADOW_NORMAL_BIAS = 0.02;

/** Per-instance hue jitter, so repeated props do not read as tiled. */
export const PROP_TINT_JITTER = 0.11;

/**
 * Client-side scenery. Derived from the map seed on a salted stream, so every
 * client draws the same props without any of it reaching the collision data
 * the server shares - decoration must never move the seeded map hash.
 */
export const DECOR_SEED_SALT = 0x5cede0c0;
export const DECOR_GRASS_COUNT = 4200;
export const DECOR_PEBBLE_COUNT = 900;
export const DECOR_FENCE_CHANCE = 0.35;
export const COLOR_GRASS_A = 0x6f9c46;
export const COLOR_GRASS_B = 0x8aa84e;
export const COLOR_PEBBLE = 0x8d8b84;

/**
 * The ground slab is one enormous box, which reads as a flat plane of a single
 * colour. It is drawn instead as a grid of tinted tiles - purely a rendering
 * choice, the collider stays exactly one box.
 */
export const GROUND_TILES = 44;

// --------------------------------------------------------------------- audio

/** Master volume before the player touches the slider, and where it persists. */
export const AUDIO_DEFAULT_VOLUME = 0.7;
export const AUDIO_VOLUME_KEY = 'br.audio.volume';

/** Inverse-distance rolloff for positional sources, in world units. */
export const AUDIO_REF_DISTANCE = 7;
export const AUDIO_MAX_DISTANCE = 240;
export const AUDIO_ROLLOFF = 1.1;

/**
 * Hard ceilings on simultaneous voices. Twenty players in a firefight would
 * otherwise spawn oscillators faster than they retire, and the mix turns to mud
 * long before the CPU notices.
 */
export const AUDIO_MAX_SHOT_VOICES = 5;
export const AUDIO_MAX_IMPACT_VOICES = 4;
export const AUDIO_MAX_STEP_VOICES = 3;
export const AUDIO_MAX_PICKUP_VOICES = 3;
export const AUDIO_MAX_UI_VOICES = 2;

/** Distance a player covers between footsteps. */
export const AUDIO_STEP_DISTANCE = 2.4;
/** Past this, another player's footsteps are not worth a voice. */
export const AUDIO_STEP_RANGE = 32;

/** A loud one-shot pulls the ambient beds down so it can cut through. */
export const AUDIO_DUCK_DEPTH = 0.42;
export const AUDIO_DUCK_ATTACK = 0.015;
export const AUDIO_DUCK_RELEASE = 0.28;

/** Storm drone: silent at the centre, full at the wall and beyond. */
export const AUDIO_STORM_GAIN = 0.5;
/** Distance inside the wall over which the drone fades up. */
export const AUDIO_STORM_FADE = 80;

export const AUDIO_BUS_GAIN = 0.34;
export const AUDIO_WIND_GAIN = 0.45;
/** Fall speed mapping to full glider wind. */
export const AUDIO_WIND_FULL_SPEED = 55;

/** Seconds of noise in a looping bed buffer. */
export const AUDIO_NOISE_LOOP_SECONDS = 2;
/** Ramp used whenever a continuous bed changes level. */
export const AUDIO_BED_RAMP = 0.12;

// ------------------------------------------------------------------ gameplay

export const MAX_PLAYERS = 20;
/** Delay before a downed player's camera detaches into free spectate. */
export const SPECTATE_HANDOFF_TICKS = 20;
