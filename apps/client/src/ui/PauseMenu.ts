import { MAX_MOUSE_SENSITIVITY, MIN_MOUSE_SENSITIVITY } from '@riftfront/shared';
import type { UserSettings } from '../config.js';
import { el, setText } from './dom.js';

/**
 * Pause / settings overlay. Opening it releases pointer lock; resuming re-acquires it
 * from the click, which satisfies the browser's user-gesture requirement.
 */

export interface PauseCallbacks {
  onResume: () => void;
  onLeaveMatch: () => void;
  onSettingsChanged: (settings: UserSettings) => void;
}

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
  ['Perf panel', 'F3'],
];

export class PauseMenu {
  readonly root: HTMLElement;
  private readonly roomCodeValue: HTMLElement;
  private settings: UserSettings;

  constructor(
    initialSettings: UserSettings,
    private readonly callbacks: PauseCallbacks,
  ) {
    this.settings = { ...initialSettings };

    const sensitivity = this.slider({
      id: 'setting-sensitivity',
      label: 'Mouse sensitivity',
      min: MIN_MOUSE_SENSITIVITY,
      max: MAX_MOUSE_SENSITIVITY,
      step: 0.0001,
      value: this.settings.mouseSensitivity,
      format: (value) => (value / MIN_MOUSE_SENSITIVITY).toFixed(1),
      apply: (value) => {
        this.settings.mouseSensitivity = value;
      },
    });

    const master = this.slider({
      id: 'setting-master',
      label: 'Master volume',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.settings.masterVolume,
      format: (value) => `${Math.round(value * 100)}%`,
      apply: (value) => {
        this.settings.masterVolume = value;
      },
    });

    const effects = this.slider({
      id: 'setting-effects',
      label: 'Effects volume',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.settings.effectsVolume,
      format: (value) => `${Math.round(value * 100)}%`,
      apply: (value) => {
        this.settings.effectsVolume = value;
      },
    });

    const invertToggle = el('input', { id: 'setting-invert', type: 'checkbox' });
    invertToggle.checked = this.settings.invertY;
    invertToggle.addEventListener('change', () => {
      this.settings.invertY = invertToggle.checked;
      this.callbacks.onSettingsChanged({ ...this.settings });
    });

    const perfToggle = el('input', { id: 'setting-perf', type: 'checkbox' });
    perfToggle.checked = this.settings.showPerfPanel;
    perfToggle.addEventListener('change', () => {
      this.settings.showPerfPanel = perfToggle.checked;
      this.callbacks.onSettingsChanged({ ...this.settings });
    });

    const resumeButton = el('button', { class: 'btn primary', type: 'button', text: 'Resume' });
    resumeButton.addEventListener('click', () => this.callbacks.onResume());

    const leaveButton = el('button', { class: 'btn danger', type: 'button', text: 'Leave match' });
    leaveButton.addEventListener('click', () => this.callbacks.onLeaveMatch());

    this.roomCodeValue = el('span', { text: '—' });

    this.root = el('section', { class: 'screen', id: 'pause-screen', hidden: true }, [
      el('div', { class: 'panel' }, [
        el('div', { class: 'brand' }, [
          el('h1', { text: 'Paused' }),
          el('span', { class: 'tag', text: 'Project Riftfront' }),
        ]),
        el('p', { class: 'lede' }, [
          document.createTextNode('Room code: '),
          this.roomCodeValue,
          document.createTextNode(' — share it to let someone join this match.'),
        ]),

        sensitivity,
        master,
        effects,

        el('div', { class: 'setting' }, [
          el('label', { for: 'setting-invert', text: 'Invert vertical look' }),
          invertToggle,
        ]),
        el('div', { class: 'setting' }, [
          el('label', { for: 'setting-perf', text: 'Show performance panel (F3)' }),
          perfToggle,
        ]),

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

        el('div', { class: 'actions', style: 'margin-top:20px' }, [resumeButton, leaveButton]),
      ]),
    ]);
  }

  private slider(config: {
    id: string;
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    format: (value: number) => string;
    apply: (value: number) => void;
  }): HTMLElement {
    const input = el('input', {
      id: config.id,
      type: 'range',
      min: config.min,
      max: config.max,
      step: config.step,
    });
    input.value = String(config.value);

    const readout = el('span', { class: 'value', text: config.format(config.value) });

    input.addEventListener('input', () => {
      const value = Number.parseFloat(input.value);
      if (!Number.isFinite(value)) return;
      config.apply(value);
      setText(readout, config.format(value));
      this.callbacks.onSettingsChanged({ ...this.settings });
    });

    return el('div', { class: 'setting' }, [
      el('label', { for: config.id, text: config.label }),
      el('div', { class: 'setting-row' }, [input, readout]),
    ]);
  }

  setRoomCode(code: string): void {
    setText(this.roomCodeValue, code);
  }

  show(): void {
    this.root.hidden = false;
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
