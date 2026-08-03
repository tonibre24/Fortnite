import { INPUT_JUMP, type Vec3 } from '@riftfront/shared';
import type { BotClient } from './BotClient.js';

/**
 * Minimal "walk towards a point" steering for the headless test bots.
 *
 * The arena has buildings and the bots have no pathfinding, so a straight-line walk
 * eventually presses into a wall. When no progress is made the bot picks a detour
 * heading (alternating sides, then a reverse) until it slides free. This exists purely
 * to make the integration test deterministic enough to assert on; the game itself has
 * no AI.
 */
export class Steerer {
  private lastPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private stuckMs = 0;
  private detourMsRemaining = 0;
  private detourIndex = 0;
  private jumpCooldownMs = 0;

  private static readonly DETOUR_OFFSETS = [
    Math.PI / 2,
    -Math.PI / 2,
    Math.PI * 0.75,
    -Math.PI * 0.75,
  ];

  constructor(private readonly bot: BotClient) {}

  /** One steering tick. `stopDistance` is how close to `target` the bot should stand. */
  step(target: Vec3, dtMs: number, stopDistance: number): { distance: number } {
    const position = this.bot.position;
    const distance = Math.hypot(target.x - position.x, target.z - position.z);

    const progress = Math.hypot(position.x - this.lastPosition.x, position.z - this.lastPosition.z);
    this.lastPosition = position;

    if (this.detourMsRemaining > 0) {
      this.detourMsRemaining -= dtMs;
    } else if (progress < 0.005 && distance > stopDistance) {
      this.stuckMs += dtMs;
      if (this.stuckMs > 250) {
        this.stuckMs = 0;
        this.detourMsRemaining = 900;
        this.detourIndex = (this.detourIndex + 1) % Steerer.DETOUR_OFFSETS.length;
      }
    } else {
      this.stuckMs = 0;
    }

    this.bot.faceTowards(target);
    let buttons = this.bot.sprintButtons();

    if (this.detourMsRemaining > 0) {
      this.bot.setYaw(this.bot.currentYaw + Steerer.DETOUR_OFFSETS[this.detourIndex]);
      // A hop clears the low crates and kerbs that cause most of the snagging.
      this.jumpCooldownMs -= dtMs;
      if (this.jumpCooldownMs <= 0) {
        buttons |= INPUT_JUMP;
        this.jumpCooldownMs = 400;
      }
    }

    this.bot.sendInput(0, distance > stopDistance ? 1 : 0, buttons);
    return { distance };
  }

  /** Restores the bot's yaw to face the target directly (used before firing). */
  aimAt(target: Vec3): void {
    this.bot.faceTowards(target);
  }
}
