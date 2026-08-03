import { rankScoreboard, type PlayerView } from '@riftfront/shared';
import { el, setHidden, setText } from './dom.js';

/**
 * Tab scoreboard. Rows are reused between refreshes rather than rebuilt, so holding Tab
 * during a firefight does not churn the DOM.
 */

interface Row {
  tr: HTMLTableRowElement;
  place: HTMLTableCellElement;
  name: HTMLTableCellElement;
  kills: HTMLTableCellElement;
  deaths: HTMLTableCellElement;
  damage: HTMLTableCellElement;
  ping: HTMLTableCellElement;
}

export class Scoreboard {
  readonly root: HTMLElement;
  private readonly tbody: HTMLTableSectionElement;
  private readonly subtitle: HTMLElement;
  private readonly rows: Row[] = [];

  constructor(private readonly sessionIdProvider: () => string) {
    this.tbody = el('tbody');
    this.subtitle = el('div', { class: 'sub', text: '' });

    const table = el('table', { class: 'scores' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: '#' }),
          el('th', { text: 'Player' }),
          el('th', { text: 'Elims' }),
          el('th', { text: 'Deaths' }),
          el('th', { text: 'Damage' }),
          el('th', { text: 'Ping' }),
        ]),
      ]),
      this.tbody,
    ]);

    this.root = el('div', { class: 'scoreboard', hidden: true }, [
      el('h2', { text: 'Scoreboard' }),
      this.subtitle,
      table,
    ]);
  }

  setVisible(visible: boolean): void {
    setHidden(this.root, !visible);
  }

  get isVisible(): boolean {
    return !this.root.hidden;
  }

  /** Rebuilds the ranking from replicated player state. */
  update(players: readonly PlayerView[], context: { roomCode: string; phase: string }): void {
    const ranked = rankScoreboard(
      players.map((player) => ({
        id: player.id,
        displayName: player.displayName,
        kills: player.kills,
        deaths: player.deaths,
        damageDealt: player.damageDealt,
        ping: player.ping,
        alive: player.alive,
      })),
    );

    setText(
      this.subtitle,
      `Room ${context.roomCode} · ${context.phase.toLowerCase()} · ${ranked.length} connected`,
    );

    while (this.rows.length < ranked.length) this.addRow();
    while (this.rows.length > ranked.length) {
      const removed = this.rows.pop();
      removed?.tr.remove();
    }

    const sessionId = this.sessionIdProvider();
    ranked.forEach((entry, index) => {
      const row = this.rows[index];
      setText(row.place, String(index + 1));
      setText(row.name, entry.displayName);
      setText(row.kills, String(entry.kills));
      setText(row.deaths, String(entry.deaths));
      setText(row.damage, String(Math.round(entry.damageDealt)));
      setText(row.ping, `${entry.ping}`);
      row.tr.classList.toggle('self', entry.id === sessionId);
      row.tr.classList.toggle('dead', !entry.alive);
    });
  }

  private addRow(): void {
    const place = el('td');
    const name = el('td');
    const kills = el('td');
    const deaths = el('td');
    const damage = el('td');
    const ping = el('td');
    const tr = el('tr', {}, [place, name, kills, deaths, damage, ping]);
    this.tbody.append(tr);
    this.rows.push({ tr, place, name, kills, deaths, damage, ping });
  }

  dispose(): void {
    this.rows.length = 0;
    this.root.remove();
  }
}
