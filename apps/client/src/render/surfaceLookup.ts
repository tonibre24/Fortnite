import {
  ColliderIndex,
  getArena,
  type ArenaDefinition,
  type MaterialKey,
  type Vec3,
} from '@riftfront/shared';

/**
 * Answers "what did that bullet just hit?" so impact VFX can be coloured by the surface.
 *
 * Concrete throws pale grey dust and warm sparks; the teal accent panels throw teal;
 * the rift core throws violet. Getting this right is most of the difference between
 * impacts that feel like part of the world and impacts that feel like a decal library.
 *
 * The lookup is built from the shared arena, so it needs no extra data and cannot drift
 * out of sync with the geometry. It is a pure module — no renderer import — which is
 * what lets it be tested headlessly.
 */

/** How far back along the surface normal to probe, in metres. */
const PROBE_DEPTH = 0.03;
/** Used when a point matches nothing, e.g. a shot that reached its maximum range. */
export const DEFAULT_SURFACE: MaterialKey = 'structure';

export class SurfaceLookup {
  private readonly index: ColliderIndex;
  private readonly byColliderId = new Map<string, MaterialKey>();
  private readonly probeMin: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly probeMax: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(arena: ArenaDefinition = getArena()) {
    this.index = new ColliderIndex(arena.colliders);

    const visualMaterials = new Map<string, MaterialKey>();
    for (const visual of arena.visuals) visualMaterials.set(visual.id, visual.material);

    for (const collider of arena.colliders) {
      const direct = visualMaterials.get(collider.id);
      if (direct) {
        this.byColliderId.set(collider.id, direct);
        continue;
      }

      // Ramps are a staircase of `<id>-step-N` colliders under one `<id>-visual` slab,
      // so the collider's material has to be resolved through the ramp's name.
      const stepMatch = /^(.*)-step-\d+$/.exec(collider.id);
      const rampVisual = stepMatch ? visualMaterials.get(`${stepMatch[1]}-visual`) : undefined;
      this.byColliderId.set(collider.id, rampVisual ?? DEFAULT_SURFACE);
    }
  }

  /** The material of the collider a hit point lies on. */
  materialAt(point: Vec3, normal: Vec3 | null): MaterialKey {
    // Step just inside the surface, so the probe lands in the collider that was hit
    // rather than in the empty air the bullet came from.
    const x = point.x - (normal?.x ?? 0) * PROBE_DEPTH;
    const y = point.y - (normal?.y ?? 0) * PROBE_DEPTH;
    const z = point.z - (normal?.z ?? 0) * PROBE_DEPTH;

    this.probeMin.x = x - 0.02;
    this.probeMin.y = y - 0.02;
    this.probeMin.z = z - 0.02;
    this.probeMax.x = x + 0.02;
    this.probeMax.y = y + 0.02;
    this.probeMax.z = z + 0.02;

    const candidates = this.index.query(this.probeMin, this.probeMax);
    for (const collider of candidates) {
      if (
        x >= collider.min.x &&
        x <= collider.max.x &&
        y >= collider.min.y &&
        y <= collider.max.y &&
        z >= collider.min.z &&
        z <= collider.max.z
      ) {
        return this.byColliderId.get(collider.id) ?? DEFAULT_SURFACE;
      }
    }
    return DEFAULT_SURFACE;
  }

  /** Test hook: the material assigned to a specific collider. */
  materialForCollider(colliderId: string): MaterialKey | undefined {
    return this.byColliderId.get(colliderId);
  }
}
