import { afterEach, describe, expect, it, vi } from "vitest";
import { deepFreeze } from "../deepFreeze.js";

describe("deepFreeze", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("freezes nested objects and arrays (not just the top level)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const obj = { a: 1, nested: { b: 2 }, list: [{ c: 3 }] };
    deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen(obj.nested)).toBe(true);
    expect(Object.isFrozen(obj.list)).toBe(true);
    expect(Object.isFrozen(obj.list[0])).toBe(true);
  });

  it("makes a nested write throw (ESM modules are always strict mode)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const obj: { nested: { b: number } } = { nested: { b: 2 } };
    deepFreeze(obj);
    expect(() => {
      (obj.nested as { b: number }).b = 99;
    }).toThrow();
  });

  it("is a no-op in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const obj = { a: 1, nested: { b: 2 } };
    deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(false);
    expect(Object.isFrozen(obj.nested)).toBe(false);
  });

  it("tolerates cyclic input without overflowing the stack", () => {
    vi.stubEnv("NODE_ENV", "development");
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", a };
    a.b = b;
    expect(() => deepFreeze(a)).not.toThrow();
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });
});
