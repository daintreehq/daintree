import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENCODING_LIMITS,
  LinkEncodingError,
  TAG,
  decodeValue,
  encodeValue,
} from "../encoding.js";

function roundTrip(value: unknown): unknown {
  return decodeValue(encodeValue(value));
}

describe("link encoding", () => {
  it("round-trips primitives including values JSON loses", () => {
    for (const v of [
      undefined,
      null,
      true,
      false,
      0,
      42,
      -7,
      2 ** 31,
      -(2 ** 31) - 1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      "",
      "héllo ✓",
    ]) {
      const out = roundTrip(v);
      if (typeof v === "number" && Number.isNaN(v)) expect(Number.isNaN(out)).toBe(true);
      else expect(out).toBe(v);
    }
    expect(Object.is(roundTrip(-0), -0)).toBe(true);
    expect(roundTrip(123456789012345678901234567890n)).toBe(123456789012345678901234567890n);
  });

  it("round-trips nested structures, dates, maps, sets and undefined-valued keys", () => {
    const value = {
      a: [1, "two", { three: 3 }],
      when: new Date(1_700_000_000_000),
      m: new Map<unknown, unknown>([
        ["k", { v: 1 }],
        [2, [3]],
      ]),
      s: new Set(["x", "y"]),
      missing: undefined,
    };
    const out = roundTrip(value) as typeof value;
    expect(out.a).toEqual([1, "two", { three: 3 }]);
    expect(out.when.getTime()).toBe(1_700_000_000_000);
    expect(out.m.get("k")).toEqual({ v: 1 });
    expect(out.m.get(2)).toEqual([3]);
    expect([...out.s]).toEqual(["x", "y"]);
    expect("missing" in out).toBe(true);
  });

  it("carries binary through an explicit bytes tag and decodes every view as Uint8Array", () => {
    const buf = Buffer.from([1, 2, 3, 250]);
    const out = roundTrip({
      buf,
      view: new Uint16Array([1, 2]),
      ab: new Uint8Array([9]).buffer,
    }) as {
      buf: Uint8Array;
      view: Uint8Array;
      ab: Uint8Array;
    };
    expect(out.buf).toBeInstanceOf(Uint8Array);
    expect([...out.buf]).toEqual([1, 2, 3, 250]);
    expect(out.view.byteLength).toBe(4);
    expect([...out.ab]).toEqual([9]);
    const encoded = encodeValue(new Uint8Array([7]));
    expect(encoded[0]).toBe(TAG.BYTES);
  });

  it("encodes errors with name, message and stack", () => {
    const err = new TypeError("boom");
    const out = roundTrip(err) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe("TypeError");
    expect(out.message).toBe("boom");
  });

  it("does not let a __proto__ key replace the decoded object's prototype", () => {
    const encoded = encodeValue(JSON.parse('{"__proto__": {"polluted": true}}'));
    const out = decodeValue(encoded) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
  });

  it("rejects functions, symbols and cycles", () => {
    expect(() => encodeValue({ f: () => 1 })).toThrow(LinkEncodingError);
    expect(() => encodeValue(Symbol("s"))).toThrow(LinkEncodingError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeValue(cyclic)).toThrow(/circular/);
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { x: 1 };
    expect(roundTrip([shared, shared])).toEqual([{ x: 1 }, { x: 1 }]);
  });

  it("enforces depth, size and container limits on both sides", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(() => encodeValue(deep)).toThrow(/deeper/);

    const limits = { ...DEFAULT_ENCODING_LIMITS, maxBytes: 16 };
    expect(() => encodeValue("x".repeat(64), limits)).toThrow(/exceeds/);
    expect(() => decodeValue(encodeValue("x".repeat(64)), limits)).toThrow(/exceeds/);

    const small = { ...DEFAULT_ENCODING_LIMITS, maxContainerLength: 2 };
    expect(() => encodeValue([1, 2, 3], small)).toThrow(/entries/);
  });

  it("rejects truncated, trailing, unknown-tag and lying-length input without allocating", () => {
    const good = encodeValue({ a: "hello" });
    expect(() => decodeValue(good.subarray(0, good.length - 1))).toThrow(LinkEncodingError);
    expect(() => decodeValue(new Uint8Array([...good, 0]))).toThrow(/trailing/);
    expect(() => decodeValue(new Uint8Array([0x7f]))).toThrow(/unknown tag/);
    // An array claiming 4 billion entries in a 5-byte input.
    expect(() => decodeValue(new Uint8Array([TAG.ARRAY, 0xff, 0xff, 0xff, 0xff]))).toThrow(
      /out of bounds/
    );
    // Invalid UTF-8 in a string.
    expect(() => decodeValue(new Uint8Array([TAG.STRING, 0, 0, 0, 1, 0xff]))).toThrow(/utf-8/);
  });

  it("preserves a leading BOM and lone surrogates exactly", () => {
    expect(roundTrip("\uFEFFx")).toBe("\uFEFFx");
    expect(roundTrip({ "\uFEFFk": 1, k: 2 })).toEqual({ "\uFEFFk": 1, k: 2 });
    for (const s of ["a\uD800b", "\uDC00", "x\uD83D"]) expect(roundTrip(s)).toBe(s);
    expect(roundTrip("😀")).toBe("😀");
    expect(() => encodeValue({ ["\uD800"]: 1 })).toThrow(/key/);
  });

  it("refuses an oversized string before encoding it", () => {
    const limits = { ...DEFAULT_ENCODING_LIMITS, maxBytes: 32 };
    expect(() => encodeValue("x".repeat(1000), limits)).toThrow(/size limit/);
  });

  it("bounds decoded values, bigint digits and error shapes", () => {
    const many = encodeValue(new Array(50).fill(null));
    expect(() => decodeValue(many, { ...DEFAULT_ENCODING_LIMITS, maxNodes: 10 })).toThrow(
      /more than 10/
    );
    const big = BigInt("9".repeat(40));
    expect(() => encodeValue(big, { ...DEFAULT_ENCODING_LIMITS, maxBigIntDigits: 20 })).toThrow(
      /digits/
    );
    expect(() =>
      decodeValue(encodeValue(big), { ...DEFAULT_ENCODING_LIMITS, maxBigIntDigits: 20 })
    ).toThrow(/digits/);
    // An ERROR whose name isn't a string.
    expect(() => decodeValue(new Uint8Array([TAG.ERROR, TAG.NULL, TAG.NULL, TAG.NULL]))).toThrow(
      /invalid error/
    );
    const decoded = decodeValue(encodeValue(new RangeError("bad"))) as Error;
    expect(decoded.stack).toContain("RangeError");
  });

  it("decodes bytes into a plain Uint8Array even from a Buffer input", () => {
    const out = decodeValue(Buffer.from(encodeValue(new Uint8Array([1, 2])))) as Uint8Array;
    expect(Buffer.isBuffer(out)).toBe(false);
    expect([...out]).toEqual([1, 2]);
  });
});
