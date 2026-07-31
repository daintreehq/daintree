import { describe, expect, it } from "vitest";
import { sha256Hex, stableArgsSha256 } from "../pluginMcpHash.js";
import {
  safeSerializeToolResult,
  safeSerializeToolResultCompact,
} from "../safeSerializeToolResult.js";

describe("sha256Hex", () => {
  it("returns a 64-char lowercase hex digest", () => {
    const out = sha256Hex("hello");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across calls", () => {
    expect(sha256Hex("same")).toEqual(sha256Hex("same"));
  });

  it("differs when an invisible Unicode zero-width space is appended", () => {
    // Defends against OWASP MCP03 rug-pull: invisible chars must flip the hash
    // even when the rendered string looks identical.
    const clean = "Fetch the user profile.";
    // eslint-disable-next-line no-irregular-whitespace
    const tainted = `${clean}​`; // appended zero-width space
    expect(sha256Hex(clean)).not.toEqual(sha256Hex(tainted));
  });

  it("differs on a single-byte change", () => {
    expect(sha256Hex("hello")).not.toEqual(sha256Hex("hellO"));
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
