// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPanelTransitionDuration,
  PANEL_MINIMIZE_DURATION,
  PANEL_RESTORE_DURATION,
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
