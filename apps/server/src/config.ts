import {
  MATCH_COUNTDOWN_MS,
  MATCH_DURATION_MS,
  MATCH_MAX_PLAYERS,
  MATCH_MIN_PLAYERS,
  MATCH_RESULTS_MS,
  MATCH_SCORE_LIMIT,
  RESPAWN_DELAY_MS,
  type MatchRules,
} from '@riftfront/shared';

/**
 * Environment-driven server configuration.
 *
 * Every value has a working default so `pnpm dev` needs no .env file; production
 * deployments override through the environment (see .env.example).
 */

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[config] ${name}="${raw}" is not an integer; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export interface ServerConfig {
  port: number;
  host: string;
  /** Allowed browser origins; `['*']` disables the check (development default). */
  allowedOrigins: string[];
  /** Exposes the Colyseus monitor at /colyseus. Off by default. */
  enableMonitor: boolean;
  matchRules: MatchRules;
  /** Log every rejected message. Noisy but useful while tuning validation. */
  verboseValidation: boolean;
}

export function loadConfig(): ServerConfig {
  const rules: MatchRules = {
    minPlayers: Math.max(1, readInt('RIFTFRONT_MIN_PLAYERS', MATCH_MIN_PLAYERS)),
    maxPlayers: Math.max(2, readInt('RIFTFRONT_MAX_PLAYERS', MATCH_MAX_PLAYERS)),
    countdownMs: Math.max(0, readInt('RIFTFRONT_COUNTDOWN_MS', MATCH_COUNTDOWN_MS)),
    durationMs: Math.max(10_000, readInt('RIFTFRONT_MATCH_DURATION_MS', MATCH_DURATION_MS)),
    scoreLimit: Math.max(0, readInt('RIFTFRONT_SCORE_LIMIT', MATCH_SCORE_LIMIT)),
    respawnDelayMs: Math.max(0, readInt('RIFTFRONT_RESPAWN_DELAY_MS', RESPAWN_DELAY_MS)),
    resultsMs: Math.max(1000, readInt('RIFTFRONT_RESULTS_MS', MATCH_RESULTS_MS)),
  };

  // An empty HOST must fall back to the default, so this cannot use `??`.
  const host = process.env.HOST?.trim();

  return {
    port: readInt('PORT', 2567),
    host: host !== undefined && host.length > 0 ? host : '0.0.0.0',
    allowedOrigins: readList('RIFTFRONT_ALLOWED_ORIGINS', ['*']),
    enableMonitor: readBool('RIFTFRONT_ENABLE_MONITOR', false),
    matchRules: rules,
    verboseValidation: readBool('RIFTFRONT_VERBOSE_VALIDATION', false),
  };
}
