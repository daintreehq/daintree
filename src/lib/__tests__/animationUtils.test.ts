// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DURATION_75,
  DURATION_100,
  DURATION_150,
  DURATION_200,
  DURATION_250,
  DURATION_300,
  EASE_OUT_EXPO,
  EASE_SNAPPY,
  EASE_SPRING_CRITICAL,
  getPanelTransitionDuration,
  getUiAnimationDuration,
  getUiTransitionDuration,
  PANEL_MINIMIZE_DURATION,
  PANEL_RESTORE_DURATION,
  UI_ANIMATION_DURATION,
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "../animationUtils";

describe("motion token constants", () => {
  it("exposes the 75–300ms duration scale", () => {
    expect(DURATION_75).toBe(75);
    expect(DURATION_100).toBe(100);
    expect(DURATION_150).toBe(150);
    expect(DURATION_200).toBe(200);
    expect(DURATION_250).toBe(250);
    expect(DURATION_300).toBe(300);
  });

  it("exposes semantic easing tokens as valid CSS strings", () => {
    expect(EASE_SNAPPY).toMatch(/^cubic-bezier\(/);
    expect(EASE_OUT_EXPO).toMatch(/^cubic-bezier\(/);
    expect(EASE_SPRING_CRITICAL).toMatch(/^linear\(/);
  });
});

describe("getPanelTransitionDuration", () => {
  it("returns 120ms for minimize direction", () => {
    expect(getPanelTransitionDuration("minimize")).toBe(PANEL_MINIMIZE_DURATION);
    expect(getPanelTransitionDuration("minimize")).toBe(120);
  });

  it("returns 200ms for restore direction", () => {
    expect(getPanelTransitionDuration("restore")).toBe(PANEL_RESTORE_DURATION);
    expect(getPanelTransitionDuration("restore")).toBe(200);
  });

  it("ignores prefers-reduced-motion — CSS owns reduced-motion, not JS timers", () => {
    // WCAG 2.2 SC 2.3.3: remove motion via component-level @media overrides,
    // don't zero out the duration (that produces a spatial jump).
    const matchMediaSpy = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMediaSpy);

    try {
      expect(getPanelTransitionDuration("minimize")).toBe(120);
      expect(getPanelTransitionDuration("restore")).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("getUiTransitionDuration", () => {
  let matchMediaSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    matchMediaSpy = vi.fn().mockReturnValue({ matches: false });
    vi.stubGlobal("matchMedia", matchMediaSpy);
    document.body.dataset.performanceMode = "false";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.body.dataset.performanceMode;
  });

  it("returns 200ms for enter and 120ms for exit", () => {
    expect(getUiTransitionDuration("enter")).toBe(UI_ENTER_DURATION);
    expect(getUiTransitionDuration("enter")).toBe(200);
    expect(getUiTransitionDuration("exit")).toBe(UI_EXIT_DURATION);
    expect(getUiTransitionDuration("exit")).toBe(120);
  });

  it("still returns the full duration when prefers-reduced-motion is active", () => {
    matchMediaSpy.mockReturnValue({ matches: true });
    expect(getUiTransitionDuration("enter")).toBe(200);
    expect(getUiTransitionDuration("exit")).toBe(120);
  });

  it("returns 0 when performance mode is active (skip-timer signal)", () => {
    document.body.dataset.performanceMode = "true";
    expect(getUiTransitionDuration("enter")).toBe(0);
    expect(getUiTransitionDuration("exit")).toBe(0);
  });
});

describe("getUiAnimationDuration", () => {
  beforeEach(() => {
    document.body.dataset.performanceMode = "false";
  });

  afterEach(() => {
    delete document.body.dataset.performanceMode;
  });

  it("returns the UI animation token regardless of prefers-reduced-motion", () => {
    expect(getUiAnimationDuration()).toBe(UI_ANIMATION_DURATION);
    expect(getUiAnimationDuration()).toBe(150);
  });

  it("returns 0 when performance mode is active", () => {
    document.body.dataset.performanceMode = "true";
    expect(getUiAnimationDuration()).toBe(0);
  });
});

describe("spring easing constants", () => {
  it("exports valid easing strings", () => {
    expect(UI_ENTER_EASING).toMatch(/^linear\(/);
    expect(UI_EXIT_EASING).toMatch(/^cubic-bezier\(/);
  });

  it("uses asymmetric durations with exit faster than enter", () => {
    expect(UI_EXIT_DURATION).toBeLessThan(UI_ENTER_DURATION);
    expect(UI_EXIT_DURATION / UI_ENTER_DURATION).toBe(0.6);
  });
});
