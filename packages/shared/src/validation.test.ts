import { describe, expect, it } from 'vitest';
import {
  MAX_COMMANDS_PER_BATCH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PITCH,
  PROTOCOL_VERSION,
} from './constants.js';
import {
  RateLimiter,
  generateRoomCode,
  normalizeRoomCode,
  sanitizeDisplayName,
  validateFire,
  validateInputBatch,
  validateInputCommand,
  validateJoinOptions,
  validatePing,
  validateSwitchWeapon,
} from './validation.js';
import { mulberry32 } from './math.js';

describe('sanitizeDisplayName', () => {
  it('keeps ordinary names unchanged', () => {
    expect(sanitizeDisplayName('Riftwalker')).toBe('Riftwalker');
  });

  it('truncates to the maximum length', () => {
    const name = sanitizeDisplayName('X'.repeat(200));
    expect(name).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
  });

  it('strips markup-significant characters', () => {
    expect(sanitizeDisplayName('<img src=x>')).toBe('img src=x');
    expect(sanitizeDisplayName('a"b\'c`d\\e')).toBe('abcde');
  });

  it('strips control and zero-width characters', () => {
    expect(sanitizeDisplayName(`ab\u0007cd`)).toBe('abcd');
    expect(sanitizeDisplayName(`a\u200bb\u202ec`)).toBe('abc');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeDisplayName('  Rift    Front  ')).toBe('Rift Front');
  });

  it('falls back for empty or non-string input', () => {
    expect(sanitizeDisplayName('')).toBe('Recruit');
    expect(sanitizeDisplayName('   ')).toBe('Recruit');
    expect(sanitizeDisplayName(null)).toBe('Recruit');
    expect(sanitizeDisplayName(42)).toBe('Recruit');
    // A name made only of invisible characters must not become an empty label.
    expect(sanitizeDisplayName(`\u200b\u200b\u202e`)).toBe('Recruit');
  });

  it('accepts a custom fallback', () => {
    expect(sanitizeDisplayName('', 'Player 2')).toBe('Player 2');
  });
});

describe('room codes', () => {
  it('generates codes of the expected shape', () => {
    const code = generateRoomCode(mulberry32(1234));
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  });

  it('normalises case and whitespace', () => {
    expect(normalizeRoomCode(' abcde ')).toBe('ABCDE');
  });

  it('rejects wrong lengths and ambiguous characters', () => {
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(normalizeRoomCode('ABCDEF')).toBeNull();
    expect(normalizeRoomCode('ABCD0')).toBeNull();
    expect(normalizeRoomCode('ABCDO')).toBeNull();
    expect(normalizeRoomCode(12345)).toBeNull();
  });
});

describe('validateInputCommand', () => {
  const valid = { seq: 3, moveX: 0.5, moveZ: -1, yaw: 1, pitch: 0.2, buttons: 3 };

  it('accepts a well-formed command', () => {
    const result = validateInputCommand(valid);
    expect(result.ok).toBe(true);
  });

  it('clamps move axes into range', () => {
    const result = validateInputCommand({ ...valid, moveX: 900, moveZ: -900 });
    expect(result.ok && result.value.moveX).toBe(1);
    expect(result.ok && result.value.moveZ).toBe(-1);
  });

  it('clamps pitch to the playable range', () => {
    const result = validateInputCommand({ ...valid, pitch: 99 });
    expect(result.ok && result.value.pitch).toBeCloseTo(MAX_PITCH, 6);
  });

  it('normalises yaw into [-PI, PI]', () => {
    const result = validateInputCommand({ ...valid, yaw: Math.PI * 7 });
    expect(result.ok && Math.abs(result.value.yaw)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });

  it('rejects malformed payloads', () => {
    expect(validateInputCommand(null).ok).toBe(false);
    expect(validateInputCommand('nope').ok).toBe(false);
    expect(validateInputCommand({ ...valid, seq: -1 }).ok).toBe(false);
    expect(validateInputCommand({ ...valid, seq: 1.5 }).ok).toBe(false);
    expect(validateInputCommand({ ...valid, moveX: Number.NaN }).ok).toBe(false);
    expect(validateInputCommand({ ...valid, yaw: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateInputCommand({ ...valid, buttons: 99999 }).ok).toBe(false);
    expect(validateInputCommand({ ...valid, buttons: -1 }).ok).toBe(false);
  });
});

describe('validateInputBatch', () => {
  const command = { seq: 1, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons: 0 };

  it('accepts a batch within the limit', () => {
    const result = validateInputBatch({ commands: [command], clientTimeMs: 10 });
    expect(result.ok).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(validateInputBatch({ commands: [], clientTimeMs: 10 }).ok).toBe(false);
  });

  it('rejects an oversized batch', () => {
    const commands = Array.from({ length: MAX_COMMANDS_PER_BATCH + 1 }, (_, i) => ({
      ...command,
      seq: i + 1,
    }));
    expect(validateInputBatch({ commands, clientTimeMs: 10 }).ok).toBe(false);
  });

  it('rejects a batch containing one bad command', () => {
    const result = validateInputBatch({
      commands: [command, { ...command, seq: 'x' }],
      clientTimeMs: 10,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects missing or invalid client time', () => {
    expect(validateInputBatch({ commands: [command] }).ok).toBe(false);
    expect(validateInputBatch({ commands: [command], clientTimeMs: -1 }).ok).toBe(false);
  });
});

describe('validateFire', () => {
  const valid = {
    shotSeq: 4,
    direction: { x: 0, y: 0, z: 2 },
    inputSeq: 12,
    aiming: false,
    clientTimeMs: 100,
  };

  it('normalises the direction to a unit vector', () => {
    const result = validateFire(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        Math.hypot(result.value.direction.x, result.value.direction.y, result.value.direction.z),
      ).toBeCloseTo(1, 9);
    }
  });

  it('rejects zero-length and non-finite directions', () => {
    expect(validateFire({ ...valid, direction: { x: 0, y: 0, z: 0 } }).ok).toBe(false);
    expect(validateFire({ ...valid, direction: { x: Number.NaN, y: 0, z: 1 } }).ok).toBe(false);
    expect(validateFire({ ...valid, direction: null }).ok).toBe(false);
  });

  it('rejects malformed sequence numbers and flags', () => {
    expect(validateFire({ ...valid, shotSeq: -3 }).ok).toBe(false);
    expect(validateFire({ ...valid, inputSeq: 1.2 }).ok).toBe(false);
    expect(validateFire({ ...valid, aiming: 'yes' }).ok).toBe(false);
  });
});

describe('validateSwitchWeapon / validatePing / validateJoinOptions', () => {
  it('only accepts known weapons', () => {
    expect(validateSwitchWeapon({ weaponId: 'shotgun' }).ok).toBe(true);
    expect(validateSwitchWeapon({ weaponId: 'nuke' }).ok).toBe(false);
    expect(validateSwitchWeapon({}).ok).toBe(false);
  });

  it('validates ping payloads', () => {
    expect(validatePing({ clientTimeMs: 5 }).ok).toBe(true);
    expect(validatePing({ clientTimeMs: -5 }).ok).toBe(false);
    expect(validatePing({}).ok).toBe(false);
  });

  it('rejects a protocol version mismatch', () => {
    const bad = validateJoinOptions(
      { displayName: 'A', protocolVersion: PROTOCOL_VERSION + 1 },
      PROTOCOL_VERSION,
    );
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/protocol version mismatch/);
  });

  it('sanitises the display name while accepting the join', () => {
    const result = validateJoinOptions(
      { displayName: '<script>', protocolVersion: PROTOCOL_VERSION },
      PROTOCOL_VERSION,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.displayName).toBe('script');
  });
});

describe('RateLimiter', () => {
  it('allows traffic up to the capacity then blocks', () => {
    const limiter = new RateLimiter(5, 5, 0);
    for (let i = 0; i < 5; i++) expect(limiter.tryConsume(1, 0)).toBe(true);
    expect(limiter.tryConsume(1, 0)).toBe(false);
  });

  it('refills over time', () => {
    const limiter = new RateLimiter(5, 5, 0);
    for (let i = 0; i < 5; i++) limiter.tryConsume(1, 0);
    expect(limiter.tryConsume(1, 0)).toBe(false);
    // One second later the bucket is full again.
    expect(limiter.tryConsume(5, 1000)).toBe(true);
  });

  it('never exceeds its capacity when idle', () => {
    const limiter = new RateLimiter(5, 5, 0);
    limiter.tryConsume(0, 100_000);
    expect(limiter.available).toBeLessThanOrEqual(5);
  });
});
