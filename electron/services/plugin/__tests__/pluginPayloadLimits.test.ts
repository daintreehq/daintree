import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_PAYLOAD_TOO_LARGE,
  PluginPayloadTooLargeError,
  assertPayloadWithinLimit,
  estimatePayloadBytes,
} from "../pluginPayloadLimits.js";

describe("estimatePayloadBytes", () => {
  it("counts strings and keys as UTF-8 bytes", () => {
    expect(estimatePayloadBytes("abc")).toBe(3);
    expect(estimatePayloadBytes("é")).toBe(2);
    // container + "k" key + "vv" value
    expect(estimatePayloadBytes({ k: "vv" })).toBe(8 + 1 + 2);
  });

  it("counts binary data by byteLength", () => {
    expect(estimatePayloadBytes(new Uint8Array(1000))).toBe(8 + 1000);
    expect(estimatePayloadBytes(new ArrayBuffer(64))).toBe(8 + 64);
  });

  it("walks arrays, maps and sets", () => {
    const bytes = estimatePayloadBytes(["aa", new Map([["k", "vvv"]]), new Set(["ssss"])]);
    expect(bytes).toBe(8 + 2 + 8 + 1 + 3 + 8 + 4);
  });

  it("counts a shared or cyclic reference once and terminates", () => {
    const node: Record<string, unknown> = { name: "x" };
    node.self = node;
    expect(estimatePayloadBytes(node)).toBe(8 + 4 + 1 + 4);
  });

  it("refuses a huge sparse array without walking its length", () => {
    const sparse: unknown[] = [];
    sparse.length = 2 ** 31;
    expect(estimatePayloadBytes(sparse, 1_000)).toBeGreaterThan(1_000);
  });

  it("stops walking once the running total passes the limit", () => {
    const huge = Array.from({ length: 1_000 }, () => "x".repeat(10_000));
    const bytes = estimatePayloadBytes(huge, 50_000);
    expect(bytes).toBeGreaterThan(50_000);
    // It bailed out a few strings past the limit, not after all ~10 MB.
    expect(bytes).toBeLessThan(70_000);
  });

  it("refuses a string longer than the budget without scanning it", () => {
    const huge = "é".repeat(2_000_000);
    const byteLength = vi.spyOn(Buffer, "byteLength");
    try {
      expect(estimatePayloadBytes(huge, 1_000)).toBeGreaterThan(1_000);
      expect(byteLength).not.toHaveBeenCalled();
    } finally {
      byteLength.mockRestore();
    }
  });

  it("still measures multi-byte strings within the budget exactly", () => {
    // 400 UTF-16 units, 800 UTF-8 bytes: over a 500-byte cap despite the length.
    expect(estimatePayloadBytes("é".repeat(400), 500)).toBeGreaterThan(500);
    expect(estimatePayloadBytes("é".repeat(200), 500)).toBe(400);
  });

  it("stops inside a huge Map or Set instead of expanding it first", () => {
    const map = new Map<number, number>();
    for (let i = 0; i < 200_000; i++) map.set(i, i);
    const entries = vi.spyOn(Map.prototype, "entries");
    try {
      expect(estimatePayloadBytes(map, 1_000)).toBeGreaterThan(1_000);
      // Refused on its size alone, never iterated.
      expect(entries).not.toHaveBeenCalled();
    } finally {
      entries.mockRestore();
    }
    // Small enough to pass the size check, so the walk itself has to stop.
    const set = new Set(Array.from({ length: 20_000 }, (_, i) => `k${i}`));
    expect(estimatePayloadBytes(set, 50_000)).toBeGreaterThan(50_000);
    expect(estimatePayloadBytes(set, 50_000)).toBeLessThan(60_000);
  });

  it("stops inside a wide object without listing all of its keys", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100_000; i++) wide[`key${i}`] = i;
    const keys = vi.spyOn(Object, "keys");
    try {
      const bytes = estimatePayloadBytes(wide, 10_000);
      expect(bytes).toBeGreaterThan(10_000);
      expect(bytes).toBeLessThan(10_100);
      expect(keys).not.toHaveBeenCalled();
    } finally {
      keys.mockRestore();
    }
  });

  it("counts an Error's non-enumerable message, stack and cause", () => {
    const error = new Error("m".repeat(5_000), { cause: new Error("c".repeat(5_000)) });
    expect(estimatePayloadBytes(error)).toBeGreaterThan(10_000);
    expect(estimatePayloadBytes({ error }, 8_000)).toBeGreaterThan(8_000);
  });

  it("charges a view's whole backing buffer, once per buffer", () => {
    const backing = new ArrayBuffer(10_000);
    expect(estimatePayloadBytes(new Uint8Array(backing, 0, 1))).toBe(8 + 10_000);
    expect(estimatePayloadBytes([new Uint8Array(backing, 0, 1), new DataView(backing, 5, 1)])).toBe(
      8 + 8 + 10_000 + 8
    );
    expect(estimatePayloadBytes(new SharedArrayBuffer(64))).toBe(8 + 64);
  });

  it("stops at inherited keys, which structured clone does not copy", () => {
    const proto: Record<string, number> = {};
    for (let i = 0; i < 50_000; i++) proto[`p${i}`] = i;
    const child = Object.create(proto) as Record<string, number>;
    child.own = 1;
    expect(estimatePayloadBytes(child)).toBe(8 + 3 + 8);
  });

  it("counts a RegExp's source and flags", () => {
    const pattern = new RegExp("a".repeat(5_000), "gi");
    expect(estimatePayloadBytes(pattern)).toBe(8 + 5_000 + 2);
  });

  it("counts a BigInt by magnitude, refusing a huge one without printing it", () => {
    expect(estimatePayloadBytes(1n)).toBe(9);
    const huge = 1n << 800_000n;
    const toString = vi.spyOn(BigInt.prototype, "toString");
    try {
      expect(estimatePayloadBytes(huge, 1_000)).toBeGreaterThan(1_000);
      expect(toString).not.toHaveBeenCalled();
    } finally {
      toString.mockRestore();
    }
    expect(estimatePayloadBytes(-huge, 1_000)).toBeGreaterThan(1_000);
    expect(estimatePayloadBytes(huge)).toBeGreaterThan(100_000);
  });
});

describe("assertPayloadWithinLimit", () => {
  it("names a payload whose getter throws instead of leaking the raw error", () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("boom");
      },
    });
    expect(() => assertPayloadWithinLimit("p", "push", hostile, 100)).toThrow(
      /^PLUGIN_PAYLOAD_UNCLONEABLE: plugin "p" push cannot be cloned: boom/
    );
  });

  it("returns the estimate when under the cap", () => {
    expect(assertPayloadWithinLimit("p", "push", "abcd", 10)).toBe(4);
  });

  it("throws a named, prefixed error when over the cap", () => {
    let caught: unknown;
    try {
      assertPayloadWithinLimit("acme.demo", 'push payload on "tick"', "x".repeat(11), 10);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginPayloadTooLargeError);
    const error = caught as PluginPayloadTooLargeError;
    expect(error.code).toBe(PLUGIN_PAYLOAD_TOO_LARGE);
    expect(error.message).toMatch(/^PLUGIN_PAYLOAD_TOO_LARGE: /);
    expect(error.message).toContain('"acme.demo"');
    expect(error.message).toContain("10-byte limit");
    expect(error.message).toContain("(at least 11 bytes)");
    expect(error.observedBytes).toBe(11);
  });
});
