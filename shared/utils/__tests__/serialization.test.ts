import { describe, expect, it } from "vitest";
import { ensureSerializable, validateSerializable } from "../serialization.js";

describe("serialization failure handling", () => {
  it("reports circular data as invalid and throws a usable serialization error", () => {
    const data: { self?: unknown } = {};
    data.self = data;

    expect(validateSerializable(data)).toMatchObject({
      valid: false,
      error: expect.stringMatching(/circular/i),
    });
    expect(() => ensureSerializable(data)).toThrow(/circular/i);
  });

  it("normalizes a non-Error thrown by a custom serializer", () => {
    const data = {
      toJSON() {
        throw { message: "Cannot serialize this record" };
      },
    };

    expect(validateSerializable(data)).toEqual({
      valid: false,
      error: "Cannot serialize this record",
    });
    expect(() => ensureSerializable(data)).toThrow("Cannot serialize this record");
  });
});
