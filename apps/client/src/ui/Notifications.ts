import { el } from './dom.js';

/**
 * Transient toasts plus the fatal-error screen.
 *
 * Player-facing copy is deliberately plain and actionable; technical detail goes to the
 * console so it is available for debugging without leaking internals into the UI.
 */

export type ToastTone = 'info' | 'warning' | 'error';

interface ActiveToast {
  node: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_TOASTS = 4;

export class Notifications {
  readonly root: HTMLElement;
  private readonly toasts: ActiveToast[] = [];
  private fatalScreen: HTMLElement | null = null;

  constructor() {
    this.root = el('div', { class: 'toasts' });
  }

  show(message: string, tone: ToastTone = 'info', durationMs = 3200): void {
    const node = el('div', { class: `toast ${tone}`, text: message });
    this.root.append(node);

    const entry: ActiveToast = {
      node,
      timer: setTimeout(() => this.remove(entry), durationMs),
    };
    this.toasts.push(entry);

    while (this.toasts.length > MAX_TOASTS) {
      const oldest = this.toasts.shift();
      if (oldest) {
        clearTimeout(oldest.timer);
        oldest.node.remove();
      }
    }
  }

  private remove(entry: ActiveToast): void {
    clearTimeout(entry.timer);
    entry.node.remove();
    const index = this.toasts.indexOf(entry);
    if (index >= 0) this.toasts.splice(index, 1);
  }

  clear(): void {
    for (const entry of this.toasts) {
      clearTimeout(entry.timer);
      entry.node.remove();
    }
    this.toasts.length = 0;
  }

  /**
   * Replaces the whole UI with an unrecoverable-error screen.
   * Used for WebGL failures and other conditions the player cannot play through.
   */
  showFatal(container: HTMLElement, title: string, detail: string, retryLabel?: string): void {
    this.dismissFatal();

    const children: (HTMLElement | Text)[] = [
      el('h2', { text: title }),
      el('p', { class: 'lede', text: detail }),
    ];

    if (retryLabel) {
      const button = el('button', { class: 'btn primary', type: 'button', text: retryLabel });
      button.addEventListener('click', () => window.location.reload());
      children.push(el('div', { class: 'actions', style: 'justify-content:center' }, [button]));
    }

    this.fatalScreen = el('div', { class: 'fatal' }, [el('div', { class: 'panel' }, children)]);
    container.append(this.fatalScreen);
  }

  dismissFatal(): void {
    this.fatalScreen?.remove();
    this.fatalScreen = null;
  }

  dispose(): void {
    this.clear();
    this.dismissFatal();
    this.root.remove();
  }
}
