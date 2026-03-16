import { describe, it, expect } from "vitest";
import { resolveAICorrectionRange } from "../useVoiceDecorations";

describe("resolveAICorrectionRange", () => {
  it("returns null for empty text", () => {
    expect(resolveAICorrectionRange("hello world", 0, "")).toBeNull();
  });

  it("matches exact position", () => {
    const result = resolveAICorrectionRange("hello world", 6, "world");
    expect(result).toEqual({ from: 6, to: 11 });
  });

  it("matches nearby when exact fails", () => {
    const doc = "hello world";
    // segmentStart is 0 but "world" starts at 6 — within the 32-char radius
    const result = resolveAICorrectionRange(doc, 0, "world");
    expect(result).toEqual({ from: 6, to: 11 });
  });

  it("matches globally when unique", () => {
    const doc = "some text before hello and after";
    const result = resolveAICorrectionRange(doc, 100, "hello");
    expect(result).toEqual({ from: 17, to: 22 });
  });

  it("returns null when not found and not unique", () => {
    const doc = "hello hello";
    // segmentStart is way past doc length, text is not unique
    const result = resolveAICorrectionRange(doc, 100, "hello");
    expect(result).toBeNull();
  });

  it("returns null when text not in doc at all", () => {
    const result = resolveAICorrectionRange("hello world", 0, "xyz");
    expect(result).toBeNull();
  });
});
