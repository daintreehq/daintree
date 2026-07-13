import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ACTIVITY_HOLD_DURATION, DECAY_DURATION, getActivityColor } from "../colorInterpolation";

describe("getActivityColor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns idle color for null timestamp", () => {
    expect(getActivityColor(null)).toBe("#52525b");
  });

  it("returns idle color for undefined timestamp", () => {
    expect(getActivityColor(undefined)).toBe("#52525b");
  });

  it("returns idle color for invalid timestamps", () => {
    expect(getActivityColor(Infinity)).toBe("#52525b");
    expect(getActivityColor(NaN)).toBe("#52525b");
    expect(getActivityColor(0)).toBe("#52525b");
    expect(getActivityColor(-1)).toBe("#52525b");
  });

  it("returns 100% accent at t=0 (immediate activity)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(getActivityColor(now)).toBe("color-mix(in oklab, #22c55e 100%, #52525b)");
  });

  it("rejects future timestamps", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(getActivityColor(now + 5_000)).toBe("#52525b");
  });

  it("holds the full working colour through the initial window", () => {
    const start = Date.now();
    vi.setSystemTime(start + ACTIVITY_HOLD_DURATION);
    expect(getActivityColor(start)).toBe("color-mix(in oklab, #22c55e 100%, #52525b)");
  });

  it("returns an even mix at the midpoint of the fade window", () => {
    const start = Date.now();
    vi.setSystemTime(start + (ACTIVITY_HOLD_DURATION + DECAY_DURATION) / 2);
    const result = getActivityColor(start);
    expect(result).toBe("color-mix(in oklab, #22c55e 50%, #52525b)");
  });

  it("returns idle color at or beyond the idle boundary", () => {
    const start = Date.now();
    vi.setSystemTime(start + DECAY_DURATION);
    expect(getActivityColor(start)).toBe("#52525b");

    vi.setSystemTime(start + DECAY_DURATION * 2);
    expect(getActivityColor(start)).toBe("#52525b");
  });

  it("reads colors from CSS custom properties when document is available", () => {
    const mockGetPropertyValue = vi.fn((prop: string) => {
      if (prop === "--theme-activity-working") return "#aabbcc";
      if (prop === "--theme-activity-idle") return "#112233";
      return "";
    });
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: mockGetPropertyValue }));

    const now = Date.now();
    vi.setSystemTime(now);
    expect(getActivityColor(now)).toBe("color-mix(in oklab, #aabbcc 100%, #112233)");

    vi.setSystemTime(now + DECAY_DURATION);
    expect(getActivityColor(now)).toBe("#112233");
  });
});
