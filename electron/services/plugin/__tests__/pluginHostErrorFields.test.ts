import { describe, expect, it } from "vitest";
import { errorWithFields, serializableErrorFields } from "../pluginHostErrorFields.js";

describe("serializableErrorFields", () => {
  it("forwards only the allowlisted fields", () => {
    const error = Object.assign(new Error("REVISION_MISMATCH: changed"), {
      code: "REVISION_MISMATCH",
      currentRevision: "abc",
      path: "/Users/me/secret",
      token: "t0k",
    });
    expect(serializableErrorFields(error)).toEqual({
      code: "REVISION_MISMATCH",
      currentRevision: "abc",
    });
  });

  it("survives a throwing getter instead of failing the report", () => {
    const error = new Error("boom");
    Object.defineProperty(error, "code", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(() => serializableErrorFields(error)).not.toThrow();
    expect(serializableErrorFields(error)).toBeUndefined();
  });

  it("drops oversized strings and non-primitives", () => {
    const error = Object.assign(new Error("x"), {
      code: "a".repeat(2000),
      currentRevision: { nested: true },
    });
    expect(serializableErrorFields(error)).toBeUndefined();
  });

  it("returns undefined for non-objects", () => {
    expect(serializableErrorFields("boom")).toBeUndefined();
    expect(serializableErrorFields(null)).toBeUndefined();
  });
});

describe("errorWithFields", () => {
  it("round-trips what the bridge serialised", () => {
    const original = Object.assign(new Error("conflict"), {
      code: "REVISION_MISMATCH",
      currentRevision: "abc",
    });
    const rebuilt = errorWithFields(original.message, serializableErrorFields(original));
    expect(rebuilt).toMatchObject({ code: "REVISION_MISMATCH", currentRevision: "abc" });
  });

  it("ignores fields outside the allowlist", () => {
    const rebuilt = errorWithFields("m", { code: "X", injected: "y" } as never);
    expect(rebuilt).not.toHaveProperty("injected");
    expect(rebuilt.message).toBe("m");
  });
});
