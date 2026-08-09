import { describe, expect, it } from 'vitest';
import { getArena } from '@riftfront/shared';
import { DEFAULT_SURFACE, SurfaceLookup } from './surfaceLookup.js';

const arena = getArena();
const lookup = new SurfaceLookup(arena);

describe('surface lookup', () => {
  it('assigns a material to every collider', () => {
    for (const collider of arena.colliders) {
      expect(lookup.materialForCollider(collider.id), collider.id).toBeDefined();
    }
  });

  it('resolves ramp steps through the ramp visual', () => {
    // Ramp colliders are named `<ramp>-step-N` and share one `<ramp>-visual` slab.
    const step = arena.colliders.find((collider) => collider.id === 'core-ramp-south-step-0');
    expect(step).toBeDefined();
    expect(lookup.materialForCollider('core-ramp-south-step-0')).toBe('platform');
    expect(lookup.materialForCollider('foundry-stairs-step-0')).toBe('metal');
  });

  it('reads the material under a hit on the arena floor', () => {
    expect(lookup.materialAt({ x: -20, y: 0, z: -4 }, { x: 0, y: 1, z: 0 })).toBe('ground');
  });

  it('reads the material under a hit on the core obelisk', () => {
    // The obelisk spans x,z within +-1.1 of the origin, from y 3 to y 6.2.
    expect(lookup.materialAt({ x: 1.1, y: 4.5, z: 0 }, { x: 1, y: 0, z: 0 })).toBe('core');
  });

  it('reads the material under a hit on a perimeter wall', () => {
    expect(lookup.materialAt({ x: 0, y: 3, z: 32 }, { x: 0, y: 0, z: -1 })).toBe('wall');
  });

  it('falls back rather than throwing for a point in open air', () => {
    expect(lookup.materialAt({ x: 0, y: 7.5, z: 0 }, null)).toBe(DEFAULT_SURFACE);
  });

  it('does not need a normal to resolve a point inside geometry', () => {
    expect(lookup.materialAt({ x: 0, y: -0.5, z: 0 }, null)).toBe('ground');
  });
});
