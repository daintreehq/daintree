import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getActivityColor } from "../colorInterpolation";

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

  it("returns idle color for non-finite timestamp", () => {
    expect(getActivityColor(Infinity)).toBe("#52525b");
    expect(getActivityColor(NaN)).toBe("#52525b");
  });

  it("returns 100% accent at t=0 (immediate activity)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(getActivityColor(now)).toBe("color-mix(in oklab, #22c55e 100%, #52525b)");
  });

  it("clamps future timestamps to 100% accent (elapsed < 0)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(getActivityColor(now + 5_000)).toBe("color-mix(in oklab, #22c55e 100%, #52525b)");
  });

  it("returns ~50% mix at midpoint (45s)", () => {
    const start = Date.now();
    vi.setSystemTime(start + 45_000);
    const result = getActivityColor(start);
    expect(result).toBe("color-mix(in oklab, #22c55e 50%, #52525b)");
  });

  it("returns idle color at or beyond 90 seconds", () => {
    const start = Date.now();
    vi.setSystemTime(start + 90_000);
    expect(getActivityColor(start)).toBe("#52525b");

    vi.setSystemTime(start + 120_000);
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

    vi.setSystemTime(now + 120_000);
    expect(getActivityColor(now)).toBe("#112233");
  });
});
