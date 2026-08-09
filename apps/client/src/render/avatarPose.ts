/**
 * Which pose a character should be in, from replicated movement state alone.
 *
 * Kept in its own module with no engine imports for two reasons: it is the one piece of
 * the character system with real branching logic, and keeping it renderer-free means it
 * is covered by the headless unit suite rather than only by looking at the screen.
 *
 * | pose       | condition                              | reads as                             |
 * | ---------- | -------------------------------------- | ------------------------------------ |
 * | `idle`     | grounded, not moving                   | weight shifted, weapon low           |
 * | `walk`     | grounded, moving                       | measured stride, arms counter-swing  |
 * | `sprint`   | grounded, moving, sprint held          | forward lean, long stride, barrel down |
 * | `jump`     | airborne, rising                       | legs tucked, arms up                 |
 * | `freefall` | airborne, falling                      | legs split, arms out for balance     |
 * | `glide`    | airborne, falling near terminal        | spread-eagle, arms swept wide        |
 * | `dead`     | eliminated                             | falls onto its side                  |
 *
 * On `glide`: this game has no glider item and no glide input, so the pose is driven by
 * the movement state that *does* exist — a sustained fall approaching terminal velocity,
 * which happens off the watchtower and over the kill plane. If a glider is ever added,
 * this is the branch it feeds.
 */

/** Downward speed at which a fall reads as a committed descent rather than a stumble. */
export const GLIDE_FALL_SPEED = 17;

export type AvatarPose = 'idle' | 'walk' | 'sprint' | 'jump' | 'freefall' | 'glide' | 'dead';

export interface PoseInputs {
  alive: boolean;
  grounded: boolean;
  moving: boolean;
  sprinting: boolean;
  /** Vertical velocity in m/s; negative is falling. */
  verticalVelocity: number;
}

export function selectPose(params: PoseInputs): AvatarPose {
  if (!params.alive) return 'dead';
  if (!params.grounded) {
    if (params.verticalVelocity > 0.5) return 'jump';
    return params.verticalVelocity <= -GLIDE_FALL_SPEED ? 'glide' : 'freefall';
  }
  if (!params.moving) return 'idle';
  return params.sprinting ? 'sprint' : 'walk';
}
