import {
  DEFAULT_WEAPON_ID,
  WEAPONS,
  computeShotDirections,
  fireIntervalMs,
  getWeapon,
  isWeaponId,
  resolveHitscan,
  type ColliderIndex,
  type HitscanTarget,
  type Vec3,
  type WeaponDefinition,
  type WeaponId,
} from '@riftfront/shared';

/**
 * Client-side weapon presentation and firing cadence.
 *
 * The server remains authoritative over ammunition, fire rate and damage; this class
 * decides *when to ask*, and produces the immediate local feedback (recoil, muzzle flash,
 * tracers, crosshair bloom) that makes shooting feel responsive.
 *
 * Local tracers are drawn from the same deterministic spread the server computes for the
 * same `(sessionId, shotSeq)`, so what the player sees matches what the server resolved —
 * without waiting a round trip for the broadcast.
 */

export interface ShotVisual {
  origin: Vec3;
  endPoints: Vec3[];
  impactNormals: (Vec3 | null)[];
  hitPlayer: boolean[];
}

export interface FireRequest {
  direction: Vec3;
  aiming: boolean;
}

export class WeaponController {
  private weaponIdValue: WeaponId = DEFAULT_WEAPON_ID;
  private lastFireAtMs = -Infinity;
  private bloom = 0;

  constructor(private readonly colliders: ColliderIndex) {}

  get weaponId(): WeaponId {
    return this.weaponIdValue;
  }

  get weapon(): WeaponDefinition {
    return WEAPONS[this.weaponIdValue];
  }

  /** Follows the authoritative weapon from replicated state. */
  syncWeapon(weaponId: string): void {
    if (!isWeaponId(weaponId) || weaponId === this.weaponIdValue) return;
    this.weaponIdValue = weaponId;
    this.lastFireAtMs = -Infinity;
  }

  /**
   * Decides whether a trigger state should produce a shot this frame.
   * Semi-automatic weapons require the trigger to be re-pressed.
   */
  shouldFire(params: {
    firePressed: boolean;
    fireHeld: boolean;
    nowMs: number;
    alive: boolean;
    reloading: boolean;
    magazine: number;
    matchRunning: boolean;
  }): boolean {
    if (!params.alive || !params.matchRunning) return false;
    if (params.reloading || params.magazine <= 0) return false;

    const weapon = this.weapon;
    const wantsToFire = weapon.automatic ? params.fireHeld : params.firePressed;
    if (!wantsToFire) return false;

    // The client paces itself to the weapon's RPM; the server independently enforces it.
    return params.nowMs - this.lastFireAtMs >= fireIntervalMs(weapon);
  }

  /** True when the trigger was pulled on an empty magazine (dry-fire feedback). */
  isDryFire(params: {
    firePressed: boolean;
    alive: boolean;
    reloading: boolean;
    magazine: number;
  }): boolean {
    return params.firePressed && params.alive && !params.reloading && params.magazine <= 0;
  }

  /**
   * Records a shot and builds its local visualisation.
   * `shotSeq` must be the sequence number the network layer sent to the server.
   */
  registerShot(params: {
    shotSeq: number;
    sessionId: string;
    origin: Vec3;
    direction: Vec3;
    aiming: boolean;
    nowMs: number;
    targets: readonly HitscanTarget[];
  }): ShotVisual {
    const weapon = this.weapon;
    this.lastFireAtMs = params.nowMs;
    this.bloom = Math.min(1, this.bloom + (weapon.automatic ? 0.22 : 0.55));

    const directions = computeShotDirections(
      weapon,
      params.direction,
      params.aiming,
      params.sessionId,
      params.shotSeq,
    );

    const endPoints: Vec3[] = [];
    const impactNormals: (Vec3 | null)[] = [];
    const hitPlayer: boolean[] = [];

    for (const direction of directions) {
      const outcome = resolveHitscan(
        params.origin,
        direction,
        weapon.range,
        this.colliders,
        params.targets,
      );
      endPoints.push(outcome.endPoint);
      impactNormals.push(outcome.worldNormal);
      hitPlayer.push(outcome.hit !== null);
    }

    return { origin: params.origin, endPoints, impactNormals, hitPlayer };
  }

  /** Recoil for the shot just fired, in radians. */
  recoilForShot(aiming: boolean): { vertical: number; horizontal: number } {
    const weapon = this.weapon;
    const scale = aiming ? 0.6 : 1;
    // Horizontal recoil alternates pseudo-randomly around zero so the pattern is
    // controllable rather than a consistent drift to one side.
    const horizontal = (Math.random() * 2 - 1) * weapon.recoilHorizontal * scale;
    return { vertical: weapon.recoilVertical * scale, horizontal };
  }

  /** Decays crosshair bloom towards its resting value. */
  update(dtSeconds: number): void {
    this.bloom *= Math.exp(-dtSeconds * 5.5);
    if (this.bloom < 0.001) this.bloom = 0;
  }

  /**
   * Crosshair gap in pixels. Combines the weapon's cone, recent fire and movement, so the
   * crosshair honestly represents accuracy.
   */
  crosshairGap(params: { aiming: boolean; speed: number; grounded: boolean }): number {
    const weapon = this.weapon;
    const coneRadians = params.aiming ? weapon.spreadAiming : weapon.spreadHipFire;
    const base = 4 + coneRadians * 210;
    const movement = Math.min(1, params.speed / 9) * (params.aiming ? 3 : 8);
    const air = params.grounded ? 0 : 6;
    return base + movement + air + this.bloom * 22;
  }

  /** Resets per-life state. */
  reset(): void {
    this.lastFireAtMs = -Infinity;
    this.bloom = 0;
    this.weaponIdValue = DEFAULT_WEAPON_ID;
  }

  /** Weapon for a given id, used when rendering another player's shot. */
  static weaponFor(weaponId: string): WeaponDefinition {
    return isWeaponId(weaponId) ? getWeapon(weaponId) : WEAPONS[DEFAULT_WEAPON_ID];
  }
}
