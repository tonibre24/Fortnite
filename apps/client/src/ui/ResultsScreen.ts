import type { MatchEndedPayload, MatchResultEntry } from '@riftfront/shared';
import { el, setText } from './dom.js';

/**
 * Post-match results: winner, final scoreboard, the local player's own statistics and
 * the option to play again (the server restarts automatically) or leave.
 */

export interface ResultsCallbacks {
  onPlayAgain: () => void;
  onReturnToMenu: () => void;
}

export class ResultsScreen {
  readonly root: HTMLElement;
  private readonly winnerName: HTMLElement;
  private readonly winnerLabel: HTMLElement;
  private readonly statsGrid: HTMLElement;
  private readonly tbody: HTMLTableSectionElement;
  private readonly restartNote: HTMLElement;
  private readonly playAgainButton: HTMLButtonElement;

  constructor(
    private readonly sessionIdProvider: () => string,
    callbacks: ResultsCallbacks,
  ) {
    this.winnerLabel = el('div', { class: 'label', text: 'Winner' });
    this.winnerName = el('div', { class: 'name', text: '—' });
    this.statsGrid = el('div', { class: 'results-stats' });
    this.tbody = el('tbody');
    this.restartNote = el('div', { class: 'restart-note', text: '' });

    this.playAgainButton = el('button', {
      class: 'btn primary',
      type: 'button',
      text: 'Play again',
    });
    const menuButton = el('button', { class: 'btn', type: 'button', text: 'Return to menu' });

    this.playAgainButton.addEventListener('click', () => callbacks.onPlayAgain());
    menuButton.addEventListener('click', () => callbacks.onReturnToMenu());

    this.root = el('section', { class: 'screen', id: 'results-screen', hidden: true }, [
      el('div', { class: 'panel' }, [
        el('div', { class: 'results-winner' }, [this.winnerLabel, this.winnerName]),
        this.statsGrid,
        el('table', { class: 'scores' }, [
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
        ]),
        this.restartNote,
        el('div', { class: 'actions', style: 'justify-content:center;margin-top:18px' }, [
          this.playAgainButton,
          menuButton,
        ]),
      ]),
    ]);
  }

  show(payload: MatchEndedPayload): void {
    const sessionId = this.sessionIdProvider();
    const isWinner = payload.winnerId !== null && payload.winnerId === sessionId;

    setText(this.winnerLabel, isWinner ? 'Victory' : 'Winner');
    setText(this.winnerName, payload.winnerName ?? 'No one');

    const reason =
      payload.reason === 'scoreLimit'
        ? 'Elimination limit reached'
        : payload.reason === 'abandoned'
          ? 'Match abandoned'
          : 'Time limit reached';
    setText(
      this.restartNote,
      `${reason}. A new match starts automatically in about ${Math.round(payload.restartInMs / 1000)} seconds.`,
    );

    this.renderPersonalStats(payload.scoreboard, sessionId);
    this.renderScoreboard(payload.scoreboard, sessionId);

    this.root.hidden = false;
  }

  private renderPersonalStats(scoreboard: MatchResultEntry[], sessionId: string): void {
    const own = scoreboard.find((entry) => entry.id === sessionId);
    const stats: [string, string][] = own
      ? [
          ['Placement', `#${own.placement}`],
          ['Eliminations', String(own.kills)],
          ['Deaths', String(own.deaths)],
          ['Damage', String(Math.round(own.damageDealt))],
          ['K/D', own.deaths === 0 ? String(own.kills) : (own.kills / own.deaths).toFixed(2)],
        ]
      : [['Result', 'Spectator']];

    this.statsGrid.replaceChildren(
      ...stats.map(([label, value]) =>
        el('div', { class: 'stat' }, [
          el('div', { class: 'value', text: value }),
          el('div', { class: 'label', text: label }),
        ]),
      ),
    );
  }

  private renderScoreboard(scoreboard: MatchResultEntry[], sessionId: string): void {
    this.tbody.replaceChildren(
      ...scoreboard.map((entry) => {
        const row = el('tr', {}, [
          el('td', { text: String(entry.placement) }),
          el('td', { text: entry.displayName }),
          el('td', { text: String(entry.kills) }),
          el('td', { text: String(entry.deaths) }),
          el('td', { text: String(Math.round(entry.damageDealt)) }),
          el('td', { text: String(entry.ping) }),
        ]);
        if (entry.id === sessionId) row.classList.add('self');
        return row;
      }),
    );
  }

  hide(): void {
    this.root.hidden = true;
  }

  get isVisible(): boolean {
    return !this.root.hidden;
  }

  dispose(): void {
    this.root.remove();
  }
}
