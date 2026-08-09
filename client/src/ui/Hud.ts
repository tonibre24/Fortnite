import {
  DAMAGE_FLASH_MS,
  HIT_MARKER_MS,
  KILL_FEED_MAX,
  KILL_FEED_MS,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_SHIELD,
  weaponLabel,
} from '@br/shared';
import type { ConnectionStatus } from '../net/Connection.js';

interface FeedEntry {
  text: string;
  involvesMe: boolean;
  until: number;
}

interface Indicator {
  element: HTMLElement;
  angle: number;
  until: number;
}

/** Everything drawn on top of the 3D view. */
export class Hud {
  private readonly statusEl = mustFind('status');
  private readonly statsEl = mustFind('stats');
  private readonly crosshairEl = mustFind('crosshair');
  private readonly hitMarkerEl = mustFind('hitmarker');
  private readonly healthFill = mustFind('health').querySelector('i') as HTMLElement;
  private readonly healthText = mustFind('health').querySelector('b') as HTMLElement;
  private readonly shieldFill = mustFind('shield').querySelector('i') as HTMLElement;
  private readonly shieldText = mustFind('shield').querySelector('b') as HTMLElement;
  private readonly weaponName = mustFind('weapon').querySelector('.name') as HTMLElement;
  private readonly weaponAmmo = mustFind('weapon').querySelector('.ammo') as HTMLElement;
  private readonly weaponReload = mustFind('weapon').querySelector('.reloading') as HTMLElement;
  private readonly killFeedEl = mustFind('killfeed');
  private readonly damageEl = mustFind('damage');
  private readonly indicatorsEl = mustFind('indicators');
  private readonly bannerEl = mustFind('banner');
  private readonly hintEl = mustFind('hint');

  private readonly feed: FeedEntry[] = [];
  private readonly indicators: Indicator[] = [];
  private hitMarkerUntil = 0;
  private damageUntil = 0;

  setStatus(status: ConnectionStatus, detail: string): void {
    this.statusEl.className = status;
    this.statusEl.textContent = detail ? `${status} — ${detail}` : status;
  }

  setStats(lines: string[]): void {
    this.statsEl.textContent = lines.join('\n');
  }

  setVitals(health: number, shield: number): void {
    this.healthFill.style.width = `${(health / PLAYER_MAX_HEALTH) * 100}%`;
    this.healthText.textContent = `${health}`;
    this.shieldFill.style.width = `${(shield / PLAYER_MAX_SHIELD) * 100}%`;
    this.shieldText.textContent = shield > 0 ? `${shield}` : '';
  }

  setWeapon(packed: number, ammo: number, magazine: number, reloadTicks: number): void {
    this.weaponName.textContent = weaponLabel(packed);
    this.weaponAmmo.textContent = packed === 0 ? '—' : `${ammo} / ${magazine}`;
    this.weaponAmmo.classList.toggle('empty', packed !== 0 && ammo === 0);
    this.weaponReload.textContent = reloadTicks > 0 ? 'reloading…' : '';
  }

  setCrosshairVisible(visible: boolean): void {
    this.crosshairEl.classList.toggle('hidden', !visible);
  }

  setHint(text: string | null): void {
    this.hintEl.classList.toggle('hidden', text === null);
    if (text !== null) this.hintEl.textContent = text;
  }

  setBanner(title: string | null, sub = ''): void {
    this.bannerEl.classList.toggle('show', title !== null);
    if (title !== null) {
      this.bannerEl.innerHTML = '';
      this.bannerEl.append(title);
      if (sub) {
        const span = document.createElement('span');
        span.className = 'sub';
        span.textContent = sub;
        this.bannerEl.append(span);
      }
    }
  }

  showHitMarker(now: number, killed: boolean): void {
    this.hitMarkerUntil = now + HIT_MARKER_MS;
    this.hitMarkerEl.classList.add('show');
    this.hitMarkerEl.classList.toggle('kill', killed);
  }

  /** `angle` is where the damage came from, in radians relative to facing. */
  showDamage(now: number, angle: number): void {
    this.damageUntil = now + DAMAGE_FLASH_MS;
    this.damageEl.classList.add('show');

    const element = document.createElement('div');
    element.className = 'arc';
    this.indicatorsEl.append(element);
    this.indicators.push({ element, angle, until: now + DAMAGE_FLASH_MS * 2 });
  }

  addKill(text: string, involvesMe: boolean, now: number): void {
    this.feed.push({ text, involvesMe, until: now + KILL_FEED_MS });
    while (this.feed.length > KILL_FEED_MAX) this.feed.shift();
    this.renderFeed();
  }

  /** Expires timed elements. Called every frame. */
  update(now: number, viewYaw: number): void {
    if (this.hitMarkerUntil !== 0 && now > this.hitMarkerUntil) {
      this.hitMarkerUntil = 0;
      this.hitMarkerEl.classList.remove('show');
    }
    if (this.damageUntil !== 0 && now > this.damageUntil) {
      this.damageUntil = 0;
      this.damageEl.classList.remove('show');
    }

    for (let i = this.indicators.length - 1; i >= 0; i--) {
      const indicator = this.indicators[i]!;
      if (now > indicator.until) {
        indicator.element.remove();
        this.indicators.splice(i, 1);
        continue;
      }
      // Rotate with the camera so the arc keeps pointing at the attacker.
      const screenAngle = indicator.angle - viewYaw;
      indicator.element.style.transform = `rotate(${screenAngle}rad) translateY(-120px)`;
      indicator.element.style.opacity = `${Math.max(0, (indicator.until - now) / (DAMAGE_FLASH_MS * 2))}`;
    }

    const before = this.feed.length;
    while (this.feed.length > 0 && now > this.feed[0]!.until) this.feed.shift();
    if (this.feed.length !== before) this.renderFeed();
  }

  private renderFeed(): void {
    this.killFeedEl.innerHTML = '';
    for (const entry of this.feed) {
      const line = document.createElement('div');
      line.textContent = entry.text;
      if (entry.involvesMe) line.className = 'you';
      this.killFeedEl.append(line);
    }
  }
}

function mustFind(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id} in index.html`);
  return el;
}
