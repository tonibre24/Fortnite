import { Schema, type } from '@colyseus/schema';

/**
 * Authoritative, replicated player state.
 *
 * Only fields clients legitimately need are declared here — server-only bookkeeping
 * (input queues, position history, rate limiters, RNG counters) lives in
 * `PlayerSimulation` and never leaves the process.
 */
export class PlayerState extends Schema {
  @type('string') id = '';
  @type('string') displayName = '';

  // Feet position and orientation.
  @type('float32') x = 0;
  @type('float32') y = 0;
  @type('float32') z = 0;
  @type('float32') yaw = 0;
  @type('float32') pitch = 0;

  // Velocity is replicated so client reconciliation can replay from a true state.
  @type('float32') vx = 0;
  @type('float32') vy = 0;
  @type('float32') vz = 0;
  @type('boolean') grounded = false;

  @type('float32') health = 0;
  @type('float32') shield = 0;
  @type('boolean') alive = false;

  @type('string') weaponId = 'rifle';
  @type('uint16') magazine = 0;
  @type('uint16') reserve = 0;
  @type('boolean') reloading = false;
  /** Server clock at which the in-progress reload completes. */
  @type('float64') reloadEndsAtMs = 0;

  @type('uint16') kills = 0;
  @type('uint16') deaths = 0;
  @type('uint32') damageDealt = 0;
  @type('uint16') ping = 0;

  /** Presentation flags used to drive remote animation without extra messages. */
  @type('boolean') moving = false;
  @type('boolean') sprinting = false;
  @type('boolean') aiming = false;

  @type('float64') respawnAtMs = 0;
  @type('float64') spawnProtectedUntilMs = 0;

  /** Last input sequence the server has simulated; the client reconciles against it. */
  @type('uint32') lastProcessedInputSeq = 0;
}
