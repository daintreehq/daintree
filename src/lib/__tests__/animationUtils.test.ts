// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPanelTransitionDuration,
  getUiTransitionDuration,
  PANEL_MINIMIZE_DURATION,
  PANEL_RESTORE_DURATION,
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "../animationUtils";

describe("getPanelTransitionDuration", () => {
  let matchMediaSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    matchMediaSpy = vi.fn().mockReturnValue({ matches: false });
    vi.stubGlobal("matchMedia", matchMediaSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 120ms for minimize direction", () => {
    expect(getPanelTransitionDuration("minimize")).toBe(PANEL_MINIMIZE_DURATION);
    expect(getPanelTransitionDuration("minimize")).toBe(120);
  });

  it("returns 200ms for restore direction", () => {
    expect(getPanelTransitionDuration("restore")).toBe(PANEL_RESTORE_DURATION);
    expect(getPanelTransitionDuration("restore")).toBe(200);
  });

  it("returns 0 for both directions when prefers-reduced-motion is active", () => {
    matchMediaSpy.mockReturnValue({ matches: true });

    expect(getPanelTransitionDuration("minimize")).toBe(0);
    expect(getPanelTransitionDuration("restore")).toBe(0);
  });

  it("queries the correct media query", () => {
    getPanelTransitionDuration("minimize");
    expect(matchMediaSpy).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
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

  it("returns 0 when prefers-reduced-motion is active", () => {
    matchMediaSpy.mockReturnValue({ matches: true });
    expect(getUiTransitionDuration("enter")).toBe(0);
    expect(getUiTransitionDuration("exit")).toBe(0);
  });

  it("returns 0 when performance mode is active", () => {
    document.body.dataset.performanceMode = "true";
    expect(getUiTransitionDuration("enter")).toBe(0);
    expect(getUiTransitionDuration("exit")).toBe(0);
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
