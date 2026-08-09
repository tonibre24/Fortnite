import './style.css';
import {
  BUS_SIZE_Y,
  DEFAULT_PORT,
  EventType,
  ItemKind,
  LOBBY_COUNTDOWN_TICKS,
  MEDKIT_USE_TICKS,
  PICKUP_RANGE,
  PLAYER_EYE_HEIGHT,
  MoveMode,
  RoundPhase,
  SHIELD_POTION_USE_TICKS,
  STORM_PHASES,
  TICK_RATE,
  isConsumableKind,
  itemLabel,
  dequantizePitch,
  dequantizeYaw,
  unpackWeapon,
  vec3,
  weaponLabel,
  weaponStats,
  type GameEvent,
} from '@br/shared';
import { GameClient } from './game/GameClient.js';
import { InputSampler } from './input/InputSampler.js';
import { PlayerView } from './render/PlayerView.js';
import { Renderer } from './render/Renderer.js';
import { LootView } from './render/LootView.js';
import { RoundView } from './render/RoundView.js';
import { Tracers } from './render/Tracers.js';
import { WorldView } from './render/WorldView.js';
import { Hud } from './ui/Hud.js';

function resolveServerUrl(): string {
  const override = new URLSearchParams(window.location.search).get('server');
  if (override !== null) return override;
  const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (envUrl) return envUrl;
  return `ws://${window.location.hostname || 'localhost'}:${DEFAULT_PORT}`;
}

const canvas = document.getElementById('viewport');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing #viewport canvas');

const renderer = new Renderer(canvas);
const hud = new Hud();
const input = new InputSampler(canvas);
const playerView = new PlayerView(renderer.scene);
const tracers = new Tracers(renderer.scene);
const lootView = new LootView(renderer.scene);
const roundView = new RoundView(renderer.scene);

const client = new GameClient({
  url: resolveServerUrl(),
  name: `player-${Math.floor(Math.random() * 1000)}`,
  input,
  onStatus: (status, detail) => hud.setStatus(status, detail),
});
client.connect();

let worldView: WorldView | null = null;
let worldVersion = -1;
/** Who the camera follows once the local player is out of the round. */
let spectating = 0;
/** Ticks the local player has held fire on a consumable, for the use bar. */
let useTicks = 0;
const eye = vec3();

/** The nearest item within reach, which is what E would take. */
function itemInReach(): { label: string; chest: boolean } | null {
  if (!client.alive) return null;
  const p = client.predictor.state.pos;
  let best: { label: string; chest: boolean } | null = null;
  let bestDistSq = PICKUP_RANGE * PICKUP_RANGE;
  for (const item of client.loot.values()) {
    const dx = item.x - p.x;
    const dy = item.y - p.y;
    const dz = item.z - p.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq >= bestDistSq) continue;
    bestDistSq = distSq;
    best =
      item.kind === ItemKind.Chest
        ? { label: 'chest', chest: true }
        : { label: itemLabel(item), chest: false };
  }
  return best;
}

function nameOf(id: number): string {
  if (id === 0) return 'the storm';
  return id === client.playerId ? 'you' : `player ${id}`;
}

function handleEvent(event: GameEvent, now: number): void {
  switch (event.type) {
    case EventType.Shot:
      if (client.map !== null) tracers.add(event, client.map, now);
      break;
    case EventType.Hit:
      hud.showHitMarker(now, event.killed);
      break;
    case EventType.Damaged: {
      // The wire carries a direction in world space; the HUD wants an angle.
      hud.showDamage(now, Math.atan2(event.dirX, -event.dirZ));
      break;
    }
    case EventType.Kill: {
      const involvesMe = event.killerId === client.playerId || event.victimId === client.playerId;
      const weapon = unpackWeapon(event.weapon);
      const how = weapon === null ? '' : ` [${weaponLabel(event.weapon)}]`;
      hud.addKill(`${nameOf(event.killerId)} eliminated ${nameOf(event.victimId)}${how}`, involvesMe, now);
      if (event.victimId === client.playerId) spectating = event.killerId;
      break;
    }
  }
}

/** Human-readable summary of what the round is doing right now. */
function roundBanner(): { title: string | null; sub: string } {
  const round = client.round;
  if (!client.alive) {
    const won = round.winnerId === client.playerId;
    if (round.phase === RoundPhase.Ended) {
      return {
        title: won ? 'victory royale' : 'round over',
        sub: won ? 'last one standing' : `${nameOf(round.winnerId)} won · next round shortly`,
      };
    }
    return {
      title: 'eliminated',
      sub: `spectating ${nameOf(spectating)} · ${round.aliveCount} still in`,
    };
  }

  switch (round.phase) {
    case RoundPhase.Lobby: {
      const waiting = client.playerCount < 2;
      return {
        title: 'lobby',
        sub: waiting
          ? 'waiting for another player'
          : `bus leaves in ${Math.max(0, Math.ceil((LOBBY_COUNTDOWN_TICKS - round.phaseTick) / TICK_RATE))}s`,
      };
    }
    case RoundPhase.Bus:
      return { title: null, sub: '' };
    case RoundPhase.Ended:
      return {
        title: round.winnerId === client.playerId ? 'victory royale' : 'round over',
        sub:
          round.winnerId === client.playerId
            ? 'last one standing'
            : `${nameOf(round.winnerId)} won · next round shortly`,
      };
    default:
      return { title: null, sub: '' };
  }
}

/** While riding, the camera sits just under the bus looking along its path. */
function busCamera(): boolean {
  if (client.predictor.state.mode !== MoveMode.Bus) return false;
  const p = client.predictor.state.pos;
  renderer.camera.position.set(p.x, p.y - BUS_SIZE_Y, p.z);
  renderer.camera.rotation.set(
    dequantizePitch(client.predictor.state.pitchQ),
    dequantizeYaw(client.predictor.state.yawQ),
    0,
  );
  return true;
}

/** Places the camera: first person while alive, chase cam once eliminated. */
function updateCamera(): void {
  if (busCamera()) return;
  if (client.alive) {
    client.predictor.renderPosition(client.alpha, eye);
    renderer.camera.position.set(eye.x, eye.y + PLAYER_EYE_HEIGHT, eye.z);
    renderer.camera.rotation.set(
      dequantizePitch(client.predictor.state.pitchQ),
      dequantizeYaw(client.predictor.state.yawQ),
      0,
    );
    return;
  }

  // Follow the killer if they are still around, otherwise anyone at all.
  let target = client.remotes.get(spectating);
  if (target === undefined) {
    const first = client.remotes.values().next();
    target = first.done ? undefined : first.value;
    if (target !== undefined) spectating = target.id;
  }
  if (target === undefined) return;

  const back = 4.5;
  renderer.camera.position.set(
    target.x + Math.sin(target.yaw) * back,
    target.y + PLAYER_EYE_HEIGHT + 1.4,
    target.z + Math.cos(target.yaw) * back,
  );
  renderer.camera.rotation.set(-0.18, target.yaw, 0);
}

function buildStats(): string[] {
  const p = client.predictor;
  return [
    `id       ${client.playerId || '-'}`,
    `ping     ${client.connection.rttMs.toFixed(0)} ms`,
    `players  ${client.playerCount}`,
    `kills    ${p.state.kills}`,
    `pos      ${p.state.pos.x.toFixed(1)} ${p.state.pos.y.toFixed(1)} ${p.state.pos.z.toFixed(1)}`,
    `pred err ${p.lastError.toFixed(4)} (max ${p.maxError.toFixed(3)})`,
    `loot     ${client.loot.size}`,
    `round    ${['lobby', 'bus', 'playing', 'ended'][client.round.phase] ?? '?'} · storm ${Math.min(client.round.stormPhase + 1, STORM_PHASES)}/${STORM_PHASES}`,
    `map      ${client.mapHashMatches ? 'ok' : 'MISMATCH'}`,
  ];
}

function frame(): void {
  const now = performance.now();
  client.update(now);

  // Rebuilt whenever a new round hands us a new map.
  if (client.map !== null && worldVersion !== client.mapVersion) {
    worldView?.dispose(renderer.scene);
    worldView = new WorldView(renderer.scene, client.map);
    worldVersion = client.mapVersion;
  }

  for (const event of client.drainEvents()) handleEvent(event, now);

  if (client.ready) {
    updateCamera();
    playerView.update(client.remotes);

    const state = client.predictor.state;
    const weapon = unpackWeapon(state.weapon);
    const held = state.inventory[state.slot];

    // The use bar is a local guess at the server's timer; the effect itself is
    // still entirely server-side.
    if (held !== undefined && isConsumableKind(held.kind) && input.firingNow && client.alive) {
      useTicks += 1;
    } else {
      useTicks = 0;
    }
    const useNeeded =
      held !== undefined && held.kind === ItemKind.Medkit ? MEDKIT_USE_TICKS : SHIELD_POTION_USE_TICKS;
    hud.setUseProgress(useTicks === 0 ? 0 : useTicks / useNeeded);

    hud.setInventory(state.inventory, state.slot);
    const reach = itemInReach();
    hud.setPrompt(reach === null ? null : `E — ${reach.chest ? 'open chest' : `pick up ${reach.label}`}`);
    hud.setVitals(state.health, state.shield);
    hud.setWeapon(state.weapon, state.ammo, weapon === null ? 0 : weaponStats(weapon.cls).magazine, state.reload);
    hud.setCrosshairVisible(client.alive && input.locked && state.mode === MoveMode.Ground);
    const banner = roundBanner();
    hud.setBanner(banner.title, banner.sub);
    hud.setRound(client.round, state.mode);
    hud.setHint(
      input.locked
        ? null
        : 'click to capture the mouse — WASD move, shift sprint, space jump, R reload, E pick up, 1-5 slots',
    );
  }

  roundView.update(client.round);
  lootView.update(client.loot, now);
  tracers.update(now);
  tracers.flush();
  hud.update(now, dequantizeYaw(client.predictor.state.yawQ));
  hud.setStats(buildStats());
  renderer.render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
