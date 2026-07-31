import { describe, expect, it } from "vitest";
import {
  safeSerializeToolResult,
  safeSerializeToolResultCompact,
} from "../safeSerializeToolResult.js";

describe("safeSerializeToolResult", () => {
  it("serializes plain JSON values losslessly", () => {
    const value = { a: 1, b: "two", c: [true, null], d: { nested: "yes" } };
    expect(JSON.parse(safeSerializeToolResult(value))).toEqual(value);
  });

  it("coerces BigInt and Symbol to strings instead of throwing", () => {
    const result = JSON.parse(safeSerializeToolResult({ big: 10n, sym: Symbol("tag") }));
    expect(result.big).toBe("10");
    expect(result.sym).toBe("Symbol(tag)");
  });

  it("replaces functions with a named placeholder", () => {
    const result = JSON.parse(safeSerializeToolResult({ fn: function namedFn() {} }));
    expect(result.fn).toBe("[Function: namedFn]");
  });

  it("expands Error instances into name, message, and stack", () => {
    const result = JSON.parse(safeSerializeToolResult({ err: new TypeError("boom") }));
    expect(result.err.name).toBe("TypeError");
    expect(result.err.message).toBe("boom");
    expect(typeof result.err.stack).toBe("string");
  });

  it("marks circular references instead of throwing", () => {
    const value: Record<string, unknown> = { name: "root" };
    value.self = value;
    const result = JSON.parse(safeSerializeToolResult(value));
    expect(result.name).toBe("root");
    expect(result.self).toBe("[Circular]");
  });

  it("expands a value referenced twice in sibling branches", () => {
    // Only a reference that closes a cycle may be replaced. Marking a repeat as
    // circular puts a placeholder string where a declared output schema expects
    // an object, which the MCP client rejects outright (#11526).
    const shared = { id: "s-1", label: "shared" };
    const result = JSON.parse(safeSerializeToolResult({ first: shared, second: shared }));

    expect(result.first).toEqual(shared);
    expect(result.second).toEqual(shared);
  });

  it("marks the back-edge without collapsing a second path to the same node", () => {
    const child: Record<string, unknown> = { name: "child" };
    const root: Record<string, unknown> = { child, alias: child };
    child.parent = root;

    const result = JSON.parse(safeSerializeToolResult(root));

    expect(result.child.parent).toBe("[Circular]");
    expect(result.alias).toEqual({ name: "child", parent: "[Circular]" });
  });

  it("falls back to string coercion when JSON.stringify yields undefined", () => {
    expect(safeSerializeToolResult(undefined)).toBe("undefined");
  });

  it("falls back to string coercion when a toJSON implementation throws", () => {
    // JSON.stringify invokes toJSON before the replacer can intercept, so the
    // throw escapes to the outer catch and string coercion takes over.
    const hostile = {
      ok: true,
      toJSON() {
        throw new Error("boom");
      },
    };
    expect(safeSerializeToolResult(hostile)).toBe("[object Object]");
  });

  it("keeps the indented byte layout that persisted hashes were computed over", () => {
    // `pluginMcpHash.ts` digests these exact bytes for plugin schema
    // fingerprints and audit argument hashes. Reformatting here silently
    // rotates every stored fingerprint and forces spurious re-consent, so the
    // whitespace is a contract rather than a style choice (#11526).
    expect(safeSerializeToolResult({ a: 1, b: { c: 2 } })).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}'
    );
  });

  it("stays uncapped — the size budget belongs to the MCP wire, not the hash input", () => {
    const blob = "x".repeat(200_000);
    expect(safeSerializeToolResult({ blob })).toContain(blob);
  });
});

describe("safeSerializeToolResultCompact", () => {
  it("drops the cosmetic whitespace no model reads", () => {
    expect(safeSerializeToolResultCompact({ a: 1, b: { c: 2 } })).toBe('{"a":1,"b":{"c":2}}');
  });

  it("carries the same value semantics as the indented form", () => {
    const value: Record<string, unknown> = {
      big: 10n,
      sym: Symbol("tag"),
      fn: function namedFn() {},
      err: new TypeError("boom"),
    };
    value.self = value;

    const compact = JSON.parse(safeSerializeToolResultCompact(value));
    expect(compact).toEqual(JSON.parse(safeSerializeToolResult(value)));
    expect(compact.self).toBe("[Circular]");
  });

  it("shares the string-coercion fallbacks", () => {
    expect(safeSerializeToolResultCompact(undefined)).toBe("undefined");
  });
});
