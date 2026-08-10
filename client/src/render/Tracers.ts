import * as THREE from 'three';
import {
  TRACER_FADE_DISTANCE,
  TRACER_LIFETIME_MS,
  WEAPON_MAX_RANGE,
  aimDirection,
  raycastWorld,
  spreadDirection,
  unpackWeapon,
  vec3,
  weaponStats,
  type GameMap,
  type ShotEvent,
} from '@br/shared';

const MAX_TRACERS = 96;

const aim = vec3();
const pellet = vec3();

/**
 * Short-lived lines showing where shots went.
 *
 * Only the shot's origin and aim direction come over the wire; the individual
 * pellets are regenerated here with the same seeded spread the server used, so
 * a shotgun blast draws the exact cone that was resolved without sending nine
 * separate rays.
 */
export class Tracers {
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions = new Float32Array(MAX_TRACERS * 6);
  /** Per-vertex colour, so a round fades along its length and with range. */
  private readonly colors = new Float32Array(MAX_TRACERS * 6);
  private readonly expiry = new Float64Array(MAX_TRACERS);
  private readonly line: THREE.LineSegments;
  private next = 0;

  constructor(scene: THREE.Scene) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.line = new THREE.LineSegments(
      this.geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.line.frustumCulled = false;
    scene.add(this.line);
  }

  add(event: ShotEvent, map: GameMap, now: number): void {
    const weapon = unpackWeapon(event.weapon);
    if (weapon === null) return;
    const stats = weaponStats(weapon.cls);

    aimDirection(event.yawQ, event.pitchQ, aim);
    for (let i = 0; i < stats.pellets; i++) {
      spreadDirection(aim, stats.spread, event.shooterId, event.seq, i, pellet);
      const distance = raycastWorld(
        map.world,
        event.x,
        event.y,
        event.z,
        pellet.x,
        pellet.y,
        pellet.z,
        WEAPON_MAX_RANGE,
      );
      this.push(
        event.x,
        event.y,
        event.z,
        event.x + pellet.x * distance,
        event.y + pellet.y * distance,
        event.z + pellet.z * distance,
        now,
      );
    }
  }

  private push(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    now: number,
  ): void {
    const slot = this.next;
    this.next = (this.next + 1) % MAX_TRACERS;
    const o = slot * 6;
    this.positions[o] = ax;
    this.positions[o + 1] = ay;
    this.positions[o + 2] = az;
    this.positions[o + 3] = bx;
    this.positions[o + 4] = by;
    this.positions[o + 5] = bz;
    this.expiry[slot] = now + TRACER_LIFETIME_MS;

    // Bright at the muzzle, dimming towards the impact, and dimmer overall the
    // further the shot travelled - a long-range round should read as a hint of
    // a line rather than the same hard streak as one fired across a room.
    const length = Math.hypot(bx - ax, by - ay, bz - az);
    const reach = 1 - Math.min(1, length / TRACER_FADE_DISTANCE) * 0.75;
    const c = slot * 6;
    this.colors[c] = 1 * reach;
    this.colors[c + 1] = 0.91 * reach;
    this.colors[c + 2] = 0.66 * reach;
    this.colors[c + 3] = 0.42 * reach;
    this.colors[c + 4] = 0.34 * reach;
    this.colors[c + 5] = 0.2 * reach;
  }

  update(now: number): void {
    let dirty = false;
    for (let slot = 0; slot < MAX_TRACERS; slot++) {
      if (this.expiry[slot] === 0 || now <= this.expiry[slot]!) continue;
      this.expiry[slot] = 0;
      // Collapsing a segment to a point is cheaper than rebuilding the buffer.
      const o = slot * 6;
      for (let i = 0; i < 6; i++) this.positions[o + i] = 0;
      dirty = true;
    }
    if (dirty) this.geometry.getAttribute('position').needsUpdate = true;
  }

  /** Uploads whatever was added this frame. */
  flush(): void {
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('color').needsUpdate = true;
  }
}
