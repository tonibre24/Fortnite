/**
 * Thin cursor-based wrappers over DataView. All network traffic is built with
 * these; there is no JSON on the wire.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class BinaryWriter {
  private view: DataView;
  private bytes: Uint8Array;
  offset = 0;

  constructor(initialCapacity = 512) {
    this.bytes = new Uint8Array(initialCapacity);
    this.view = new DataView(this.bytes.buffer);
  }

  private ensure(extra: number): void {
    const needed = this.offset + extra;
    if (needed <= this.bytes.length) return;
    let capacity = this.bytes.length * 2;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, v);
    this.offset += 1;
  }

  i8(v: number): void {
    this.ensure(1);
    this.view.setInt8(this.offset, v);
    this.offset += 1;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }

  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.offset, v, true);
    this.offset += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, v, true);
    this.offset += 4;
  }

  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
  }

  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.offset, v, true);
    this.offset += 8;
  }

  /** Length-prefixed UTF-8, max 255 bytes. */
  str(v: string): void {
    const encoded = textEncoder.encode(v);
    const length = Math.min(encoded.length, 255);
    this.ensure(1 + length);
    this.view.setUint8(this.offset, length);
    this.offset += 1;
    this.bytes.set(encoded.subarray(0, length), this.offset);
    this.offset += length;
  }

  /** Copy of exactly the bytes written so far. */
  finish(): ArrayBuffer {
    const out = new ArrayBuffer(this.offset);
    new Uint8Array(out).set(this.bytes.subarray(0, this.offset));
    return out;
  }
}

export class BinaryReader {
  private view: DataView;
  private bytes: Uint8Array;
  offset = 0;

  constructor(buffer: ArrayBuffer | Uint8Array) {
    if (buffer instanceof Uint8Array) {
      this.bytes = buffer;
      this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else {
      this.bytes = new Uint8Array(buffer);
      this.view = new DataView(buffer);
    }
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  i8(): number {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  str(): string {
    const length = this.u8();
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return textDecoder.decode(slice);
  }
}
