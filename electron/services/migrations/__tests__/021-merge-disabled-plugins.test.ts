import { describe, expect, it, vi } from "vitest";
import { migration021 } from "../021-merge-disabled-plugins.js";

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
    _data: data,
  } as unknown as Parameters<typeof migration021.up>[0] & {
    _data: Record<string, unknown>;
  };
}

describe("migration021 — merge disabled plugins", () => {
  it("has version 21", () => {
    expect(migration021.version).toBe(21);
  });

  it("merges disabledBuiltins into disabled and drops the legacy key", () => {
    const data: Record<string, unknown> = {
      plugins: { disabledBuiltins: ["daintree.muted"], disabled: [] },
    };
    const store = makeStoreMock(data);
    migration021.up(store);
    const after = data.plugins as Record<string, unknown>;
    expect(after.disabled).toEqual(["daintree.muted"]);
    expect("disabledBuiltins" in after).toBe(false);
  });

  it("dedupes when an id is present in both lists", () => {
    const data: Record<string, unknown> = {
      plugins: { disabledBuiltins: ["daintree.a", "daintree.b"], disabled: ["daintree.b"] },
    };
    const store = makeStoreMock(data);
    migration021.up(store);
    const after = data.plugins as Record<string, unknown>;
    expect(after.disabled).toEqual(["daintree.b", "daintree.a"]);
    expect("disabledBuiltins" in after).toBe(false);
  });

  it("preserves existing disabled ids when there is no legacy field", () => {
    const data: Record<string, unknown> = {
      plugins: { disabled: ["acme.user"] },
    };
    const store = makeStoreMock(data);
    migration021.up(store);
    const after = data.plugins as Record<string, unknown>;
    expect(after.disabled).toEqual(["acme.user"]);
  });

  it("is a no-op when there is no plugins state", () => {
    const data: Record<string, unknown> = {};
    const store = makeStoreMock(data);
    migration021.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("is a no-op when there is nothing to migrate and no legacy key", () => {
    const data: Record<string, unknown> = { plugins: { disabled: ["acme.user"] } };
    const store = makeStoreMock(data);
    migration021.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("strips an empty legacy key even when there is nothing to merge", () => {
    const data: Record<string, unknown> = {
      plugins: { disabledBuiltins: [], disabled: ["acme.user"] },
    };
    const store = makeStoreMock(data);
    migration021.up(store);
    const after = data.plugins as Record<string, unknown>;
    expect(after.disabled).toEqual(["acme.user"]);
    expect("disabledBuiltins" in after).toBe(false);
  });

  it("ignores malformed legacy values defensively", () => {
    const data: Record<string, unknown> = {
      plugins: { disabledBuiltins: "not-an-array", disabled: ["acme.user"] },
    };
    const store = makeStoreMock(data);
    migration021.up(store);
    const after = data.plugins as Record<string, unknown>;
    expect(after.disabled).toEqual(["acme.user"]);
    expect("disabledBuiltins" in after).toBe(false);
  });

  it("preserves unrelated keys in the plugins object", () => {
    const data: Record<string, unknown> = {
      plugins: { disabledBuiltins: ["daintree.muted"], other: "keep" },
    };
    const store = makeStoreMock(data);
    migration021.up(store);
    const after = data.plugins as Record<string, unknown>;
    expect(after.disabled).toEqual(["daintree.muted"]);
    expect(after.other).toBe("keep");
    expect("disabledBuiltins" in after).toBe(false);
  });
});
