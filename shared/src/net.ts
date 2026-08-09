/**
 * How the client finds the server.
 *
 * There is exactly one answer: wherever this page came from. That is what makes
 * the game shareable behind a tunnel or any other reverse proxy - the origin is
 * whatever the browser already trusted enough to load the page, so there is
 * nothing to configure and nothing to get out of sync.
 */

/** Path the WebSocket lives on, so it can share a port with the static files. */
export const WS_PATH = '/ws';

/** The parts of `window.location` this needs, so it is testable without a DOM. */
export interface OriginLike {
  /** Includes the trailing colon, as `window.location.protocol` does. */
  protocol: string;
  /** Host and port, as `window.location.host` does. */
  host: string;
}

/**
 * The WebSocket URL for the origin serving this page.
 *
 * Secure pages must use `wss:` - browsers block plaintext WebSockets from an
 * https page, which is exactly the case a tunnel produces - and `host` already
 * carries the port when there is a non-default one, so neither the scheme nor
 * the port is ever written down anywhere.
 */
export function resolveServerUrl(origin: OriginLike, path: string = WS_PATH): string {
  const scheme = origin.protocol === 'https:' || origin.protocol === 'wss:' ? 'wss' : 'ws';
  return `${scheme}://${origin.host}${path}`;
}
