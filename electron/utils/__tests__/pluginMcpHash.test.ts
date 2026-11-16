import { describe, expect, it } from "vitest";
import { boundedStableArgsSha256, sha256Hex, stableArgsSha256 } from "../pluginMcpHash.js";
import {
  safeSerializeToolResult,
  safeSerializeToolResultCompact,
} from "../safeSerializeToolResult.js";

describe("sha256Hex", () => {
  it("returns a 64-char lowercase hex digest", () => {
    const out = sha256Hex("hello");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when an invisible Unicode zero-width space is appended", () => {
    // Defends against OWASP MCP03 rug-pull: invisible chars must flip the hash
    // even when the rendered string looks identical.
    const clean = "Fetch the user profile.";
    // eslint-disable-next-line no-irregular-whitespace
    const tainted = `${clean}​`; // appended zero-width space
    expect(sha256Hex(clean)).not.toEqual(sha256Hex(tainted));
  });
});

describe("stableArgsSha256", () => {
  it("hashes equal objects produced in different key orders to the same digest", () => {
    const a = { name: "ada", role: "engineer", age: 30 };
    const b = { role: "engineer", age: 30, name: "ada" };
    expect(stableArgsSha256(a)).toEqual(stableArgsSha256(b));
  });

  it("normalises nested object key order recursively", () => {
    const a = { outer: { x: 1, y: 2 }, list: [{ a: 1, b: 2 }] };
    const b = { list: [{ b: 2, a: 1 }], outer: { y: 2, x: 1 } };
    expect(stableArgsSha256(a)).toEqual(stableArgsSha256(b));
  });

  it("hashes different values to different digests", () => {
    expect(stableArgsSha256({ x: 1 })).not.toEqual(stableArgsSha256({ x: 2 }));
  });

  it("does not throw on cyclic input", () => {
    const obj: Record<string, unknown> = { name: "x" };
    obj.self = obj;
    expect(() => stableArgsSha256(obj)).not.toThrow();
  });

  it("digests the indented serialization, not the compact wire form", () => {
    // Digests are persisted (TOFU schema pins, audit records), so the byte
    // layout they were computed over is a compatibility contract. Moving this
    // to the compact serializer the MCP wire uses would rotate every stored
    // fingerprint and force spurious re-consent (#11526).
    const args = { name: "ada", role: "engineer" };

    expect(stableArgsSha256(args)).toEqual(sha256Hex(safeSerializeToolResult(args)));
    expect(stableArgsSha256(args)).not.toEqual(sha256Hex(safeSerializeToolResultCompact(args)));
  });
});

describe("boundedStableArgsSha256 (#17069)", () => {
  it("hashes input within the budget exactly as stableArgsSha256 does", () => {
    const shared = { k: "v" };
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    for (const args of [
      [{ b: 1, a: [1, "two", null] }],
      [shared, shared],
      cyclic,
      [new Uint8Array([3, 1, 2])],
    ]) {
      expect(boundedStableArgsSha256(args, 10_000)).toBe(stableArgsSha256(args));
    }
  });

  it("digests the key-sorted indented form, independently of how it is built", () => {
    const args = { b: { d: [1, { z: 1, y: 2 }], c: "x" }, a: new Uint8Array([3, 1]) };
    const sorted = { a: { "0": 3, "1": 1 }, b: { c: "x", d: [1, { y: 2, z: 1 }] } };
    const expected = sha256Hex(safeSerializeToolResult(sorted));

    expect(stableArgsSha256(args)).toBe(expected);
    expect(boundedStableArgsSha256(args, 10_000)).toBe(expected);
  });

  it("reads no length the unmetered digest never read", () => {
    const view = new Uint8Array([1, 2]);
    Object.defineProperty(view, "length", {
      get() {
        throw new Error("length read");
      },
    });
    expect(() => stableArgsSha256([view])).not.toThrow();
  });

  it("hashes a small view whose own length property lies, by its real length", () => {
    const view = new Uint8Array([4, 5]);
    Object.defineProperty(view, "length", { value: Number.NaN });
    expect(boundedStableArgsSha256([view], 10_000)).toBe(stableArgsSha256([view]));
  });

  it("charges an array's slots once, so a few thousand numbers still hash", () => {
    // About 45 KB of canonical JSON: inside the budget, and so hashed.
    const args = [{ ids: new Array<number>(5_000).fill(0) }];
    expect(boundedStableArgsSha256(args, 64 * 1024)).toBe(stableArgsSha256(args));
  });

  it("meters a view by its real length, whatever its own length property says", () => {
    const buffer = new ArrayBuffer(1_000);
    const views = Array.from({ length: 5 }, () => {
      const view = new Uint8Array(buffer);
      Object.defineProperty(view, "length", { value: Number.NaN });
      return view;
    });
    expect(boundedStableArgsSha256(views, 2_000)).toBeNull();
  });

  it("answers null once canonicalizing would exceed the budget", () => {
    expect(boundedStableArgsSha256(["x".repeat(100)], 50)).toBeNull();
    expect(boundedStableArgsSha256([new Uint8Array(100)], 50)).toBeNull();
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    expect(boundedStableArgsSha256(wide, 50)).toBeNull();
    expect(boundedStableArgsSha256(["x".repeat(10)], 50)).toBe(stableArgsSha256(["x".repeat(10)]));
  });
});
