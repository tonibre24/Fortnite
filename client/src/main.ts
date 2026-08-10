import './style.css';
import * as THREE from 'three';
import {
  BUS_SIZE_Y,
  EventType,
  ItemKind,
  LOBBY_COUNTDOWN_TICKS,
  MEDKIT_USE_TICKS,
  PICKUP_RANGE,
  PLAYER_EYE_HEIGHT,
  MoveMode,
  PERF_LOG_MAX,
  PERF_SAMPLE_FRAMES,
  RoundPhase,
  SHIELD_POTION_USE_TICKS,
  StateFlag,
  STORM_PHASES,
  TICK_RATE,
  COLOR_GROUND,
  WEAPON_MAX_RANGE,
  aimDirection,
  effectiveSpread,
  raycastWorld,
  spreadDirection,
  isConsumableKind,
  itemLabel,
  outsideStorm,
  resolveServerUrl,
  dequantizePitch,
  dequantizeYaw,
  unpackWeapon,
  vec3,
  weaponLabel,
  weaponStats,
  type GameEvent,
} from '@br/shared';
import { GameAudio } from './audio/GameAudio.js';
import { GameClient } from './game/GameClient.js';
import { InputSampler } from './input/InputSampler.js';
import { PlayerView } from './render/PlayerView.js';
import { loadStoredTier, QUALITY_TIER_NAMES, QualityTier, storeTier, type QualityTierId } from './render/Quality.js';
import { Renderer } from './render/Renderer.js';
import { Decor } from './render/Decor.js';
import { FarmDressing } from './render/FarmDressing.js';
import { LootView } from './render/LootView.js';
import { RoundView } from './render/RoundView.js';
import { Tracers } from './render/Tracers.js';
import { Vegetation } from './render/Vegetation.js';
import { Vfx } from './render/Vfx.js';
import { WorldView } from './render/WorldView.js';
import { Hud } from './ui/Hud.js';
import { Minimap } from './ui/Minimap.js';

/**
 * Same origin as the page, always. `?server=` stays as an explicit escape hatch
 * for pointing a local client at someone else's server, but nothing here knows
 * a hostname, a port or a scheme, so the page works unchanged on localhost, on
 * a LAN address and behind an https tunnel.
 */
function serverUrl(): string {
  const override = new URLSearchParams(window.location.search).get('server');
  return override ?? resolveServerUrl(window.location);
}

const canvas = document.getElementById('viewport');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing #viewport canvas');

/**
 * A stored preference wins outright. Otherwise start at a conservative tier
 * that will not embarrass the first few seconds on any machine, and let the
 * short benchmark below settle on where this hardware actually belongs.
 */
const storedTier = loadStoredTier();
let benchmarking = storedTier === null;
const renderer = new Renderer(canvas, storedTier ?? QualityTier.Medium);

const hud = new Hud();
const input = new InputSampler(canvas);
let playerView = new PlayerView(renderer.scene, renderer.setupCascadeMaterial);
const tracers = new Tracers(renderer.scene);
const lootView = new LootView(renderer.scene);
const roundView = new RoundView(renderer.scene);
const vfx = new Vfx(renderer.scene);
const minimap = new Minimap();
const audio = new GameAudio();

const client = new GameClient({
  url: serverUrl(),
  name: `player-${Math.floor(Math.random() * 1000)}`,
  input,
  onStatus: (status, detail) => hud.setStatus(status, detail),
});
client.connect();

/**
 * Browsers refuse to start an AudioContext outside a user gesture, so the first
 * click or key press on the page creates it. The same click is the one that
 * captures the mouse, so nothing extra is asked of the player.
 */
function unlockAudio(): void {
  audio.unlock();
  window.removeEventListener('pointerdown', unlockAudio);
  window.removeEventListener('keydown', unlockAudio);
}
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

hud.setVolume(audio.volume);
hud.onVolumeChange = (value) => audio.setVolume(value);

hud.setQualityTier(renderer.qualityTier);
hud.onQualityChange = (tier) => {
  // A manual choice always wins over the one-shot auto-benchmark, including
  // one made while it is still sampling.
  benchmarking = false;
  const id = tier as QualityTierId;
  renderer.setQualityTier(id);
  storeTier(id);
};

let worldView: WorldView | null = null;
let decor: Decor | null = null;
let vegetation: Vegetation | null = null;
let farmDressing: FarmDressing | null = null;
let worldVersion = -1;
/**
 * Bumped whenever the shadow rig is rebuilt with a different cascade count.
 * worldView, decor and playerView all bake CSM's cascade count into their
 * materials at creation, so a stale one after a tier change would light
 * correctly but shadow from the wrong cascade - this is what forces them to
 * be rebuilt alongside a genuine map change.
 */
let materialsVersion = -1;
/**
 * The collision world indexes only the solid boxes, so the same filtered list
 * is kept here to turn a hit index back into the colour of what was hit.
 */
let solidBoxes: readonly { color: number }[] = [];
const hitQuery: number[] = [];
let lastFrameTime = 0;
/** Who the camera follows once the local player is out of the round. */
let spectating = 0;
/** Ticks the local player has held fire on a consumable, for the use bar. */
let useTicks = 0;
const eye = vec3();
const aimVec = vec3();
const pelletVec = vec3();

/**
 * Rolling frame-time readout, split into the game's own work and the draw
 * itself. The split matters: the simulation, interpolation and HUD are what
 * this code controls, while the draw is bounded by whatever GPU is present.
 */
let frameSamples = 0;
let frameTotal = 0;
let cpuTotal = 0;
let drawTotal = 0;
let lastFrameStart = 0;
let perfText = '';

/**
 * Every frame time since the page loaded, capped so a long session cannot grow
 * without bound. The benchmark reads this to compute percentiles - an average
 * hides exactly the hitches that make a game feel bad, so the number that
 * matters is the 1% low.
 */
const frameLog: number[] = [];
/** The CPU half of each frame, which unlike the draw is not GPU-bound. */
const cpuLog: number[] = [];

/**
 * How long the one-shot startup benchmark samples before picking a tier.
 * Long enough to get past the very first frames, whose cost is dominated by
 * shader compilation rather than steady-state rendering.
 */
const BENCHMARK_FRAMES = 90;
let benchmarkFrames = 0;
let benchmarkTotal = 0;

/** Frame-time thresholds a tier must beat, loosest first. */
const TIER_THRESHOLDS_MS: [number, QualityTierId][] = [
  [10, QualityTier.Ultra],
  [16.7, QualityTier.High],
  [22, QualityTier.Medium],
];

function chooseTierFromFrameTime(avgMs: number): QualityTierId {
  for (const [limit, tier] of TIER_THRESHOLDS_MS) {
    if (avgMs < limit) return tier;
  }
  return QualityTier.Low;
}

/** Runs once on a fresh install: a short sample, then a tier that is stored and never re-measured. */
function updateAutoBenchmark(frameMs: number): void {
  if (!benchmarking) return;
  // A backgrounded tab or a hitch during a map load is not the steady state
  // this is trying to measure; a stall would otherwise tank the average and
  // undersell hardware that is actually fine.
  if (frameMs > 250) return;
  benchmarkFrames += 1;
  benchmarkTotal += frameMs;
  if (benchmarkFrames < BENCHMARK_FRAMES) return;

  const chosen = chooseTierFromFrameTime(benchmarkTotal / benchmarkFrames);
  renderer.setQualityTier(chosen);
  storeTier(chosen);
  hud.setQualityTier(chosen);
  benchmarking = false;
}

/** Instances actually placed across every decorative layer, for the perf overlay and the benchmark. */
function totalPropCount(): number {
  return (decor?.propCount ?? 0) + (vegetation?.propCount ?? 0) + (farmDressing?.propCount ?? 0);
}

function samplePerf(now: number, cpuMs: number, drawMs: number): void {
  if (lastFrameStart !== 0) {
    const delta = now - lastFrameStart;
    frameTotal += delta;
    cpuTotal += cpuMs;
    drawTotal += drawMs;
    frameSamples += 1;
    if (frameLog.length < PERF_LOG_MAX) {
      frameLog.push(delta);
      cpuLog.push(cpuMs);
    }
    updateAutoBenchmark(delta);
  }
  lastFrameStart = now;
  if (frameSamples < PERF_SAMPLE_FRAMES) return;
  const frame = frameTotal / frameSamples;
  const quality = renderer.quality;
  perfText =
    `${(1000 / frame).toFixed(0)} fps  ${frame.toFixed(1)} ms/frame\n` +
    `${(cpuTotal / frameSamples).toFixed(2)} ms game  ${(drawTotal / frameSamples).toFixed(2)} ms draw\n` +
    `${renderer.drawCalls} draws  ${(renderer.triangles / 1000).toFixed(0)}k tris\n` +
    `${renderer.textureCount} tex  ${renderer.geometryCount} geo  ${renderer.programCount} prog\n` +
    `tier ${QUALITY_TIER_NAMES[renderer.qualityTier]}  shadows ${quality.shadows ? `${quality.cascades}csm` : 'off'}  props ${totalPropCount()}`;
  frameSamples = 0;
  frameTotal = 0;
  cpuTotal = 0;
  drawTotal = 0;
}

/**
 * The overlay is off by default and toggled with F3: it is a developer readout,
 * not part of the game's presentation, and it costs a DOM write every sample.
 */
let perfVisible = false;
window.addEventListener('keydown', (event) => {
  if (event.code !== 'F3') return;
  event.preventDefault();
  perfVisible = !perfVisible;
  hud.setPerfVisible(perfVisible);
});
hud.setPerfVisible(false);

// Read by tools/bench.mjs. Deliberately the only global this module exposes.
(window as unknown as Record<string, unknown>).__perf = {
  frames: frameLog,
  cpu: cpuLog,
  reset: () => {
    frameLog.length = 0;
    cpuLog.length = 0;
  },
  stats: () => ({
    draws: renderer.drawCalls,
    triangles: renderer.triangles,
    textures: renderer.textureCount,
    geometries: renderer.geometryCount,
    programs: renderer.programCount,
    tier: QUALITY_TIER_NAMES[renderer.qualityTier],
    shadows: renderer.quality.shadows,
    cascades: renderer.quality.cascades,
    props: totalPropCount(),
    players: client.playerCount,
  }),
  /** Sets a tier directly and stops the one-shot auto-benchmark from overriding it. */
  setTier: (tier: QualityTierId) => {
    benchmarking = false;
    renderer.setQualityTier(tier);
  },
  tierNames: QUALITY_TIER_NAMES,
};

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

/**
 * Colour of whatever is at a point, so an impact throws dust that matches the
 * surface. Falls back to the ground colour rather than guessing.
 */
function surfaceColorAt(x: number, y: number, z: number): number {
  if (client.map === null) return COLOR_GROUND;
  const r = 0.15;
  client.map.world.query(x - r, y - r, z - r, x + r, y + r, z + r, hitQuery);
  const first = hitQuery[0];
  if (first === undefined) return COLOR_GROUND;
  return solidBoxes[first]?.color ?? COLOR_GROUND;
}

/** Muzzle flash at the barrel, and an impact wherever each pellet landed. */
function shotEffects(event: GameEvent & { type: typeof EventType.Shot }, now: number): void {
  const weapon = unpackWeapon(event.weapon);
  if (weapon === null || client.map === null) return;
  const stats = weaponStats(weapon.cls);

  // Shotguns flash bigger than SMGs; it is the cheapest way to make weapon
  // class readable from across the map.
  vfx.muzzleFlash(event.x, event.y, event.z, 0.35 + stats.pellets * 0.06, now);

  aimDirection(event.yawQ, event.pitchQ, aimVec);
  const spread = effectiveSpread(stats.spread, event.aiming);
  for (let i = 0; i < stats.pellets; i++) {
    spreadDirection(aimVec, spread, event.shooterId, event.seq, i, pelletVec);
    const distance = raycastWorld(
      client.map.world,
      event.x,
      event.y,
      event.z,
      pelletVec.x,
      pelletVec.y,
      pelletVec.z,
      WEAPON_MAX_RANGE,
    );
    if (distance >= WEAPON_MAX_RANGE) continue;
    const hx = event.x + pelletVec.x * distance;
    const hy = event.y + pelletVec.y * distance;
    const hz = event.z + pelletVec.z * distance;
    vfx.impact(hx, hy, hz, -pelletVec.x, -pelletVec.y, -pelletVec.z, surfaceColorAt(hx, hy, hz), now);
  }
}

function nameOf(id: number): string {
  if (id === 0) return 'the storm';
  return id === client.playerId ? 'you' : `player ${id}`;
}

function handleEvent(event: GameEvent, now: number): void {
  audio.handleEvent(event, client.playerId);
  switch (event.type) {
    case EventType.Shot:
      if (client.map !== null) {
        tracers.add(event, client.map, now);
        shotEffects(event, now);
      }
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

const listenerForward = new THREE.Vector3();
const listenerUp = new THREE.Vector3();

/**
 * Drives the listener from the camera and hands the audio layer the state it
 * needs. Done after the camera has been placed for this frame, so direction is
 * never a frame stale.
 */
function updateAudio(): void {
  renderer.camera.getWorldDirection(listenerForward);
  listenerUp.set(0, 1, 0).applyQuaternion(renderer.camera.quaternion);
  audio.system.setListener(renderer.camera.position, listenerForward, listenerUp);

  const state = client.predictor.state;
  audio.update(
    client.playerId,
    state.pos,
    state.vel.y,
    state.mode,
    (state.flags & StateFlag.OnGround) !== 0,
    client.alive,
    client.remotes,
    client.loot,
    client.round,
  );
}

function frame(): void {
  const now = performance.now();
  client.update(now);

  // Rebuilt on a new map, or when a tier change gives the shadow rig a
  // different cascade count that the existing materials were not compiled
  // against.
  if (
    client.map !== null &&
    (worldVersion !== client.mapVersion || materialsVersion !== renderer.cascadeSetupVersion)
  ) {
    worldView?.dispose(renderer.scene);
    decor?.dispose(renderer.scene);
    vegetation?.dispose(renderer.scene);
    farmDressing?.dispose(renderer.scene);
    playerView.dispose();
    worldView = new WorldView(renderer.scene, client.map, renderer.setupCascadeMaterial, renderer.quality.textureSize);
    decor = new Decor(
      renderer.scene,
      client.map,
      renderer.setupCascadeMaterial,
      renderer.quality.vegetationDensity,
    );
    vegetation = new Vegetation(
      renderer.scene,
      client.map,
      renderer.setupCascadeMaterial,
      renderer.quality.vegetationDensity,
    );
    farmDressing = new FarmDressing(
      renderer.scene,
      client.map,
      renderer.setupCascadeMaterial,
      renderer.quality.vegetationDensity,
    );
    playerView = new PlayerView(renderer.scene, renderer.setupCascadeMaterial);
    solidBoxes = client.map.boxes.filter((b) => b.solid);
    worldVersion = client.mapVersion;
    materialsVersion = renderer.cascadeSetupVersion;
  }

  // Clamped: a backgrounded tab returns with a huge delta that would otherwise
  // fling every live particle across the map in one step.
  const dtSeconds = lastFrameTime === 0 ? 0 : Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;

  for (const event of client.drainEvents()) handleEvent(event, now);

  if (client.ready) {
    updateCamera();
    playerView.update(client.remotes, dtSeconds);

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
    hud.setInStorm(
      client.alive &&
        client.round.phase === RoundPhase.Playing &&
        client.round.stormRadius > 0 &&
        outsideStorm(client.round, state.pos.x, state.pos.z),
    );
    hud.setHint(
      input.locked
        ? null
        : 'click to capture the mouse — WASD move, shift sprint, space jump, R reload, E pick up, 1-5 slots',
    );
  }

  minimap.draw(
    client.map,
    client.mapVersion,
    client.round,
    client.predictor.state.pos.x,
    client.predictor.state.pos.z,
    dequantizeYaw(client.predictor.state.yawQ),
  );
  roundView.update(client.round, now / 1000);
  lootView.update(client.loot, now);
  vegetation?.update(now / 1000);
  renderer.updateShadows();
  updateAudio();
  tracers.update(now);
  tracers.flush();
  vfx.update(now, dtSeconds, renderer.camera);
  hud.update(now, dequantizeYaw(client.predictor.state.yawQ));
  hud.setStats(buildStats());
  const cpuMs = performance.now() - now;
  const drawStart = performance.now();
  renderer.render(now);
  const drawMs = performance.now() - drawStart;

  samplePerf(now, cpuMs, drawMs);
  hud.setPerf(perfText);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
