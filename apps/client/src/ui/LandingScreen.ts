import { MAX_DISPLAY_NAME_LENGTH, ROOM_CODE_LENGTH, sanitizeDisplayName } from '@riftfront/shared';
import { el, setText } from './dom.js';

/**
 * Landing screen: display name, create/join room, controls reference and a live
 * connection status line.
 */

export interface LandingCallbacks {
  onCreate: (displayName: string) => void;
  onJoin: (displayName: string, code: string) => void;
}

export type StatusTone = 'idle' | 'ok' | 'busy' | 'error';

const CONTROLS: [string, string][] = [
  ['Move', 'W A S D'],
  ['Look', 'Mouse'],
  ['Fire', 'Left click'],
  ['Aim', 'Right click'],
  ['Reload', 'R'],
  ['Sprint', 'Shift'],
  ['Jump', 'Space'],
  ['Scoreboard', 'Tab'],
  ['Weapons', '1 / 2'],
  ['Menu', 'Esc'],
];

export class LandingScreen {
  readonly root: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly createButton: HTMLButtonElement;
  private readonly joinButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly statusText: HTMLElement;
  private busy = false;

  constructor(private readonly callbacks: LandingCallbacks) {
    this.nameInput = el('input', {
      id: 'display-name',
      type: 'text',
      maxlength: MAX_DISPLAY_NAME_LENGTH,
      placeholder: 'Recruit',
      autocomplete: 'off',
      spellcheck: 'false',
    });

    this.codeInput = el('input', {
      id: 'room-code',
      class: 'code',
      type: 'text',
      maxlength: ROOM_CODE_LENGTH,
      placeholder: 'ABCDE',
      autocomplete: 'off',
      spellcheck: 'false',
    });

    this.createButton = el('button', {
      class: 'btn primary',
      type: 'button',
      text: 'Create match',
    });
    this.joinButton = el('button', { class: 'btn', type: 'button', text: 'Join match' });

    this.statusText = el('span', { text: 'Enter a name to begin.' });
    this.status = el('div', { class: 'status', 'data-tone': 'idle' }, [
      el('i', { class: 'dot' }),
      this.statusText,
    ]);

    this.root = el('section', { class: 'screen', id: 'landing-screen' }, [
      el('div', { class: 'panel' }, [
        el('div', { class: 'brand' }, [
          el('h1', { text: 'Project Riftfront' }),
          el('span', { class: 'tag', text: 'Vertical slice' }),
        ]),
        el('p', {
          class: 'lede',
          text: 'A browser-based multiplayer third-person shooter. Create a match and share the room code, or join a friend. Two to eight players, five-minute free-for-all deathmatch.',
        }),

        el('div', { class: 'form-grid' }, [
          el('div', { class: 'field' }, [
            el('label', { for: 'display-name', text: 'Display name' }),
            this.nameInput,
          ]),
          el('div', { class: 'field' }, [
            el('label', { for: 'room-code', text: 'Room code (to join)' }),
            this.codeInput,
          ]),
        ]),

        el('div', { class: 'actions' }, [this.createButton, this.joinButton]),
        this.status,

        el('div', { class: 'controls-table' }, [
          el('h2', { text: 'Controls' }),
          el(
            'div',
            { class: 'controls-list' },
            CONTROLS.map(([action, key]) =>
              el('div', {}, [el('span', { text: action }), el('kbd', { text: key })]),
            ),
          ),
        ]),
      ]),
    ]);

    this.wire();
  }

  private wire(): void {
    this.createButton.addEventListener('click', () => {
      if (this.busy) return;
      this.callbacks.onCreate(this.displayName);
    });

    this.joinButton.addEventListener('click', () => {
      if (this.busy) return;
      this.submitJoin();
    });

    this.codeInput.addEventListener('input', () => {
      // Room codes are uppercase and alphanumeric; normalise as the player types.
      const cleaned = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleaned !== this.codeInput.value) this.codeInput.value = cleaned;
    });

    this.codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !this.busy) this.submitJoin();
    });

    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || this.busy) return;
      if (this.codeInput.value.length === ROOM_CODE_LENGTH) this.submitJoin();
      else this.callbacks.onCreate(this.displayName);
    });
  }

  private submitJoin(): void {
    const code = this.codeInput.value.trim();
    if (code.length !== ROOM_CODE_LENGTH) {
      this.setStatus(`Room codes are ${ROOM_CODE_LENGTH} characters.`, 'error');
      this.codeInput.focus();
      return;
    }
    this.callbacks.onJoin(this.displayName, code);
  }

  get displayName(): string {
    return sanitizeDisplayName(this.nameInput.value);
  }

  setDisplayName(name: string): void {
    this.nameInput.value = name;
  }

  prefillRoomCode(code: string): void {
    this.codeInput.value = code;
  }

  setStatus(message: string, tone: StatusTone): void {
    setText(this.statusText, message);
    this.status.dataset.tone = tone;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.createButton.disabled = busy;
    this.joinButton.disabled = busy;
    this.nameInput.disabled = busy;
    this.codeInput.disabled = busy;
  }

  show(): void {
    this.root.hidden = false;
    this.nameInput.focus();
  }

  hide(): void {
    this.root.hidden = true;
  }

  dispose(): void {
    this.root.remove();
  }
}
