import { describe, expect, it } from "vitest";
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
});

describe("assertPayloadWithinLimit", () => {
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
  });
});
