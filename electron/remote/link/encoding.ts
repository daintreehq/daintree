/**
 * Bounded structured encoding for the remote-host link.
 *
 * JSON cannot carry what Electron IPC carries: binary payloads, `undefined`,
 * `Map`/`Set`, `Date`, `bigint`, non-finite numbers. This is a small tagged
 * binary format covering the structured-clone subset the IPC surface actually
 * uses, with every length checked against the remaining input and hard caps on
 * depth, container size and total size, so a hostile or corrupt peer can make
 * the decoder throw but never allocate unboundedly or pollute prototypes.
 *
 * Every `ArrayBufferView` / `ArrayBuffer` (including Node `Buffer`) decodes as
 * a plain `Uint8Array`, matching what a renderer sees after structured clone.
 */

export const TAG = {
  UNDEFINED: 0x00,
  NULL: 0x01,
  FALSE: 0x02,
  TRUE: 0x03,
  FLOAT64: 0x04,
  INT32: 0x05,
  STRING: 0x06,
  ARRAY: 0x07,
  OBJECT: 0x08,
  BYTES: 0x09,
  BIGINT: 0x0a,
  DATE: 0x0b,
  MAP: 0x0c,
  SET: 0x0d,
  ERROR: 0x0e,
  /** A string that isn't well-formed UTF-16 (a lone surrogate), carried as raw code units. */
  STRING_UTF16: 0x0f,
} as const;

export interface EncodingLimits {
  maxDepth: number;
  /** Maximum encoded size in bytes, enforced while encoding and decoding. */
  maxBytes: number;
  /** Maximum entries in a single array, object, map or set. */
  maxContainerLength: number;
  /** Maximum values decoded in one call, across all containers. */
  maxNodes: number;
  /** Maximum decimal digits in a bigint. */
  maxBigIntDigits: number;
}

export const DEFAULT_ENCODING_LIMITS: EncodingLimits = {
  maxDepth: 64,
  maxBytes: 64 * 1024 * 1024,
  maxContainerLength: 1_000_000,
  maxNodes: 2_000_000,
  maxBigIntDigits: 1024,
};

export class LinkEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkEncodingError";
  }
}

const textEncoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF in the string instead of stripping it.
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class Writer {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(private readonly maxBytes: number) {
    this.buf = new Uint8Array(256);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed > this.maxBytes) {
      throw new LinkEncodingError(`encoded value exceeds ${this.maxBytes} bytes`);
    }
    if (needed <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(Math.min(size, Math.max(needed, this.maxBytes)));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.length++] = value;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, value);
    this.length += 4;
  }

  i32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.length, value);
    this.length += 4;
  }

  f64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, value);
    this.length += 8;
  }

  bytes(value: Uint8Array): void {
    this.ensure(value.byteLength);
    this.buf.set(value, this.length);
    this.length += value.byteLength;
  }

  /** Bytes still allowed before the size cap. */
  room(): number {
    return this.maxBytes - this.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * UTF-8 encodes at least one byte per UTF-16 code unit, so a string longer
 * than the remaining room is refused before its bytes are ever produced.
 */
function encodeUtf8Bounded(w: Writer, value: string): Uint8Array {
  if (value.length > w.room()) {
    throw new LinkEncodingError("encoded value exceeds the size limit");
  }
  return textEncoder.encode(value);
}

function toBytes(value: ArrayBufferView | ArrayBuffer): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function encodeInto(
  w: Writer,
  value: unknown,
  depth: number,
  limits: EncodingLimits,
  seen: Set<object>
): void {
  if (depth > limits.maxDepth) {
    throw new LinkEncodingError(`value nests deeper than ${limits.maxDepth}`);
  }
  switch (typeof value) {
    case "undefined":
      w.u8(TAG.UNDEFINED);
      return;
    case "boolean":
      w.u8(value ? TAG.TRUE : TAG.FALSE);
      return;
    case "number":
      if (
        Number.isInteger(value) &&
        value >= -0x80000000 &&
        value <= 0x7fffffff &&
        !Object.is(value, -0)
      ) {
        w.u8(TAG.INT32);
        w.i32(value);
      } else {
        w.u8(TAG.FLOAT64);
        w.f64(value);
      }
      return;
    case "string": {
      if (LONE_SURROGATE.test(value)) {
        // TextEncoder would silently replace a lone surrogate; keep it exact.
        if (value.length * 2 > w.room()) {
          throw new LinkEncodingError("encoded value exceeds the size limit");
        }
        w.u8(TAG.STRING_UTF16);
        w.u32(value.length);
        for (let i = 0; i < value.length; i++) {
          const unit = value.charCodeAt(i);
          w.u8(unit >> 8);
          w.u8(unit & 0xff);
        }
        return;
      }
      const encoded = encodeUtf8Bounded(w, value);
      w.u8(TAG.STRING);
      w.u32(encoded.byteLength);
      w.bytes(encoded);
      return;
    }
    case "bigint": {
      const digits = value.toString();
      if (digits.replace("-", "").length > limits.maxBigIntDigits) {
        throw new LinkEncodingError(`bigint exceeds ${limits.maxBigIntDigits} digits`);
      }
      const encoded = textEncoder.encode(digits);
      w.u8(TAG.BIGINT);
      w.u32(encoded.byteLength);
      w.bytes(encoded);
      return;
    }
    case "function":
    case "symbol":
      throw new LinkEncodingError(`cannot encode a ${typeof value}`);
  }

  if (value === null) {
    w.u8(TAG.NULL);
    return;
  }

  const obj = value as object;
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    const bytes = toBytes(obj);
    w.u8(TAG.BYTES);
    w.u32(bytes.byteLength);
    w.bytes(bytes);
    return;
  }
  if (obj instanceof Date) {
    w.u8(TAG.DATE);
    w.f64(obj.getTime());
    return;
  }

  if (seen.has(obj)) {
    throw new LinkEncodingError("cannot encode a circular structure");
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      if (obj.length > limits.maxContainerLength) {
        throw new LinkEncodingError(`array exceeds ${limits.maxContainerLength} entries`);
      }
      w.u8(TAG.ARRAY);
      w.u32(obj.length);
      for (let i = 0; i < obj.length; i++) encodeInto(w, obj[i], depth + 1, limits, seen);
      return;
    }
    if (obj instanceof Map) {
      if (obj.size > limits.maxContainerLength) {
        throw new LinkEncodingError(`map exceeds ${limits.maxContainerLength} entries`);
      }
      w.u8(TAG.MAP);
      w.u32(obj.size);
      for (const [k, v] of obj) {
        encodeInto(w, k, depth + 1, limits, seen);
        encodeInto(w, v, depth + 1, limits, seen);
      }
      return;
    }
    if (obj instanceof Set) {
      if (obj.size > limits.maxContainerLength) {
        throw new LinkEncodingError(`set exceeds ${limits.maxContainerLength} entries`);
      }
      w.u8(TAG.SET);
      w.u32(obj.size);
      for (const v of obj) encodeInto(w, v, depth + 1, limits, seen);
      return;
    }
    if (obj instanceof Error) {
      w.u8(TAG.ERROR);
      encodeInto(w, obj.name, depth + 1, limits, seen);
      encodeInto(w, obj.message, depth + 1, limits, seen);
      encodeInto(w, typeof obj.stack === "string" ? obj.stack : undefined, depth + 1, limits, seen);
      return;
    }
    const keys = Object.keys(obj);
    if (keys.length > limits.maxContainerLength) {
      throw new LinkEncodingError(`object exceeds ${limits.maxContainerLength} keys`);
    }
    w.u8(TAG.OBJECT);
    w.u32(keys.length);
    for (const key of keys) {
      if (LONE_SURROGATE.test(key)) {
        throw new LinkEncodingError("object key is not well-formed UTF-16");
      }
      const encodedKey = encodeUtf8Bounded(w, key);
      w.u32(encodedKey.byteLength);
      w.bytes(encodedKey);
      encodeInto(w, (obj as Record<string, unknown>)[key], depth + 1, limits, seen);
    }
  } finally {
    seen.delete(obj);
  }
}

export function encodeValue(
  value: unknown,
  limits: EncodingLimits = DEFAULT_ENCODING_LIMITS
): Uint8Array {
  const w = new Writer(limits.maxBytes);
  encodeInto(w, value, 0, limits, new Set());
  return w.finish();
}

class Reader {
  offset = 0;
  nodes = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): void {
    if (this.offset + n > this.buf.byteLength) {
      throw new LinkEncodingError("truncated input");
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.offset++]!;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset);
    this.offset += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.offset);
    this.offset += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.offset);
    this.offset += 8;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    // A fresh plain Uint8Array, even when the input is a Node Buffer.
    const out = new Uint8Array(this.buf.subarray(this.offset, this.offset + n));
    this.offset += n;
    return out;
  }

  text(n: number): string {
    this.need(n);
    try {
      return textDecoder.decode(this.buf.subarray(this.offset, (this.offset += n)));
    } catch {
      throw new LinkEncodingError("invalid utf-8");
    }
  }

  get remaining(): number {
    return this.buf.byteLength - this.offset;
  }
}

function containerLength(r: Reader, limits: EncodingLimits, minEntryBytes: number): number {
  const n = r.u32();
  // Every entry takes at least `minEntryBytes`, so a count the remaining input
  // cannot possibly hold is rejected before anything is allocated.
  if (n > limits.maxContainerLength || n * minEntryBytes > r.remaining) {
    throw new LinkEncodingError("container length out of bounds");
  }
  return n;
}

function decodeFrom(r: Reader, depth: number, limits: EncodingLimits): unknown {
  if (depth > limits.maxDepth) {
    throw new LinkEncodingError(`value nests deeper than ${limits.maxDepth}`);
  }
  if (++r.nodes > limits.maxNodes) {
    throw new LinkEncodingError(`input decodes to more than ${limits.maxNodes} values`);
  }
  const tag = r.u8();
  switch (tag) {
    case TAG.UNDEFINED:
      return undefined;
    case TAG.NULL:
      return null;
    case TAG.FALSE:
      return false;
    case TAG.TRUE:
      return true;
    case TAG.FLOAT64:
      return r.f64();
    case TAG.INT32:
      return r.i32();
    case TAG.STRING:
      return r.text(r.u32());
    case TAG.BIGINT: {
      const length = r.u32();
      if (length > limits.maxBigIntDigits + 1) {
        throw new LinkEncodingError(`bigint exceeds ${limits.maxBigIntDigits} digits`);
      }
      const text = r.text(length);
      if (!/^-?\d+$/.test(text)) throw new LinkEncodingError("invalid bigint");
      return BigInt(text);
    }
    case TAG.BYTES:
      return r.bytes(r.u32());
    case TAG.DATE:
      return new Date(r.f64());
    case TAG.ARRAY: {
      const n = containerLength(r, limits, 1);
      const out = new Array<unknown>(n);
      for (let i = 0; i < n; i++) out[i] = decodeFrom(r, depth + 1, limits);
      return out;
    }
    case TAG.MAP: {
      const n = containerLength(r, limits, 2);
      const out = new Map<unknown, unknown>();
      for (let i = 0; i < n; i++) {
        const k = decodeFrom(r, depth + 1, limits);
        out.set(k, decodeFrom(r, depth + 1, limits));
      }
      return out;
    }
    case TAG.SET: {
      const n = containerLength(r, limits, 1);
      const out = new Set<unknown>();
      for (let i = 0; i < n; i++) out.add(decodeFrom(r, depth + 1, limits));
      return out;
    }
    case TAG.ERROR: {
      const name = decodeFrom(r, depth + 1, limits);
      const message = decodeFrom(r, depth + 1, limits);
      const stack = decodeFrom(r, depth + 1, limits);
      if (typeof name !== "string" || typeof message !== "string") {
        throw new LinkEncodingError("invalid error");
      }
      // Built without the Error constructor so decoding never captures a
      // local stack; the sender's stack (if any) is the only one kept.
      const err = Object.create(Error.prototype) as Error;
      for (const [key, value] of [
        ["name", name],
        ["message", message],
        ["stack", typeof stack === "string" ? stack : `${name}: ${message}`],
      ] as const) {
        Object.defineProperty(err, key, { value, writable: true, configurable: true });
      }
      return err;
    }
    case TAG.STRING_UTF16: {
      const units = r.u32();
      const bytes = r.bytes(units * 2);
      let out = "";
      for (let i = 0; i < units; i++)
        out += String.fromCharCode((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);
      return out;
    }
    case TAG.OBJECT: {
      const n = containerLength(r, limits, 5);
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const key = r.text(r.u32());
        // defineProperty so a "__proto__" key becomes an own data property
        // instead of reassigning the object's prototype.
        Object.defineProperty(out, key, {
          value: decodeFrom(r, depth + 1, limits),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    default:
      throw new LinkEncodingError(`unknown tag 0x${tag.toString(16)}`);
  }
}

export function decodeValue(
  input: Uint8Array,
  limits: EncodingLimits = DEFAULT_ENCODING_LIMITS
): unknown {
  if (input.byteLength > limits.maxBytes) {
    throw new LinkEncodingError(`encoded value exceeds ${limits.maxBytes} bytes`);
  }
  const r = new Reader(input);
  const value = decodeFrom(r, 0, limits);
  if (r.remaining !== 0) {
    throw new LinkEncodingError("trailing bytes after value");
  }
  return value;
}
