import type { ConnectionStatus } from '../net/Connection.js';

/** Minimal always-on text overlay: connection state plus a few live counters. */
export class Hud {
  private readonly statusEl: HTMLElement;
  private readonly statsEl: HTMLElement;

  constructor() {
    this.statusEl = mustFind('status');
    this.statsEl = mustFind('stats');
  }

  setStatus(status: ConnectionStatus, detail: string): void {
    this.statusEl.className = status;
    this.statusEl.textContent = detail ? `${status} — ${detail}` : status;
  }

  setStats(lines: string[]): void {
    this.statsEl.textContent = lines.join('\n');
  }
}

function mustFind(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id} in index.html`);
  return el;
}
