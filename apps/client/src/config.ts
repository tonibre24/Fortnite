/**
 * Client configuration.
 *
 * Nothing secret belongs here: everything in this file ships inside the browser bundle.
 * The server endpoint is the only deployment-specific value, and it is public by nature.
 */

interface ViteEnv {
  readonly VITE_SERVER_URL?: string;
  readonly DEV?: boolean;
  readonly MODE?: string;
}

const env = import.meta.env as unknown as ViteEnv;

/**
 * Resolves the game server's HTTP origin.
 *
 * In development, Vite proxies `/api` and `/matchmake` to the server, so the page's own
 * origin works. In production the origin is baked in via `VITE_SERVER_URL`, falling back
 * to the origin serving the page (the usual single-host deployment).
 */
export function resolveServerUrl(): string {
  const configured = env.VITE_SERVER_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return window.location.origin;
}

export const isDevBuild = (): boolean => env.DEV === true;

export interface UserSettings {
  displayName: string;
  mouseSensitivity: number;
  masterVolume: number;
  effectsVolume: number;
  invertY: boolean;
  showPerfPanel: boolean;
}

const SETTINGS_KEY = 'riftfront.settings.v1';

import {
  DEFAULT_MOUSE_SENSITIVITY,
  MAX_MOUSE_SENSITIVITY,
  MIN_MOUSE_SENSITIVITY,
  clamp,
  sanitizeDisplayName,
} from '@riftfront/shared';

export const defaultSettings = (): UserSettings => ({
  displayName: '',
  mouseSensitivity: DEFAULT_MOUSE_SENSITIVITY,
  masterVolume: 0.7,
  effectsVolume: 0.8,
  invertY: false,
  showPerfPanel: isDevBuild(),
});

/** Reads settings from localStorage, tolerating corrupt or absent data. */
export function loadSettings(): UserSettings {
  const fallback = defaultSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as Record<string, unknown>;

    return {
      displayName:
        typeof record.displayName === 'string' && record.displayName.trim().length > 0
          ? sanitizeDisplayName(record.displayName)
          : '',
      mouseSensitivity: clampSensitivity(record.mouseSensitivity, fallback.mouseSensitivity),
      masterVolume: clampUnit(record.masterVolume, fallback.masterVolume),
      effectsVolume: clampUnit(record.effectsVolume, fallback.effectsVolume),
      invertY: record.invertY === true,
      showPerfPanel:
        typeof record.showPerfPanel === 'boolean' ? record.showPerfPanel : fallback.showPerfPanel,
    };
  } catch (error) {
    console.warn('[settings] could not read stored settings, using defaults', error);
    return fallback;
  }
}

export function saveSettings(settings: UserSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    // Private browsing or a full quota: the game still works, settings just do not persist.
    console.warn('[settings] could not persist settings', error);
  }
}

function clampSensitivity(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(value, MIN_MOUSE_SENSITIVITY, MAX_MOUSE_SENSITIVITY);
}

function clampUnit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(value, 0, 1);
}
