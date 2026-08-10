import { describe, expect, it } from 'vitest';
import { BinaryReader, BinaryWriter, EventType, readEvent, writeEvent, type ShotEvent } from '@br/shared';

describe('binary reader/writer', () => {
  it('round-trips every scalar type', () => {
    const w = new BinaryWriter(8);
    w.u8(255);
    w.i8(-128);
    w.u16(65535);
    w.i16(-32768);
    w.u32(4294967295);
    w.f32(0.5);
    w.f64(Math.PI);
    w.str('hello ☃');

    const r = new BinaryReader(w.finish());
    expect(r.u8()).toBe(255);
    expect(r.i8()).toBe(-128);
    expect(r.u16()).toBe(65535);
    expect(r.i16()).toBe(-32768);
    expect(r.u32()).toBe(4294967295);
    expect(r.f32()).toBe(0.5);
    expect(r.f64()).toBe(Math.PI);
    expect(r.str()).toBe('hello ☃');
    expect(r.remaining).toBe(0);
  });

  it('grows past its initial capacity', () => {
    const w = new BinaryWriter(2);
    for (let i = 0; i < 500; i++) w.u32(i);
    const r = new BinaryReader(w.finish());
    for (let i = 0; i < 500; i++) expect(r.u32()).toBe(i);
  });

  it('reads from a Uint8Array view with a non-zero byte offset', () => {
    const w = new BinaryWriter(16);
    w.u32(0xdeadbeef);
    w.str('offset');
    const bytes = new Uint8Array(w.finish());

    const padded = new Uint8Array(bytes.length + 5);
    padded.set(bytes, 5);
    const view = padded.subarray(5);

    const r = new BinaryReader(view);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.str()).toBe('offset');
  });

  /**
   * The aiming bit on a Shot event has to survive the wire, or a client
   * watching someone else fire would draw the wrong spread cone for a shot the
   * server resolved as aimed.
   */
  it('round-trips a Shot event with the aiming flag either way', () => {
    const base: Omit<ShotEvent, 'aiming'> = {
      type: EventType.Shot,
      shooterId: 7,
      seq: 4294967000,
      weapon: 42,
      x: 1.5,
      y: -2.25,
      z: 300.75,
      yawQ: 12345,
      pitchQ: -6789,
    };

    for (const aiming of [true, false]) {
      const w = new BinaryWriter(32);
      writeEvent(w, { ...base, aiming });
      const r = new BinaryReader(w.finish());
      expect(readEvent(r)).toEqual({ ...base, aiming });
    }
  });
});
