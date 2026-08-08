import { describe, expect, it } from 'vitest';
import { Rng, hashNumbers, quantizeYaw, dequantizeYaw, quantizePitch, dequantizePitch, MAX_PITCH } from '@br/shared';

describe('Rng', () => {
  it('produces the same stream for the same seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 1000; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const sameCount = Array.from({ length: 100 }, () => (a.nextUint32() === b.nextUint32() ? 1 : 0)).reduce(
      (x: number, y: number) => x + y,
      0,
    );
    expect(sameCount).toBe(0);
  });

  it('stays inside its declared ranges', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const n = rng.int(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
      const r = rng.range(-2, 5);
      expect(r).toBeGreaterThanOrEqual(-2);
      expect(r).toBeLessThan(5);
    }
  });

  it('shuffles deterministically and keeps every element', () => {
    const a = new Rng(7).shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = new Rng(7).shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('hashNumbers', () => {
  it('is stable and order-sensitive', () => {
    expect(hashNumbers([1, 2, 3])).toBe(hashNumbers([1, 2, 3]));
    expect(hashNumbers([1, 2, 3])).not.toBe(hashNumbers([3, 2, 1]));
  });
});

describe('angle quantization', () => {
  it('round-trips yaw within one quantization step', () => {
    const step = (Math.PI * 2) / 65536;
    for (let i = 0; i < 100; i++) {
      const yaw = (i / 100) * Math.PI * 2;
      const back = dequantizeYaw(quantizeYaw(yaw));
      const diff = Math.min(Math.abs(back - yaw), Math.abs(back - yaw - Math.PI * 2));
      expect(diff).toBeLessThanOrEqual(step);
    }
  });

  it('wraps negative yaw into range', () => {
    expect(quantizeYaw(-Math.PI * 2)).toBe(quantizeYaw(0));
    expect(quantizeYaw(-Math.PI)).toBe(quantizeYaw(Math.PI));
  });

  it('clamps pitch to the legal look range', () => {
    expect(dequantizePitch(quantizePitch(10))).toBeCloseTo(MAX_PITCH, 4);
    expect(dequantizePitch(quantizePitch(-10))).toBeCloseTo(-MAX_PITCH, 4);
    expect(dequantizePitch(quantizePitch(0))).toBeCloseTo(0, 4);
  });

  it('is idempotent - quantizing an already-quantized angle changes nothing', () => {
    for (let i = 0; i < 200; i++) {
      const q = Math.floor((i / 200) * 65536);
      expect(quantizeYaw(dequantizeYaw(q))).toBe(q);
    }
  });
});
