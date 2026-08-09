import {
  DAMAGE_FLASH_MS,
  INVENTORY_SLOTS,
  ItemKind,
  RARITY_COLORS,
  RARITY_NAMES,
  isConsumableKind,
  isWeaponKind,
  itemLabel,
  HIT_MARKER_MS,
  KILL_FEED_MAX,
  KILL_FEED_MS,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_SHIELD,
  weaponLabel,
  MoveMode,
  RoundPhase,
  STORM_PHASES,
  TICK_RATE,
  type ItemStack,
  type RoundState,
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
  private readonly inventoryEl = mustFind('inventory');
  private readonly promptEl = mustFind('prompt');
  private readonly useBarEl = mustFind('usebar');
  private readonly useBarFill = mustFind('usebar').querySelector('i') as HTMLElement;
  private readonly roundEl = mustFind('round');
  private readonly perfEl = mustFind('perf');
  private readonly volumeSlider = mustFind('volume-slider') as HTMLInputElement;
  private readonly volumeValue = mustFind('volume-value');

  /** Set by the caller to receive slider moves, as a 0..1 fraction. */
  onVolumeChange: ((value: number) => void) | null = null;
  private volumeBound = false;
  private readonly slotEls: HTMLElement[] = [];
  private inventorySignature = '';

  private readonly feed: FeedEntry[] = [];
  private readonly indicators: Indicator[] = [];
  private hitMarkerUntil = 0;
  private damageUntil = 0;

  constructor() {
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.innerHTML =
        '<span class="idx"></span><span class="label"></span><span class="qty"></span><span class="tint"></span>';
      (slot.querySelector('.idx') as HTMLElement).textContent = `${i + 1}`;
      this.inventoryEl.append(slot);
      this.slotEls.push(slot);
    }
  }

  setStatus(status: ConnectionStatus, detail: string): void {
    this.statusEl.className = status;
    this.statusEl.textContent = detail ? `${status} — ${detail}` : status;
  }

  setStats(lines: string[]): void {
    this.statsEl.textContent = lines.join('\n');
  }

  setPerf(text: string): void {
    this.perfEl.textContent = text;
  }

  /** Positions the slider, without firing the change callback. */
  setVolume(value: number): void {
    const percent = Math.round(value * 100);
    this.volumeSlider.value = String(percent);
    this.volumeValue.textContent = `${percent}%`;
    // Bound once, lazily, so the initial position never echoes back out.
    if (!this.volumeBound) {
      this.volumeBound = true;
      this.volumeSlider.addEventListener('input', () => {
        const fraction = Number(this.volumeSlider.value) / 100;
        this.volumeValue.textContent = `${this.volumeSlider.value}%`;
        this.onVolumeChange?.(fraction);
      });
    }
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

  /** Redraws the five slots, but only when something in them actually changed. */
  setInventory(inventory: readonly ItemStack[], held: number): void {
    const signature = `${held}|${inventory.map((s) => `${s.kind}.${s.rarity}.${s.count}`).join(',')}`;
    if (signature === this.inventorySignature) return;
    this.inventorySignature = signature;

    for (let i = 0; i < this.slotEls.length; i++) {
      const el = this.slotEls[i]!;
      const stack = inventory[i];
      el.classList.toggle('held', i === held);
      const label = el.querySelector('.label') as HTMLElement;
      const qty = el.querySelector('.qty') as HTMLElement;
      const tint = el.querySelector('.tint') as HTMLElement;

      if (stack === undefined || stack.kind === ItemKind.None) {
        label.textContent = '';
        qty.textContent = '';
        tint.style.background = 'transparent';
        continue;
      }
      label.textContent = isWeaponKind(stack.kind)
        ? `${RARITY_NAMES[stack.rarity] ?? ''}\n${itemLabel(stack)}`
        : itemLabel(stack);
      qty.textContent = isConsumableKind(stack.kind) ? `x${stack.count}` : `${stack.count}`;
      tint.style.background = `#${(RARITY_COLORS[stack.rarity] ?? RARITY_COLORS[0]).toString(16).padStart(6, '0')}`;
    }
  }

  /** Top-centre round readout: phase, who is left, and the storm clock. */
  setRound(round: RoundState, mode: number): void {
    const parts: string[] = [];
    parts.push(`${round.aliveCount} alive`);

    if (round.phase === RoundPhase.Bus) {
      parts.push(mode === MoveMode.Bus ? 'space to jump' : 'dropping');
    } else if (round.phase === RoundPhase.Playing) {
      const phase = Math.min(round.stormPhase + 1, STORM_PHASES);
      parts.push(
        round.stormWait > 0
          ? `storm ${phase}/${STORM_PHASES} in ${Math.ceil(round.stormWait / TICK_RATE)}s`
          : `storm ${phase}/${STORM_PHASES} closing`,
      );
    } else if (round.phase === RoundPhase.Lobby) {
      parts.push('lobby');
    }
    this.roundEl.textContent = parts.join('   ·   ');
  }

  setPrompt(text: string | null): void {
    this.promptEl.classList.toggle('show', text !== null);
    if (text !== null) this.promptEl.textContent = text;
  }

  /** Progress bar while a medkit or potion is being drunk. `progress` is 0..1. */
  setUseProgress(progress: number): void {
    this.useBarEl.classList.toggle('show', progress > 0);
    this.useBarFill.style.width = `${Math.min(1, progress) * 100}%`;
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
