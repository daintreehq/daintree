import { describe, it, expect } from "vitest";
import { safeStringify } from "../safeStringify";

describe("safeStringify", () => {
  it("handles normal objects", () => {
    const obj = { name: "test", value: 123 };
    expect(safeStringify(obj)).toBe('{"name":"test","value":123}');
  });

  it("handles BigInt values", () => {
    const obj = { timestamp: BigInt("123456789012345678") };
    expect(safeStringify(obj)).toBe('{"timestamp":"123456789012345678"}');
  });

  it("handles nested BigInt values", () => {
    const obj = { outer: { inner: BigInt(999) } };
    expect(safeStringify(obj)).toBe('{"outer":{"inner":"999"}}');
  });

  it("handles circular references", () => {
    const obj: Record<string, unknown> = { name: "circular" };
    obj.self = obj;
    expect(safeStringify(obj)).toBe('{"name":"circular","self":"[Circular]"}');
  });

  it("handles deeply nested circular references", () => {
    const obj: Record<string, unknown> = { a: { b: {} } };
    (obj.a as Record<string, unknown>).b = obj;
    expect(safeStringify(obj)).toBe('{"a":{"b":"[Circular]"}}');
  });

  it("handles Symbol values", () => {
    const obj = { sym: Symbol("test") };
    expect(safeStringify(obj)).toBe('{"sym":"Symbol(test)"}');
  });

  it("handles function values", () => {
    const obj = { fn: function namedFunc() {} };
    expect(safeStringify(obj)).toBe('{"fn":"[Function: namedFunc]"}');
  });

  it("handles anonymous function values", () => {
    const obj = { fn: () => {} };
    const result = safeStringify(obj);
    expect(result).toMatch(/\{"fn":"\[Function: (fn|anonymous)?\]"\}/);
  });

  it("handles Error objects", () => {
    const error = new Error("test error");
    error.stack = "Error: test error\n    at test.ts:1:1";
    const obj = { error };
    const result = JSON.parse(safeStringify(obj));
    expect(result.error.name).toBe("Error");
    expect(result.error.message).toBe("test error");
    expect(result.error.stack).toContain("test error");
  });

  it("handles null and undefined", () => {
    const obj = { nullVal: null, undefinedVal: undefined };
    expect(safeStringify(obj)).toBe('{"nullVal":null}');
  });

  it("supports pretty printing with space parameter", () => {
    const obj = { a: 1, b: 2 };
    const result = safeStringify(obj, 2);
    expect(result).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it("handles Date objects", () => {
    const date = new Date("2024-01-15T12:00:00.000Z");
    const obj = { date };
    const result = JSON.parse(safeStringify(obj));
    expect(result.date).toBe("2024-01-15T12:00:00.000Z");
  });

  it("handles top-level undefined", () => {
    const result = safeStringify(undefined);
    expect(result).toBe(undefined);
  });

  it("handles objects with throwing toJSON", () => {
    const obj = {
      name: "test",
      toJSON() {
        throw new Error("toJSON error");
      },
    };
    const result = safeStringify(obj);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles objects with throwing toString in fallback", () => {
    const obj = {
      toString() {
        throw new Error("toString error");
      },
      valueOf() {
        throw new Error("valueOf error");
      },
    };
    const result = safeStringify(obj);
    expect(typeof result).toBe("string");
    expect(result).toContain("Function");
  });

  it("handles array circular references", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    const result = safeStringify(arr);
    expect(result).toBe('[1,2,"[Circular]"]');
  });

  it("produces deterministic key order", () => {
    const obj = { b: 1, a: 2, c: 3 };
    expect(safeStringify(obj)).toBe('{"a":2,"b":1,"c":3}');
  });

  it("handles top-level BigInt", () => {
    expect(safeStringify(BigInt("9007199254740993123456789"))).toBe('"9007199254740993123456789"');
  });
});
