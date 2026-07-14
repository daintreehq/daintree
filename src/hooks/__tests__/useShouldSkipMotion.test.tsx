// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const prefersReducedMotion = vi.hoisted(() => ({ current: false as boolean | null }));

vi.mock("framer-motion", () => ({
  useReducedMotion: () => prefersReducedMotion.current,
}));

import {
  shouldSkipMotion,
  useShouldSkipMotion,
  useUiMotionTransition,
} from "@/hooks/useShouldSkipMotion";

afterEach(() => {
  prefersReducedMotion.current = false;
  delete document.body.dataset.reduceAnimations;
  delete document.body.dataset.performanceMode;
});

describe("shouldSkipMotion", () => {
  it("animates only when every signal is off", () => {
    expect(
      shouldSkipMotion({
        prefersReducedMotion: false,
        reduceAnimations: false,
        performanceMode: false,
      })
    ).toBe(false);
  });

  it("treats an unresolved OS media query as 'not reduced'", () => {
    expect(
      shouldSkipMotion({
        prefersReducedMotion: null,
        reduceAnimations: false,
        performanceMode: false,
      })
    ).toBe(false);
  });

  it.each([
    ["OS reduced motion", { prefersReducedMotion: true }],
    ["the in-app reduce-animations preference", { reduceAnimations: true }],
    ["performance mode", { performanceMode: true }],
  ])("skips motion when %s is on, independent of the others", (_label, signal) => {
    expect(
      shouldSkipMotion({
        prefersReducedMotion: false,
        reduceAnimations: false,
        performanceMode: false,
        ...signal,
      })
    ).toBe(true);
  });
});

describe("useShouldSkipMotion", () => {
  it("reads both app flags off document.body", () => {
    expect(renderHook(() => useShouldSkipMotion()).result.current).toBe(false);

    document.body.dataset.reduceAnimations = "true";
    expect(renderHook(() => useShouldSkipMotion()).result.current).toBe(true);

    delete document.body.dataset.reduceAnimations;
    document.body.dataset.performanceMode = "true";
    expect(renderHook(() => useShouldSkipMotion()).result.current).toBe(true);
  });

  it('ignores body flags that are present but not exactly "true"', () => {
    document.body.dataset.reduceAnimations = "false";
    document.body.dataset.performanceMode = "";
    expect(renderHook(() => useShouldSkipMotion()).result.current).toBe(false);
  });

  it("re-reads the body flags on every render rather than caching at mount", () => {
    const { result, rerender } = renderHook(() => useShouldSkipMotion());
    expect(result.current).toBe(false);

    document.body.dataset.performanceMode = "true";
    rerender();

    expect(result.current).toBe(true);
  });

  it("follows the OS media query", () => {
    prefersReducedMotion.current = true;
    expect(renderHook(() => useShouldSkipMotion()).result.current).toBe(true);
  });
});

describe("useUiMotionTransition", () => {
  it("emits a non-zero duration in seconds when motion is allowed", () => {
    const { duration } = renderHook(() => useUiMotionTransition()).result.current;

    expect(duration).toBeGreaterThan(0);
    // framer takes seconds; the shared tier is defined in ms, so a value >= 1
    // means the conversion was dropped and the thumb would crawl for seconds.
    expect(duration).toBeLessThan(1);
  });

  it("collapses to an instant transition when motion is skipped", () => {
    document.body.dataset.performanceMode = "true";

    expect(renderHook(() => useUiMotionTransition()).result.current.duration).toBe(0);
  });

  it("keeps the shared easing curve in both modes", () => {
    const animated = renderHook(() => useUiMotionTransition()).result.current;

    document.body.dataset.reduceAnimations = "true";
    const instant = renderHook(() => useUiMotionTransition()).result.current;

    expect(instant.ease).toEqual(animated.ease);
  });
});
