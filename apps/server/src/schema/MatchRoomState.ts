import { MapSchema, Schema, type } from '@colyseus/schema';
import { PlayerState } from './PlayerState.js';

/** Root replicated state for one match room. */
export class MatchRoomState extends Schema {
  @type('string') roomCode = '';
  @type('string') arenaName = '';
  /** One of the shared `MatchPhase` values. */
  @type('string') phase = 'WAITING';
  /** Server clock at which the current phase ends; 0 when the phase is untimed. */
  @type('float64') phaseEndsAtMs = 0;
  /** Authoritative server clock, used by clients to align timers and interpolation. */
  @type('float64') serverTimeMs = 0;

  @type('uint16') scoreLimit = 0;
  @type('uint16') maxPlayers = 0;
  @type('uint16') minPlayers = 0;
  @type('float64') matchDurationMs = 0;

  @type('string') winnerId = '';
  @type('string') winnerName = '';

  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
