import './styles.css';
import { GameApp } from './core/GameApp.js';
import { Notifications } from './ui/Notifications.js';

/**
 * Entry point.
 *
 * Fails loudly and usefully: if WebGL is missing or the renderer cannot start, the player
 * gets an explanation instead of a black canvas. Unhandled errors are logged with detail
 * but reported to the player in plain language.
 */

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const context =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');
    return context !== null;
  } catch {
    return false;
  }
}

function boot(): void {
  const canvas = document.getElementById('render-canvas');
  const uiRoot = document.getElementById('ui-root');

  if (!(canvas instanceof HTMLCanvasElement) || !(uiRoot instanceof HTMLElement)) {
    console.error('[boot] required DOM nodes are missing');
    document.body.textContent = 'Project Riftfront could not start: the page is malformed.';
    return;
  }

  if (!hasWebGL()) {
    const notifications = new Notifications();
    uiRoot.append(notifications.root);
    notifications.showFatal(
      uiRoot,
      'WebGL is not available',
      'Project Riftfront needs WebGL to render its 3D arena. Enable hardware acceleration in your browser settings, update your graphics drivers, or try a different browser.',
    );
    return;
  }

  const app = new GameApp(canvas, uiRoot);
  const started = app.start();

  if (!started) {
    const notifications = new Notifications();
    uiRoot.append(notifications.root);
    notifications.showFatal(
      uiRoot,
      'The renderer could not start',
      'Your browser reported WebGL support but the 3D engine failed to initialise. This usually means hardware acceleration is disabled.',
      'Reload',
    );
    return;
  }

  window.addEventListener('error', (event) => {
    console.error('[uncaught]', event.error ?? event.message);
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[unhandled rejection]', event.reason);
  });

  // Vite's HMR replaces this module during development; dispose so a hot reload does not
  // leave a second render loop, WebSocket and input listener set behind.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      void app.dispose();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
