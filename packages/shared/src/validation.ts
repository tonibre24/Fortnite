import {
  MAX_COMMANDS_PER_BATCH,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
  ROOM_CODE_LENGTH,
} from './constants.js';
import { isFiniteVec3, type Vec3 } from './math.js';
import { clampPitch, type InputCommand } from './movement.js';
import type {
  FirePayload,
  InputBatchPayload,
  PingPayload,
  SwitchWeaponPayload,
} from './protocol.js';
import { isWeaponId } from './weapons.js';

/**
 * Runtime validation for everything that arrives from a client.
 *
 * TypeScript types vanish at runtime, so every inbound payload is re-checked here
 * before it reaches simulation code. Validators return a normalised value rather
 * than merely a boolean, which prevents "validated then used the raw object" bugs.
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function parseVec3(value: unknown): Vec3 | null {
  if (!isRecord(value)) return null;
  const { x, y, z } = value;
  if (!finiteNumber(x) || !finiteNumber(y) || !finiteNumber(z)) return null;
  const vec = { x, y, z };
  return isFiniteVec3(vec) ? vec : null;
}

/**
 * Strips control characters and markup-significant characters, collapses whitespace
 * and enforces the length limit. Returns a safe fallback for unusable input so a
 * hostile name can never produce an empty or injected label.
 */
export function sanitizeDisplayName(raw: unknown, fallback = 'Recruit'): string {
  if (typeof raw !== 'string') return fallback;

  const cleaned = raw
    // C0/C1 control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // Zero-width, bidi override and byte-order marks: invisible-name spoofing.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    // Characters that would need escaping wherever the name is rendered.
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < MIN_DISPLAY_NAME_LENGTH) return fallback;
  return cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Room codes avoid visually ambiguous characters (no O/0, I/1). */
export function generateRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const char of code) {
    if (!ROOM_CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}

export function validateInputCommand(value: unknown): ValidationResult<InputCommand> {
  if (!isRecord(value)) return fail('command must be an object');
  const { seq, moveX, moveZ, yaw, pitch, buttons } = value;

  if (!finiteNumber(seq) || seq < 0 || !Number.isInteger(seq)) {
    return fail('command.seq must be a non-negative integer');
  }
  if (!finiteNumber(moveX) || !finiteNumber(moveZ)) {
    return fail('command move axes must be finite numbers');
  }
  if (!finiteNumber(yaw) || !finiteNumber(pitch)) {
    return fail('command angles must be finite numbers');
  }
  if (!finiteNumber(buttons) || !Number.isInteger(buttons) || buttons < 0 || buttons > 0xff) {
    return fail('command.buttons must be a small non-negative integer');
  }

  return ok({
    seq,
    // Clamping instead of rejecting keeps honest clients with rounding noise playable
    // while making out-of-range values useless to an attacker.
    moveX: Math.max(-1, Math.min(1, moveX)),
    moveZ: Math.max(-1, Math.min(1, moveZ)),
    yaw: normalizeYaw(yaw),
    pitch: clampPitch(pitch),
    buttons,
  });
}

function normalizeYaw(yaw: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = yaw % twoPi;
  return wrapped > Math.PI ? wrapped - twoPi : wrapped < -Math.PI ? wrapped + twoPi : wrapped;
}

export function validateInputBatch(value: unknown): ValidationResult<InputBatchPayload> {
  if (!isRecord(value)) return fail('input payload must be an object');
  const { commands, clientTimeMs } = value;

  if (!Array.isArray(commands) || commands.length === 0) {
    return fail('input.commands must be a non-empty array');
  }
  if (commands.length > MAX_COMMANDS_PER_BATCH) {
    return fail(`input.commands exceeds ${MAX_COMMANDS_PER_BATCH} entries`);
  }
  if (!finiteNumber(clientTimeMs) || clientTimeMs < 0) {
    return fail('input.clientTimeMs must be a non-negative number');
  }

  const parsed: InputCommand[] = [];
  for (const raw of commands) {
    const result = validateInputCommand(raw);
    if (!result.ok) return result;
    parsed.push(result.value);
  }

  return ok({ commands: parsed, clientTimeMs });
}

export function validateFire(value: unknown): ValidationResult<FirePayload> {
  if (!isRecord(value)) return fail('fire payload must be an object');
  const { shotSeq, direction, inputSeq, aiming, clientTimeMs } = value;

  if (!finiteNumber(shotSeq) || !Number.isInteger(shotSeq) || shotSeq < 0) {
    return fail('fire.shotSeq must be a non-negative integer');
  }
  if (!finiteNumber(inputSeq) || !Number.isInteger(inputSeq) || inputSeq < 0) {
    return fail('fire.inputSeq must be a non-negative integer');
  }
  if (typeof aiming !== 'boolean') return fail('fire.aiming must be a boolean');
  if (!finiteNumber(clientTimeMs) || clientTimeMs < 0) {
    return fail('fire.clientTimeMs must be a non-negative number');
  }

  const dir = parseVec3(direction);
  if (!dir) return fail('fire.direction must be a finite vector');
  const length = Math.hypot(dir.x, dir.y, dir.z);
  if (length < 1e-4) return fail('fire.direction must be non-zero');

  return ok({
    shotSeq,
    inputSeq,
    aiming,
    clientTimeMs,
    direction: { x: dir.x / length, y: dir.y / length, z: dir.z / length },
  });
}

export function validateSwitchWeapon(value: unknown): ValidationResult<SwitchWeaponPayload> {
  if (!isRecord(value)) return fail('switchWeapon payload must be an object');
  if (!isWeaponId(value.weaponId)) return fail('switchWeapon.weaponId is not a known weapon');
  return ok({ weaponId: value.weaponId });
}

export function validatePing(value: unknown): ValidationResult<PingPayload> {
  if (!isRecord(value)) return fail('ping payload must be an object');
  if (!finiteNumber(value.clientTimeMs) || value.clientTimeMs < 0) {
    return fail('ping.clientTimeMs must be a non-negative number');
  }
  return ok({ clientTimeMs: value.clientTimeMs });
}

export function validateJoinOptions(
  value: unknown,
  expectedProtocolVersion: number,
): ValidationResult<{ displayName: string; protocolVersion: number }> {
  if (!isRecord(value)) return fail('join options must be an object');
  const protocolVersion = value.protocolVersion;
  if (!finiteNumber(protocolVersion) || protocolVersion !== expectedProtocolVersion) {
    return fail(
      `protocol version mismatch (client ${String(protocolVersion)}, server ${expectedProtocolVersion})`,
    );
  }
  return ok({
    displayName: sanitizeDisplayName(value.displayName),
    protocolVersion,
  });
}

/**
 * Token-bucket rate limiter used for per-connection message and command budgets.
 * Deliberately allocation-free so it can run on every inbound message.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    nowMs: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  /** Consumes `cost` tokens; returns false when the caller is over budget. */
  tryConsume(cost = 1, nowMs: number = Date.now()): boolean {
    const elapsedSeconds = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    this.lastRefillMs = nowMs;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  get available(): number {
    return this.tokens;
  }
}
