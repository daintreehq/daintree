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

  it("handles arrays with BigInt", () => {
    const arr = [BigInt(1), BigInt(2), BigInt(3)];
    expect(safeStringify(arr)).toBe('["1","2","3"]');
  });

  it("handles mixed types", () => {
    const obj = {
      str: "hello",
      num: 42,
      bigint: BigInt("9007199254740993"),
      bool: true,
      arr: [1, 2, BigInt(3)],
    };
    const result = JSON.parse(safeStringify(obj));
    expect(result.str).toBe("hello");
    expect(result.num).toBe(42);
    expect(result.bigint).toBe("9007199254740993");
    expect(result.bool).toBe(true);
    expect(result.arr).toEqual([1, 2, "3"]);
  });

  it("supports pretty printing with space parameter", () => {
    const obj = { a: 1, b: 2 };
    const result = safeStringify(obj, 2);
    expect(result).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it("handles primitive values directly", () => {
    expect(safeStringify("hello")).toBe('"hello"');
    expect(safeStringify(123)).toBe("123");
    expect(safeStringify(true)).toBe("true");
    expect(safeStringify(null)).toBe("null");
  });

  it("handles empty objects and arrays", () => {
    expect(safeStringify({})).toBe("{}");
    expect(safeStringify([])).toBe("[]");
  });

  it("handles Date objects", () => {
    const date = new Date("2024-01-15T12:00:00.000Z");
    const obj = { date };
    const result = JSON.parse(safeStringify(obj));
    expect(result.date).toBe("2024-01-15T12:00:00.000Z");
  });

  it("handles Map and Set (as regular objects)", () => {
    const map = new Map([["key", "value"]]);
    const set = new Set([1, 2, 3]);
    expect(safeStringify(map)).toBe("{}");
    expect(safeStringify(set)).toBe("{}");
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

  it("handles pretty-printed BigInt in context", () => {
    const context = { timestamp: BigInt("123456789012345678"), user: "alice" };
    const result = safeStringify(context, 2);
    const parsed = JSON.parse(result);
    expect(parsed.timestamp).toBe("123456789012345678");
    expect(parsed.user).toBe("alice");
    expect(result).toContain("\n");
  });
});
