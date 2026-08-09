import {
  INPUT_CREDIT_MAX,
  INPUT_QUEUE_MAX,
  createPlayerState,
  f32,
  type InputCommand,
  type PlayerState,
  type Spawn,
} from '@br/shared';

/** Server-side player: authoritative state plus the pending input to apply to it. */
export class ServerPlayer {
  readonly state: PlayerState;
  readonly queue: InputCommand[] = [];

  /** Highest sequence number ever queued; used to drop duplicates and resends. */
  lastQueuedSeq = 0;
  /** Highest sequence number actually simulated. Echoed back so the client can reconcile. */
  lastProcessedSeq = 0;
  /** Newest snapshot tick this client has confirmed decoding; the delta baseline. */
  ackedTick = 0;
  /**
   * Budget of commands this player may simulate. Refilled one per tick and
   * capped, so bursts absorb network jitter without letting a client that
   * floods input move faster than everyone else.
   */
  credit = 1;
  starvedTicks = 0;
  /** Commands discarded because the queue was full - a flooding indicator. */
  droppedCommands = 0;

  /** Ticks left before this player's weapon can fire again. */
  fireCooldown = 0;
  /** Whether the trigger was held on the previous command, for semi-automatics. */
  triggerHeld = false;
  /** Tick the player died on, or -1 while alive. */
  diedAtTick = -1;
  /** Who got the kill, for the spectator camera and the scoreboard. */
  killedBy = 0;
  /** Commands simulated this tick, held for the combat pass that follows movement. */
  readonly resolvedCommands: InputCommand[] = [];
  /** Whether interact was held last command, so a hold is one pickup not many. */
  interactHeld = false;
  /** Ticks spent so far using the consumable in hand. */
  useTicks = 0;

  constructor(
    readonly id: number,
    readonly name: string,
    spawn: Spawn,
  ) {
    this.state = createPlayerState(id);
    // Simulation state is float32-exact so that the wire representation is
    // lossless; anything written outside stepMovement has to respect that.
    this.state.pos.x = f32(spawn.pos.x);
    this.state.pos.y = f32(spawn.pos.y);
    this.state.pos.z = f32(spawn.pos.z);
    this.state.yawQ = spawn.yawQ;
  }

  /**
   * Queues newly-arrived commands. Anything at or below `lastQueuedSeq` is a
   * redundant resend and is ignored, so the redundancy in each packet costs
   * nothing when no packet was lost.
   */
  enqueue(commands: readonly InputCommand[]): void {
    for (const cmd of commands) {
      if (cmd.seq <= this.lastQueuedSeq) continue;
      if (this.queue.length >= INPUT_QUEUE_MAX) {
        this.droppedCommands += 1;
        continue;
      }
      this.queue.push(cmd);
      this.lastQueuedSeq = cmd.seq;
    }
  }

  refillCredit(): void {
    this.credit = Math.min(this.credit + 1, INPUT_CREDIT_MAX);
  }

  /** Next command to simulate, or undefined when the client has starved us. */
  takeCommand(): InputCommand | undefined {
    if (this.credit < 1) return undefined;
    const cmd = this.queue.shift();
    if (cmd === undefined) return undefined;
    this.credit -= 1;
    this.lastProcessedSeq = cmd.seq;
    return cmd;
  }
}
