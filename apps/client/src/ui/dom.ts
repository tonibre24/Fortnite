/**
 * Tiny DOM helpers.
 *
 * All UI text is inserted via `textContent`, never `innerHTML`, so a display name coming
 * from another player can never be interpreted as markup. The server sanitises names as
 * well; this is the second layer.
 */

export type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

export const setText = (node: HTMLElement, text: string): void => {
  if (node.textContent !== text) node.textContent = text;
};

export const setHidden = (node: HTMLElement, hidden: boolean): void => {
  if (node.hidden !== hidden) node.hidden = hidden;
};

export const setClass = (node: HTMLElement, className: string, on: boolean): void => {
  node.classList.toggle(className, on);
};

/** Formats milliseconds as `M:SS`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
