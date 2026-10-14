import { describe, it, expect } from "vitest";
import {
  MAX_EXTENSION_STATE_BYTES,
  applyExtensionStatePatch,
  commitExtensionState,
  parseCanonical,
} from "../extensionState.js";

const unversioned = { current: undefined, next: undefined };

describe("applyExtensionStatePatch", () => {
  it("merges the patch, with undefined removing a key", () => {
    const result = applyExtensionStatePatch({ a: 1, b: 2 }, { b: undefined, c: 3 }, unversioned);
    expect(result).toEqual({ ok: true, commit: { kind: "replace", state: { a: 1, c: 3 } } });
  });

  it("stores the canonical JSON form, detached from the patch", () => {
    const nested = { list: [1] };
    const result = applyExtensionStatePatch(
      undefined,
      { nested, when: new Date(0), nan: Number.NaN },
      unversioned
    );
    if (!result.ok || result.commit.kind !== "replace") throw new Error("expected a replace");
    expect(result.commit.state).toEqual({
      nested: { list: [1] },
      when: "1970-01-01T00:00:00.000Z",
      nan: null,
    });
    nested.list.push(2);
    expect(result.commit.state.nested).toEqual({ list: [1] });
  });

  it("refuses state that cannot round-trip through JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(applyExtensionStatePatch(undefined, { cyclic }, unversioned)).toEqual({
      ok: false,
      reason: "not-serializable",
    });
    expect(applyExtensionStatePatch(undefined, { big: 1n }, unversioned)).toEqual({
      ok: false,
      reason: "not-serializable",
    });
  });

  it("refuses a bag over the cap, measured in UTF-8 bytes", () => {
    const wide = "字".repeat(Math.floor((MAX_EXTENSION_STATE_BYTES * 2) / 3));
    const result = applyExtensionStatePatch(undefined, { wide }, unversioned);
    expect(result).toMatchObject({ ok: false, reason: "too-large" });
    if (!result.ok && result.reason === "too-large") {
      expect(result.bytes).toBeGreaterThan(MAX_EXTENSION_STATE_BYTES);
    }
  });

  it("lets a bag already over the cap shrink, but not grow", () => {
    const current = { huge: "x".repeat(MAX_EXTENSION_STATE_BYTES * 2) };
    expect(
      applyExtensionStatePatch(
        current,
        { huge: "x".repeat(MAX_EXTENSION_STATE_BYTES + 100) },
        unversioned
      ).ok
    ).toBe(true);
    expect(
      applyExtensionStatePatch(
        current,
        { huge: "x".repeat(MAX_EXTENSION_STATE_BYTES * 3) },
        unversioned
      ).ok
    ).toBe(false);
  });

  it("reports an identical re-persist as unchanged", () => {
    expect(applyExtensionStatePatch({ a: 1 }, { a: 1 }, { current: 2, next: 2 })).toEqual({
      ok: true,
      commit: { kind: "unchanged" },
    });
  });

  it("restamps identical bytes when the version moves", () => {
    expect(applyExtensionStatePatch({ a: 1 }, { a: 1 }, { current: 1, next: 2 })).toEqual({
      ok: true,
      commit: { kind: "restamp", version: 2 },
    });
  });

  it("stamps the next version on a changed bag", () => {
    expect(applyExtensionStatePatch({ a: 1 }, { a: 2 }, { current: 1, next: 3 })).toEqual({
      ok: true,
      commit: { kind: "replace", state: { a: 2 }, version: 3 },
    });
  });
});

describe("commitExtensionState", () => {
  it("treats a missing current bag as different from an empty one", () => {
    expect(commitExtensionState(undefined, "{}", undefined, undefined)).toEqual({
      kind: "replace",
      state: {},
      version: undefined,
    });
  });
});

describe("parseCanonical", () => {
  it("keeps a literal __proto__ key as data", () => {
    const parsed = parseCanonical('{"__proto__":{"polluted":true}}');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed)).toEqual(["__proto__"]);
  });
});
