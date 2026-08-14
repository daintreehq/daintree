import { describe, it, expect } from "vitest";
import { runInNewContext } from "vm";
import { normalizeErrorsInLogContext } from "../logErrorNormalization.js";

/**
 * The record an Error is expected to have been replaced by.
 *
 * Rejecting a live Error is the point: it would satisfy almost every field
 * assertion in this file while still being the exact value that collapses to
 * `{}` at the contextBridge, so a pass-through implementation must not slip
 * through here. `JSON.parse(JSON.stringify(...))` is the check that matters —
 * it sees only own-enumerable properties, the same ones the bridge copies.
 */
function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(value).not.toBeInstanceOf(Error);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
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

  it("leaves the caller's graph untouched, even frozen", () => {
    const error = new Error("original");
    const list = Object.freeze([error]);
    const nested = Object.freeze({ error });
    const context = Object.freeze({ error, nested, list });

    const normalized = normalizeErrorsInLogContext(context);

    expect(context.error).toBe(error);
    expect(context.nested).toBe(nested);
    expect(context.nested.error).toBe(error);
    expect(context.list[0]).toBe(error);
    expect(error.message).toBe("original");
    // The clone is a genuinely separate graph, not the frozen original.
    expect(normalized.nested).not.toBe(nested);
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

  it("breaks cycles so the result serializes", () => {
    const context: Record<string, unknown> = { error: new Error("cyclic") };
    context.self = context;

    const normalized = normalizeErrorsInLogContext(context);
    expect(asRecord(normalized.error).message).toBe("cyclic");
    // JSON.stringify — not structuredClone — is the real proof: it throws on a
    // cycle, so a graph that still contained one would fail here.
    expect(() => JSON.stringify(normalized)).not.toThrow();
    expect(normalized.self).toBe("[Circular]");
  });

  it("keeps looking past an alias that was first reached too deep to see", () => {
    // `shared` is reached first via a path that exhausts the depth budget
    // before its Error comes into view, and again directly. A visited-set that
    // ignored depth would report the context as Error-free and ship the live
    // Error to the bridge.
    const shared = { inner: { error: new Error("hidden") } };
    const context = { deep: { a: { b: { c: shared } } }, shallow: shared };

    const normalized = normalizeErrorsInLogContext(context);
    expect(normalized).not.toBe(context);
    const reachable = normalized.shallow as { inner: { error: unknown } };
    expect(asRecord(reachable.inner.error).message).toBe("hidden");
  });

  it("degrades to a clone-safe payload when scanning itself throws", () => {
    const hostile = new Proxy(
      { error: new Error("unreachable") },
      {
        ownKeys() {
          throw new Error("ownKeys trap");
        },
      }
    ) as unknown as Record<string, unknown>;

    let normalized: Record<string, unknown> = {};
    expect(() => {
      normalized = normalizeErrorsInLogContext({ hostile });
    }).not.toThrow();
    expect(normalized).toBeTypeOf("object");
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
    // Own-key enumeration finds nothing on it, so passing it through unchanged
    // would still lose everything at the bridge.
    expect(Object.keys(foreign)).toHaveLength(0);

    const normalized = normalizeErrorsInLogContext({ error: foreign });
    expect(normalized.error).not.toBe(foreign);
    expect(asRecord(normalized.error).message).toBe("cross realm");
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

    // The unreadable field costs only itself: what the failure actually said
    // still has to come through.
    const record = asRecord(normalized.error);
    expect(record.message).toBe("nope");
    expect(record.stack).toBeUndefined();
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
