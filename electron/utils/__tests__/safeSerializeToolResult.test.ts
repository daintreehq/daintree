import { describe, expect, it } from "vitest";
import { safeSerializeToolResult } from "../safeSerializeToolResult.js";

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

  it("falls back to string coercion when JSON.stringify yields undefined", () => {
    expect(safeSerializeToolResult(undefined)).toBe("undefined");
  });
});
