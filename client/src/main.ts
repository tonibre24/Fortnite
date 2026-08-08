import './style.css';
import {
  DEFAULT_PORT,
  PLAYER_EYE_HEIGHT,
  dequantizePitch,
  dequantizeYaw,
  vec3,
} from '@br/shared';
import { GameClient } from './game/GameClient.js';
import { InputSampler } from './input/InputSampler.js';
import { PlayerView } from './render/PlayerView.js';
import { Renderer } from './render/Renderer.js';
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

const client = new GameClient({
  url: resolveServerUrl(),
  name: `player-${Math.floor(Math.random() * 1000)}`,
  input,
  onStatus: (status, detail) => hud.setStatus(status, detail),
});
client.connect();

let worldView: WorldView | null = null;
const eye = vec3();

function frame(): void {
  const now = performance.now();
  client.update(now);

  if (worldView === null && client.map !== null) {
    worldView = new WorldView(renderer.scene, client.map);
  }

  if (client.ready) {
    client.predictor.renderPosition(client.alpha, eye);
    renderer.camera.position.set(eye.x, eye.y + PLAYER_EYE_HEIGHT, eye.z);
    renderer.camera.rotation.set(
      dequantizePitch(client.predictor.state.pitchQ),
      dequantizeYaw(client.predictor.state.yawQ),
      0,
    );
    playerView.update(client.remotes);
  }

  hud.setStats(buildStats());
  renderer.render();
  requestAnimationFrame(frame);
}

function buildStats(): string[] {
  const p = client.predictor;
  return [
    `id       ${client.playerId || '-'}`,
    `ping     ${client.connection.rttMs.toFixed(0)} ms`,
    `players  ${client.remotes.size + (client.ready ? 1 : 0)}`,
    `pos      ${p.state.pos.x.toFixed(1)} ${p.state.pos.y.toFixed(1)} ${p.state.pos.z.toFixed(1)}`,
    `pred err ${p.lastError.toFixed(4)} (max ${p.maxError.toFixed(3)})`,
    `unacked  ${p.pending.length}`,
    `snaps    ${client.snapshotsReceived}`,
    `map      ${client.mapHashMatches ? 'ok' : 'MISMATCH'}`,
    input.locked ? '' : 'click to capture mouse — WASD, shift, space',
  ];
}

requestAnimationFrame(frame);
