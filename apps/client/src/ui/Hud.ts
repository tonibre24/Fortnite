import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { Scene } from '@babylonjs/core/scene';
import {
  KILL_FEED_ENTRY_TTL_MS,
  KILL_FEED_MAX_ENTRIES,
  LOW_HEALTH_THRESHOLD,
  MAX_HEALTH,
  MAX_SHIELD,
  angleDelta,
  clamp,
  type KillPayload,
  type WeaponId,
  type Vec3,
} from '@riftfront/shared';
import { WeaponController } from '../game/WeaponController.js';
import { el, formatClock, setClass, setHidden, setText } from './dom.js';

/**
 * The in-game HUD: crosshair, vitals, weapon, match bar, kill feed, damage feedback and
 * the directional damage indicators.
 *
 * Everything here is pooled or reused. Floating damage numbers and damage arrows come
 * from fixed-size DOM pools so a long firefight cannot accumulate elements.
 */

const DAMAGE_NUMBER_POOL = 20;
const DAMAGE_ARROW_POOL = 6;
const DAMAGE_NUMBER_LIFETIME_MS = 900;
const DAMAGE_ARROW_LIFETIME_MS = 1400;

interface FloatingNumber {
  node: HTMLElement;
  world: Vector3;
  bornAt: number;
  active: boolean;
}

interface DamageArrow {
  node: HTMLElement;
  /** World-space yaw from the victim to the attacker. */
  worldYaw: number;
  bornAt: number;
  active: boolean;
}

interface KillFeedEntry {
  node: HTMLElement;
  expiresAt: number;
}

export interface HudVitals {
  health: number;
  shield: number;
  alive: boolean;
}

export interface HudWeaponState {
  weaponId: WeaponId;
  magazine: number;
  reserve: number;
  reloading: boolean;
  reloadProgress: number;
}

export interface HudMatchState {
  phase: string;
  timeRemainingMs: number;
  score: number;
  placement: number;
  playerCount: number;
  scoreLimit: number;
}

export class Hud {
  readonly root: HTMLElement;

  private readonly crosshair: HTMLElement;
  private readonly crosshairParts: {
    top: HTMLElement;
    bottom: HTMLElement;
    left: HTMLElement;
    right: HTMLElement;
  };
  private readonly hitmarker: HTMLElement;

  private readonly healthBar: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly healthValue: HTMLElement;
  private readonly shieldFill: HTMLElement;
  private readonly shieldValue: HTMLElement;

  private readonly weaponName: HTMLElement;
  private readonly ammoValue: HTMLElement;
  private readonly ammoMagazine: HTMLElement;
  private readonly ammoReserve: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly reloadFill: HTMLElement;
  private readonly reloadText: HTMLElement;

  private readonly timer: HTMLElement;
  private readonly matchMeta: HTMLElement;
  private readonly scoreValue: HTMLElement;

  private readonly killFeed: HTMLElement;
  private readonly killFeedEntries: KillFeedEntry[] = [];

  private readonly damageNumbers: FloatingNumber[] = [];
  private readonly damageNumbersLayer: HTMLElement;
  private readonly damageArrows: DamageArrow[] = [];
  private readonly damageArrowsLayer: HTMLElement;
  private readonly damageVignette: HTMLElement;
  private readonly lowHealthOverlay: HTMLElement;

  private readonly banner: HTMLElement;
  private readonly bannerHeadline: HTMLElement;
  private readonly bannerSub: HTMLElement;

  private readonly pingValue: HTMLElement;
  private readonly playersValue: HTMLElement;

  private hitmarkerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sessionIdProvider: () => string) {
    // --- crosshair ---------------------------------------------------------
    const top = el('span', { class: 'v' });
    const bottom = el('span', { class: 'v' });
    const left = el('span', { class: 'h' });
    const right = el('span', { class: 'h' });
    this.crosshairParts = { top, bottom, left, right };
    this.crosshair = el('div', { class: 'crosshair' }, [
      top,
      bottom,
      left,
      right,
      el('span', { class: 'dot' }),
    ]);

    this.hitmarker = el('div', { class: 'hitmarker' }, [
      el('span'),
      el('span'),
      el('span'),
      el('span'),
    ]);

    // --- vitals ------------------------------------------------------------
    this.healthFill = el('i');
    this.healthValue = el('b', { text: '100' });
    this.healthBar = el('div', { class: 'bar health' }, [this.healthFill, this.healthValue]);

    this.shieldFill = el('i');
    this.shieldValue = el('b', { text: '50' });
    const shieldBar = el('div', { class: 'bar shield' }, [this.shieldFill, this.shieldValue]);

    const vitals = el('div', { class: 'vitals' }, [
      el('div', { class: 'vitals-label', text: 'Vitals' }),
      shieldBar,
      this.healthBar,
    ]);

    // --- weapon ------------------------------------------------------------
    this.weaponName = el('div', { class: 'name', text: '' });
    this.ammoMagazine = el('span', { text: '30' });
    this.ammoReserve = el('span', { class: 'reserve', text: '/ 180' });
    this.ammoValue = el('div', { class: 'ammo' }, [this.ammoMagazine, this.ammoReserve]);
    this.reloadFill = el('i');
    this.reloadBar = el('div', { class: 'reload-bar', hidden: true }, [this.reloadFill]);
    this.reloadText = el('div', { class: 'reload-text', text: 'Reloading', hidden: true });

    const weapon = el('div', { class: 'weapon' }, [
      this.weaponName,
      this.ammoValue,
      this.reloadBar,
      this.reloadText,
      el('div', { class: 'swap', text: '1 Rifle   ·   2 Shotgun' }),
    ]);

    // --- match bar ---------------------------------------------------------
    this.timer = el('div', { class: 'timer', text: '5:00' });
    this.matchMeta = el('div', { class: 'meta', text: 'Waiting' });
    this.scoreValue = el('div', { class: 'score', text: '0' });
    const matchbar = el('div', { class: 'matchbar' }, [
      el('div', {}, [this.matchMeta, this.timer]),
      el('div', {}, [el('div', { class: 'meta', text: 'Eliminations' }), this.scoreValue]),
    ]);

    // --- kill feed & damage feedback ---------------------------------------
    this.killFeed = el('div', { class: 'killfeed' });

    this.damageNumbersLayer = el('div', { class: 'damage-numbers' });
    for (let i = 0; i < DAMAGE_NUMBER_POOL; i++) {
      const node = el('div', { class: 'damage-number' });
      node.style.opacity = '0';
      this.damageNumbersLayer.append(node);
      this.damageNumbers.push({ node, world: new Vector3(), bornAt: 0, active: false });
    }

    this.damageArrowsLayer = el('div', { class: 'damage-arrows' });
    for (let i = 0; i < DAMAGE_ARROW_POOL; i++) {
      const node = el('div', { class: 'damage-arrow' });
      this.damageArrowsLayer.append(node);
      this.damageArrows.push({ node, worldYaw: 0, bornAt: 0, active: false });
    }

    this.damageVignette = el('div', { class: 'damage-vignette' });
    this.lowHealthOverlay = el('div', { class: 'low-health' });
    this.lowHealthOverlay.style.display = 'none';

    // --- banner & net stats ------------------------------------------------
    this.bannerHeadline = el('div', { class: 'headline', text: '' });
    this.bannerSub = el('div', { class: 'sub', text: '' });
    this.banner = el('div', { class: 'banner', hidden: true }, [
      this.bannerHeadline,
      this.bannerSub,
    ]);

    this.pingValue = el('span', { text: '-- ms' });
    this.playersValue = el('span', { text: '1' });
    const netstat = el('div', { class: 'netstat' }, [
      el('div', {}, [el('b', { text: 'PING ' }), this.pingValue]),
      el('div', {}, [el('b', { text: 'PLAYERS ' }), this.playersValue]),
    ]);

    this.root = el('div', { id: 'hud', hidden: true }, [
      this.lowHealthOverlay,
      this.damageVignette,
      this.crosshair,
      this.hitmarker,
      this.damageArrowsLayer,
      this.damageNumbersLayer,
      vitals,
      weapon,
      matchbar,
      this.killFeed,
      this.banner,
      netstat,
    ]);
  }

  show(): void {
    setHidden(this.root, false);
  }

  hide(): void {
    setHidden(this.root, true);
  }

  // -------------------------------------------------------------------------
  // Per-frame updates
  // -------------------------------------------------------------------------

  setCrosshairGap(gapPx: number, hostile: boolean): void {
    const gap = clamp(gapPx, 3, 40);
    this.crosshairParts.top.style.top = `${22 - gap - 8}px`;
    this.crosshairParts.bottom.style.top = `${22 + gap}px`;
    this.crosshairParts.left.style.left = `${22 - gap - 8}px`;
    this.crosshairParts.right.style.left = `${22 + gap}px`;
    this.crosshair.dataset.hostile = hostile ? 'true' : 'false';
  }

  setVitals(vitals: HudVitals): void {
    const health = clamp(vitals.health, 0, MAX_HEALTH);
    const shield = clamp(vitals.shield, 0, MAX_SHIELD);

    this.healthFill.style.width = `${(health / MAX_HEALTH) * 100}%`;
    this.shieldFill.style.width = `${(shield / MAX_SHIELD) * 100}%`;
    setText(this.healthValue, String(Math.ceil(health)));
    setText(this.shieldValue, String(Math.ceil(shield)));

    const low = vitals.alive && health > 0 && health <= LOW_HEALTH_THRESHOLD;
    setClass(this.healthBar, 'low', low);
    this.lowHealthOverlay.style.display = low ? 'block' : 'none';
  }

  setWeapon(state: HudWeaponState): void {
    const weapon = WeaponController.weaponFor(state.weaponId);
    setText(this.weaponName, weapon.displayName);
    setText(this.ammoMagazine, String(state.magazine));
    setText(this.ammoReserve, `/ ${state.reserve}`);
    setClass(this.ammoValue, 'empty', state.magazine === 0 && !state.reloading);

    setHidden(this.reloadBar, !state.reloading);
    setHidden(this.reloadText, !state.reloading);
    if (state.reloading) {
      this.reloadFill.style.width = `${clamp(state.reloadProgress, 0, 1) * 100}%`;
    }
  }

  setMatch(state: HudMatchState): void {
    setText(this.timer, formatClock(state.timeRemainingMs));
    setClass(this.timer, 'urgent', state.phase === 'PLAYING' && state.timeRemainingMs <= 30_000);
    setText(
      this.scoreValue,
      `${state.score}${state.scoreLimit > 0 ? ` / ${state.scoreLimit}` : ''}`,
    );

    const label =
      state.phase === 'PLAYING'
        ? state.placement > 0
          ? `Rank ${state.placement} of ${state.playerCount}`
          : 'Deathmatch'
        : state.phase === 'COUNTDOWN'
          ? 'Starting'
          : state.phase === 'FINISHED'
            ? 'Match over'
            : 'Waiting for players';
    setText(this.matchMeta, label);
  }

  setNetStats(pingMs: number, playerCount: number): void {
    const rounded = Math.round(pingMs);
    setText(this.pingValue, `${rounded} ms`);
    this.pingValue.className = rounded < 80 ? 'good' : rounded < 160 ? 'fair' : 'poor';
    setText(this.playersValue, String(playerCount));
  }

  // -------------------------------------------------------------------------
  // Combat feedback
  // -------------------------------------------------------------------------

  showHitMarker(headshot: boolean): void {
    this.hitmarker.classList.remove('show');
    setClass(this.hitmarker, 'headshot', headshot);
    // Force a reflow so the animation restarts on rapid consecutive hits.
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add('show');

    if (this.hitmarkerTimer !== null) clearTimeout(this.hitmarkerTimer);
    this.hitmarkerTimer = setTimeout(() => {
      this.hitmarker.classList.remove('show');
      this.hitmarkerTimer = null;
    }, 240);
  }

  /** Spawns a floating damage number anchored to a world position. */
  showDamageNumber(worldPoint: Vec3, damage: number, headshot: boolean, nowMs: number): void {
    const slot =
      this.damageNumbers.find((entry) => !entry.active) ??
      this.damageNumbers.reduce((oldest, entry) => (entry.bornAt < oldest.bornAt ? entry : oldest));

    slot.active = true;
    slot.bornAt = nowMs;
    slot.world.set(worldPoint.x, worldPoint.y, worldPoint.z);
    setText(slot.node, String(Math.round(damage)));
    setClass(slot.node, 'headshot', headshot);
    slot.node.style.opacity = '1';
  }

  /** Shows a directional indicator pointing towards the attacker. */
  showDamageDirection(attackerYaw: number, nowMs: number): void {
    const slot =
      this.damageArrows.find((entry) => !entry.active) ??
      this.damageArrows.reduce((oldest, entry) => (entry.bornAt < oldest.bornAt ? entry : oldest));

    slot.active = true;
    slot.bornAt = nowMs;
    slot.worldYaw = attackerYaw;
    slot.node.style.opacity = '1';
  }

  flashDamage(): void {
    this.damageVignette.style.opacity = '1';
    // The transition handles the fade; a rAF hand-off avoids fighting the style write.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.damageVignette.style.opacity = '0';
      });
    });
  }

  addKillFeedEntry(payload: KillPayload, nowMs: number): void {
    const sessionId = this.sessionIdProvider();
    const involved = payload.attackerId === sessionId || payload.victimId === sessionId;

    const attackerNode = el('span', {
      class: `who${payload.attackerId === sessionId ? ' self' : ''}`,
      text: payload.attackerName,
    });
    const victimNode = el('span', {
      class: `victim${payload.victimId === sessionId ? ' self' : ''}`,
      text: payload.victimName,
    });

    const node = el('div', { class: `entry${involved ? ' involved' : ''}` }, [
      attackerNode,
      el('span', {
        class: `icon${payload.headshot ? ' head' : ''}`,
        text: payload.headshot ? 'headshot' : 'eliminated',
      }),
      victimNode,
    ]);

    this.killFeed.append(node);
    this.killFeedEntries.push({ node, expiresAt: nowMs + KILL_FEED_ENTRY_TTL_MS });

    while (this.killFeedEntries.length > KILL_FEED_MAX_ENTRIES) {
      const removed = this.killFeedEntries.shift();
      removed?.node.remove();
    }
  }

  showBanner(headline: string, sub: string, variant: 'eliminated' | 'countdown' | 'info'): void {
    setText(this.bannerHeadline, headline);
    setText(this.bannerSub, sub);
    this.banner.className = `banner ${variant}`;
    setHidden(this.banner, false);
  }

  hideBanner(): void {
    setHidden(this.banner, true);
  }

  /**
   * Advances timed HUD elements and projects world-anchored ones to screen space.
   * Called once per rendered frame.
   */
  update(params: {
    nowMs: number;
    scene: Scene;
    camera: Camera;
    viewportWidth: number;
    viewportHeight: number;
    playerYaw: number;
  }): void {
    // Damage numbers rise and fade at their world anchor.
    for (const entry of this.damageNumbers) {
      if (!entry.active) continue;
      const age = params.nowMs - entry.bornAt;
      if (age >= DAMAGE_NUMBER_LIFETIME_MS) {
        entry.active = false;
        entry.node.style.opacity = '0';
        continue;
      }

      const progress = age / DAMAGE_NUMBER_LIFETIME_MS;
      const lifted = new Vector3(entry.world.x, entry.world.y + progress * 0.9, entry.world.z);
      const projected = Vector3.Project(
        lifted,
        Matrix.IdentityReadOnly,
        params.scene.getTransformMatrix(),
        params.camera.viewport.toGlobal(params.viewportWidth, params.viewportHeight),
      );

      // Behind the camera or off screen: hide rather than drawing a mirrored artefact.
      if (projected.z < 0 || projected.z > 1) {
        entry.node.style.opacity = '0';
        continue;
      }

      entry.node.style.transform = `translate(-50%, -50%) translate(${projected.x}px, ${projected.y}px)`;
      entry.node.style.opacity = String(1 - progress);
    }

    // Damage arrows rotate to keep pointing at the attacker as the player turns.
    for (const entry of this.damageArrows) {
      if (!entry.active) continue;
      const age = params.nowMs - entry.bornAt;
      if (age >= DAMAGE_ARROW_LIFETIME_MS) {
        entry.active = false;
        entry.node.style.opacity = '0';
        continue;
      }
      const relative = angleDelta(params.playerYaw, entry.worldYaw);
      entry.node.style.transform = `rotate(${relative}rad)`;
      entry.node.style.opacity = String(1 - age / DAMAGE_ARROW_LIFETIME_MS);
    }

    // Expire kill feed entries.
    while (this.killFeedEntries.length > 0 && this.killFeedEntries[0].expiresAt <= params.nowMs) {
      const removed = this.killFeedEntries.shift();
      removed?.node.remove();
    }
  }

  /** Clears transient feedback, e.g. between matches. */
  resetTransient(): void {
    for (const entry of this.damageNumbers) {
      entry.active = false;
      entry.node.style.opacity = '0';
    }
    for (const entry of this.damageArrows) {
      entry.active = false;
      entry.node.style.opacity = '0';
    }
    for (const entry of this.killFeedEntries) entry.node.remove();
    this.killFeedEntries.length = 0;
    this.hideBanner();
  }

  dispose(): void {
    if (this.hitmarkerTimer !== null) clearTimeout(this.hitmarkerTimer);
    this.hitmarkerTimer = null;
    this.resetTransient();
    this.root.remove();
  }
}
