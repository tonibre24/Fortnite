import { describe, expect, it } from 'vitest';
import { GRAVITY, JUMP_VELOCITY, TERMINAL_VELOCITY } from '@riftfront/shared';
import { selectPose } from './avatarPose.js';

/**
 * Pose selection is a pure function of replicated movement state, so it is pinned here
 * without a renderer in sight. That matters: the pose is the only readable signal a
 * player has for what an enemy is *about* to do, and a wrong branch looks like a netcode
 * bug rather than an animation bug.
 */

const grounded = {
  alive: true,
  grounded: true,
  moving: false,
  sprinting: false,
  verticalVelocity: 0,
};

describe('avatar pose selection', () => {
  it('stands idle when grounded and still', () => {
    expect(selectPose(grounded)).toBe('idle');
  });

  it('walks when moving', () => {
    expect(selectPose({ ...grounded, moving: true })).toBe('walk');
  });

  it('sprints only while both moving and sprinting', () => {
    expect(selectPose({ ...grounded, moving: true, sprinting: true })).toBe('sprint');
    // The server clears `sprinting` when the player stops, but a stale flag must not
    // leave an idle player pumping their arms.
    expect(selectPose({ ...grounded, moving: false, sprinting: true })).toBe('idle');
  });

  it('uses the jump pose while rising', () => {
    expect(selectPose({ ...grounded, grounded: false, verticalVelocity: JUMP_VELOCITY })).toBe(
      'jump',
    );
  });

  it('uses the freefall pose early in a drop', () => {
    // A tenth of a second after walking off a ledge.
    expect(selectPose({ ...grounded, grounded: false, verticalVelocity: -GRAVITY * 0.1 })).toBe(
      'freefall',
    );
  });

  it('reaches the glide pose on a committed fall', () => {
    // The longest drop in the arena — the watchtower's upper deck at 6.5 m — arrives at
    // about 18 m/s, and anything past the kill plane is well beyond that.
    const fromWatchtower = -Math.sqrt(2 * GRAVITY * 6.5);
    expect(selectPose({ ...grounded, grounded: false, verticalVelocity: fromWatchtower })).toBe(
      'glide',
    );
    expect(selectPose({ ...grounded, grounded: false, verticalVelocity: -TERMINAL_VELOCITY })).toBe(
      'glide',
    );
  });

  it('always uses the dead pose for an eliminated player', () => {
    for (const airborne of [true, false]) {
      expect(
        selectPose({
          alive: false,
          grounded: !airborne,
          moving: true,
          sprinting: true,
          verticalVelocity: -30,
        }),
      ).toBe('dead');
    }
  });
});
