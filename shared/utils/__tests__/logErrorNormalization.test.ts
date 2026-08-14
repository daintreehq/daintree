import { describe, it, expect } from "vitest";
import { runInNewContext } from "vm";
import { normalizeErrorsInLogContext } from "../logErrorNormalization.js";

/** The record an Error is expected to have been replaced by. */
function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

describe("normalizeErrorsInLogContext", () => {
  it("replaces an Error with a record carrying the fields JSON.stringify drops", () => {
    const error = new TypeError("wake failed");
    const normalized = normalizeErrorsInLogContext({ id: "terminal-1", error });

    // The bug being fixed: the raw Error survives none of its own identity.
    expect(JSON.parse(JSON.stringify({ error }))).toEqual({ error: {} });

    const record = asRecord(normalized.error);
    expect(record.name).toBe(error.name);
    expect(record.message).toBe(error.message);
    expect(record.stack).toBe(error.stack);
    expect(normalized.id).toBe("terminal-1");
  });

  it("survives a JSON round-trip with its message intact", () => {
    const normalized = normalizeErrorsInLogContext({ error: new Error("boom") });
    const roundTripped = JSON.parse(JSON.stringify(normalized)) as {
      error: { message?: string };
    };
    expect(roundTripped.error.message).toBe("boom");
  });

  it("finds Errors nested in objects and inside arrays", () => {
    const nested = new Error("deep");
    const listed = new Error("in a list");
    const normalized = normalizeErrorsInLogContext({
      task: { attempt: 2, error: nested },
      failures: [listed],
    });

    const task = asRecord(normalized.task);
    expect(asRecord(task.error).message).toBe(nested.message);
    const failures = normalized.failures as unknown[];
    expect(asRecord(failures[0]).message).toBe(listed.message);
  });

  it("leaves the caller's context and Error untouched", () => {
    const error = new Error("original");
    const context = { error, nested: { error } };
    normalizeErrorsInLogContext(context);

    expect(context.error).toBe(error);
    expect(context.nested.error).toBe(error);
    expect(error.message).toBe("original");
  });

  it("returns the same reference when the context holds no Error", () => {
    const context = { id: "x", nested: { list: [1, "two", null], flag: true } };
    expect(normalizeErrorsInLogContext(context)).toBe(context);
  });

  it("gives aliased siblings the same normalized node rather than a cycle sentinel", () => {
    const shared = { error: new Error("shared") };
    const normalized = normalizeErrorsInLogContext({ a: shared, b: shared });

    expect(normalized.a).toBe(normalized.b);
    expect(asRecord(asRecord(normalized.a).error).message).toBe("shared");
  });

  it("breaks cycles so the result can be structured-cloned", () => {
    const context: Record<string, unknown> = { error: new Error("cyclic") };
    context.self = context;

    const normalized = normalizeErrorsInLogContext(context);
    expect(asRecord(normalized.error).message).toBe("cyclic");
    expect(() => structuredClone(normalized)).not.toThrow();
  });

  it("terminates on a chain far deeper than it walks, leaving the unreached Error alone", () => {
    const buried = new Error("too deep");
    let node: Record<string, unknown> = { buried };
    for (let i = 0; i < 40; i++) node = { child: node };

    const normalized = normalizeErrorsInLogContext(node);
    // Nothing within reach changed, so the identity fast path applies.
    expect(normalized).toBe(node);
  });

  it("normalizes an Error from another realm, which instanceof cannot see", () => {
    const foreign = runInNewContext("new Error('cross realm')") as Error;
    expect(foreign instanceof Error).toBe(false);

    const record = asRecord(normalizeErrorsInLogContext({ error: foreign }).error);
    expect(record.message).toBe("cross realm");
  });

  it("does not let a throwing Error getter escape, and still reports something", () => {
    const hostile = new Error("nope");
    Object.defineProperty(hostile, "stack", {
      get: () => {
        throw new Error("hostile getter");
      },
    });
    const context = { error: hostile };

    let normalized: Record<string, unknown> = {};
    expect(() => {
      normalized = normalizeErrorsInLogContext(context);
    }).not.toThrow();

    const record = asRecord(normalized.error);
    expect(record.message).toBeTypeOf("string");
    expect((record.message as string).length).toBeGreaterThan(0);
  });

  it("does not rewrite Dates, Maps, Sets or class instances as records", () => {
    class Holder {
      constructor(readonly label: string) {}
    }
    const date = new Date(0);
    const map = new Map([["k", "v"]]);
    const set = new Set([1]);
    const holder = new Holder("keep me");
    const context = { date, map, set, holder, error: new Error("trigger the clone") };

    const normalized = normalizeErrorsInLogContext(context);
    // The clone path ran (an Error was present), yet non-record containers are
    // passed through by reference rather than flattened into plain objects.
    expect(normalized.date).toBe(date);
    expect(normalized.map).toBe(map);
    expect(normalized.set).toBe(set);
    expect(normalized.holder).toBe(holder);
  });

  it("keeps a null-prototype record walkable", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.error = new Error("bare");

    const record = asRecord(normalizeErrorsInLogContext({ bare }).bare);
    expect(asRecord(record.error).message).toBe("bare");
  });
});
