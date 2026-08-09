import './style.css';
import {
  DEFAULT_PORT,
  EventType,
  PLAYER_EYE_HEIGHT,
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

const client = new GameClient({
  url: resolveServerUrl(),
  name: `player-${Math.floor(Math.random() * 1000)}`,
  input,
  onStatus: (status, detail) => hud.setStatus(status, detail),
});
client.connect();

let worldView: WorldView | null = null;
/** Who the camera follows once the local player is out of the round. */
let spectating = 0;
const eye = vec3();

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

/** Places the camera: first person while alive, chase cam once eliminated. */
function updateCamera(): void {
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
    `map      ${client.mapHashMatches ? 'ok' : 'MISMATCH'}`,
  ];
}

function frame(): void {
  const now = performance.now();
  client.update(now);

  if (worldView === null && client.map !== null) {
    worldView = new WorldView(renderer.scene, client.map);
  }

  for (const event of client.drainEvents()) handleEvent(event, now);

  if (client.ready) {
    updateCamera();
    playerView.update(client.remotes);

    const state = client.predictor.state;
    const weapon = unpackWeapon(state.weapon);
    hud.setVitals(state.health, state.shield);
    hud.setWeapon(state.weapon, state.ammo, weapon === null ? 0 : weaponStats(weapon.cls).magazine, state.reload);
    hud.setCrosshairVisible(client.alive && input.locked);
    hud.setBanner(
      client.alive ? null : 'eliminated',
      client.alive ? '' : `spectating ${nameOf(spectating)} · ${client.playerCount - 1} still in`,
    );
    hud.setHint(input.locked ? null : 'click to capture the mouse — WASD move, shift sprint, space jump, R reload');
  }

  tracers.update(now);
  tracers.flush();
  hud.update(now, dequantizeYaw(client.predictor.state.yawQ));
  hud.setStats(buildStats());
  renderer.render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
