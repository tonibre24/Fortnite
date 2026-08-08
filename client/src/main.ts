import './style.css';
import { DEFAULT_PORT } from '@br/shared';
import { Connection } from './net/Connection.js';
import { Renderer } from './render/Renderer.js';
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

const connection = new Connection({
  url: resolveServerUrl(),
  name: `player-${Math.floor(Math.random() * 1000)}`,
  handlers: {
    onStatus: (status, detail) => hud.setStatus(status, detail),
  },
});
connection.connect();

function frame(): void {
  hud.setStats([
    `id     ${connection.playerId || '-'}`,
    `ping   ${connection.rttMs.toFixed(0)} ms`,
    `tick   ${connection.serverTick}`,
    `seed   ${connection.mapSeed}`,
  ]);
  renderer.render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
