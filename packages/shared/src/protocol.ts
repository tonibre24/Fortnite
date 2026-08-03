import type { Vec3 } from './math.js';
import type { InputCommand } from './movement.js';
import type { MatchPhase } from './match.js';
import type { WeaponId } from './weapons.js';

/**
 * Wire protocol. Every message that crosses the socket is declared here once and
 * imported by both sides — the client and server never redeclare a payload shape.
 *
 * `PROTOCOL_VERSION` (see constants.ts) is sent with the join options and rejected
 * server-side on mismatch, so an out-of-date tab fails loudly instead of desyncing.
 */

export const ClientMessage = {
  Input: 'input',
  Fire: 'fire',
  Reload: 'reload',
  SwitchWeapon: 'switchWeapon',
  Ping: 'ping',
  RequestRespawn: 'requestRespawn',
} as const;

export type ClientMessageType = (typeof ClientMessage)[keyof typeof ClientMessage];

export const ServerMessage = {
  Welcome: 'welcome',
  Pong: 'pong',
  Shot: 'shot',
  HitConfirmed: 'hitConfirmed',
  Damaged: 'damaged',
  Kill: 'kill',
  Respawned: 'respawned',
  MatchEnded: 'matchEnded',
  MatchStarted: 'matchStarted',
  Reconcile: 'reconcile',
  Notice: 'notice',
} as const;

export type ServerMessageType = (typeof ServerMessage)[keyof typeof ServerMessage];

// ---------------------------------------------------------------------------
// Join options
// ---------------------------------------------------------------------------

export interface JoinOptions {
  displayName: string;
  protocolVersion: number;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface InputBatchPayload {
  commands: InputCommand[];
  /** Client clock (performance-derived) when the batch was flushed. */
  clientTimeMs: number;
}

export interface FirePayload {
  /** Per-player monotonic shot counter; also seeds the deterministic spread. */
  shotSeq: number;
  /** Normalised aim direction in world space. */
  direction: Vec3;
  /** Input sequence the shot was fired on, used for lag compensation. */
  inputSeq: number;
  aiming: boolean;
  clientTimeMs: number;
}

export interface SwitchWeaponPayload {
  weaponId: WeaponId;
}

export interface PingPayload {
  clientTimeMs: number;
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface WelcomePayload {
  sessionId: string;
  roomCode: string;
  protocolVersion: number;
  serverTimeMs: number;
  tickRateHz: number;
  arenaName: string;
}

export interface PongPayload {
  clientTimeMs: number;
  serverTimeMs: number;
}

/** Broadcast for every resolved shot so all clients render identical tracers. */
export interface ShotPayload {
  shooterId: string;
  weaponId: WeaponId;
  shotSeq: number;
  origin: Vec3;
  /** One end point per pellet, already clipped to whatever the ray struck. */
  endPoints: Vec3[];
  /** Impact normals for world hits; null entries mean "hit a player or nothing". */
  impactNormals: (Vec3 | null)[];
  serverTimeMs: number;
}

/** Sent only to the shooter. */
export interface HitConfirmedPayload {
  targetId: string;
  damage: number;
  headshot: boolean;
  killed: boolean;
  point: Vec3;
}

/** Sent only to the victim. */
export interface DamagedPayload {
  attackerId: string;
  attackerName: string;
  damage: number;
  headshot: boolean;
  /** Attacker position, used to render the directional damage indicator. */
  attackerPosition: Vec3;
  health: number;
  shield: number;
}

export interface KillPayload {
  attackerId: string;
  attackerName: string;
  victimId: string;
  victimName: string;
  weaponId: WeaponId;
  headshot: boolean;
  serverTimeMs: number;
}

export interface RespawnedPayload {
  playerId: string;
  position: Vec3;
  yaw: number;
  spawnProtectionUntilMs: number;
}

export interface MatchResultEntry {
  id: string;
  displayName: string;
  kills: number;
  deaths: number;
  damageDealt: number;
  ping: number;
  placement: number;
}

export interface MatchEndedPayload {
  winnerId: string | null;
  winnerName: string | null;
  scoreboard: MatchResultEntry[];
  reason: 'timeLimit' | 'scoreLimit' | 'abandoned';
  restartInMs: number;
}

export interface MatchStartedPayload {
  serverTimeMs: number;
  durationMs: number;
}

/**
 * Authoritative correction. Sent when the server's simulation disagrees with the
 * client's prediction beyond tolerance, or when the client's inputs were rejected.
 */
export interface ReconcilePayload {
  lastProcessedSeq: number;
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  serverTimeMs: number;
}

export type NoticeLevel = 'info' | 'warning' | 'error';

export interface NoticePayload {
  level: NoticeLevel;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Type maps used to keep send/receive call sites honest.
// ---------------------------------------------------------------------------

export interface ClientMessageMap {
  [ClientMessage.Input]: InputBatchPayload;
  [ClientMessage.Fire]: FirePayload;
  [ClientMessage.Reload]: Record<string, never>;
  [ClientMessage.SwitchWeapon]: SwitchWeaponPayload;
  [ClientMessage.Ping]: PingPayload;
  [ClientMessage.RequestRespawn]: Record<string, never>;
}

export interface ServerMessageMap {
  [ServerMessage.Welcome]: WelcomePayload;
  [ServerMessage.Pong]: PongPayload;
  [ServerMessage.Shot]: ShotPayload;
  [ServerMessage.HitConfirmed]: HitConfirmedPayload;
  [ServerMessage.Damaged]: DamagedPayload;
  [ServerMessage.Kill]: KillPayload;
  [ServerMessage.Respawned]: RespawnedPayload;
  [ServerMessage.MatchEnded]: MatchEndedPayload;
  [ServerMessage.MatchStarted]: MatchStartedPayload;
  [ServerMessage.Reconcile]: ReconcilePayload;
  [ServerMessage.Notice]: NoticePayload;
}

/** Convenience alias mirroring the schema field that carries the match phase. */
export type SyncedMatchPhase = MatchPhase;
