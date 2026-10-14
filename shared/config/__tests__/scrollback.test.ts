import { describe, it, expect } from "vitest";
import {
  normalizeScrollbackLines,
  SCROLLBACK_DEFAULT,
  SCROLLBACK_MIN,
  SCROLLBACK_MAX,
} from "../scrollback.js";

describe("normalizeScrollbackLines", () => {
  it("returns default for non-numeric input", () => {
    expect(normalizeScrollbackLines("not-a-number")).toBe(SCROLLBACK_DEFAULT);
    expect(normalizeScrollbackLines(undefined)).toBe(SCROLLBACK_DEFAULT);
    expect(normalizeScrollbackLines(null)).toBe(SCROLLBACK_DEFAULT);
  });

  it("coerces numeric strings", () => {
    expect(normalizeScrollbackLines("2500")).toBe(2500);
  });

  it("truncates floats", () => {
    expect(normalizeScrollbackLines(123.9)).toBe(123);
  });

  it("maps -1 and 0 to max", () => {
    expect(normalizeScrollbackLines(-1)).toBe(SCROLLBACK_MAX);
    expect(normalizeScrollbackLines(0)).toBe(SCROLLBACK_MAX);
  });

  it("clamps to min and max", () => {
    expect(normalizeScrollbackLines(SCROLLBACK_MIN - 1)).toBe(SCROLLBACK_MIN);
    expect(normalizeScrollbackLines(SCROLLBACK_MAX + 1)).toBe(SCROLLBACK_MAX);
  });
});
