import { describe, expect, it } from "vitest";
import { normalizeTag, normalizeTags } from "../noteTags.js";

describe("normalizeTag", () => {
  it("lowercases and trims a tag", () => {
    expect(normalizeTag("  Auth  ")).toBe("auth");
  });
});

describe("normalizeTags", () => {
  it("returns empty array for undefined", () => {
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it("returns empty array for null", () => {
    expect(normalizeTags(null)).toEqual([]);
  });

  it("wraps a scalar string into an array", () => {
    expect(normalizeTags("auth")).toEqual(["auth"]);
  });

  it("normalizes an array of strings", () => {
    expect(normalizeTags(["Auth", " backend ", "AUTH"])).toEqual(["auth", "backend"]);
  });

  it("filters out empty and whitespace-only strings", () => {
    expect(normalizeTags([" ", "", "valid"])).toEqual(["valid"]);
  });

  it("returns empty array for non-string/non-array input", () => {
    expect(normalizeTags(42)).toEqual([]);
    expect(normalizeTags(true)).toEqual([]);
    expect(normalizeTags({})).toEqual([]);
  });

  it("skips non-string items in an array", () => {
    expect(normalizeTags(["auth", 42, null, "backend"])).toEqual(["auth", "backend"]);
  });
});
