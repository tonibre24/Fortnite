/**
 * sfc32 - a small, fast, integer-only PRNG. Every operation is a 32-bit int
 * op, so it produces an identical stream in every JS engine. Used for map
 * generation, which client and server must agree on bit-for-bit.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    // Scramble a single 32-bit seed into four state words.
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  nextUint32(): number {
    const a = this.a;
    const b = this.b;
    const c = this.c;
    const d = this.d;
    const t = (a + b) | 0;
    this.a = b ^ (b >>> 9);
    this.b = (c + (c << 3)) | 0;
    this.c = (c << 21) | (c >>> 11);
    this.d = (d + 1) | 0;
    const r = (t + d) | 0;
    this.c = (this.c + r) | 0;
    return r >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  }
}

/** FNV-1a over 32-bit values; used to fingerprint generated maps. */
export function hashNumbers(values: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  const scratch = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < values.length; i++) {
    scratch.setFloat64(0, values[i]!);
    for (let b = 0; b < 8; b++) {
      h ^= scratch.getUint8(b);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}
