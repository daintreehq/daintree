// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runThemeReveal, prefersReducedMotion } from "../appThemeViewTransition";

interface MockTransition {
  ready: Promise<void>;
  finished: Promise<void>;
}

function installViewTransitionMock(): {
  startSpy: ReturnType<typeof vi.fn>;
  animateSpy: ReturnType<typeof vi.fn>;
  capturedMutate: () => (() => void) | null;
} {
  let captured: (() => void) | null = null;
  const startSpy = vi.fn((callback: () => void): MockTransition => {
    captured = callback;
    return {
      ready: Promise.resolve(),
      finished: Promise.resolve(),
    };
  });
  (document as unknown as { startViewTransition: typeof startSpy }).startViewTransition = startSpy;

  const animateSpy = vi.fn();
  document.documentElement.animate =
    animateSpy as unknown as typeof document.documentElement.animate;

  return { startSpy, animateSpy, capturedMutate: () => captured };
}

function setReducedMotion(reduced: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("appThemeViewTransition", () => {
  beforeEach(() => {
    setReducedMotion(false);
    setVisibility("visible");
    document.body.dataset.performanceMode = "false";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  afterEach(() => {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    delete document.body.dataset.performanceMode;
    vi.restoreAllMocks();
  });

  describe("prefersReducedMotion", () => {
    it("returns true when media query matches", () => {
      setReducedMotion(true);
      expect(prefersReducedMotion()).toBe(true);
    });

    it("returns true when performance mode is enabled", () => {
      document.body.dataset.performanceMode = "true";
      expect(prefersReducedMotion()).toBe(true);
    });

    it("returns false when neither reduced motion nor performance mode is set", () => {
      expect(prefersReducedMotion()).toBe(false);
    });
  });

  describe("runThemeReveal", () => {
    it("calls mutate synchronously when startViewTransition is unavailable", () => {
      const mutate = vi.fn();
      runThemeReveal({ x: 100, y: 100 }, mutate);
      expect(mutate).toHaveBeenCalledTimes(1);
    });

    it("skips the transition when prefers-reduced-motion is set", () => {
      const { startSpy } = installViewTransitionMock();
      setReducedMotion(true);
      const mutate = vi.fn();

      runThemeReveal({ x: 100, y: 100 }, mutate);

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
    });

    it("skips the transition when the document is hidden", () => {
      const { startSpy } = installViewTransitionMock();
      setVisibility("hidden");
      const mutate = vi.fn();

      runThemeReveal({ x: 100, y: 100 }, mutate);

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
    });

    it("invokes startViewTransition with the mutate callback when guards pass", () => {
      const { startSpy, capturedMutate } = installViewTransitionMock();
      const mutate = vi.fn();

      runThemeReveal({ x: 100, y: 100 }, mutate);

      expect(startSpy).toHaveBeenCalledTimes(1);
      // The library defers mutate until the browser invokes the callback.
      expect(mutate).not.toHaveBeenCalled();
      capturedMutate()?.();
      expect(mutate).toHaveBeenCalledTimes(1);
    });

    it("animates the new root pseudo with a circle clip-path to the farthest corner", async () => {
      const { animateSpy } = installViewTransitionMock();
      // Origin at (0,0) on a 1000x800 viewport → radius = hypot(1000, 800)
      const expected = Math.hypot(1000, 800);

      runThemeReveal({ x: 0, y: 0 }, () => {});
      await Promise.resolve();

      expect(animateSpy).toHaveBeenCalledTimes(1);
      const [keyframes, options] = animateSpy.mock.calls[0];
      expect(keyframes).toEqual({
        clipPath: [`circle(0px at 0px 0px)`, `circle(${expected}px at 0px 0px)`],
      });
      expect(options).toMatchObject({
        pseudoElement: "::view-transition-new(root)",
        duration: 350,
      });
    });

    it("falls back to viewport center when origin is null", async () => {
      const { animateSpy } = installViewTransitionMock();
      // Center (500, 400) on 1000x800 → radius = hypot(500, 400)
      const expected = Math.hypot(500, 400);

      runThemeReveal(null, () => {});
      await Promise.resolve();

      const [keyframes] = animateSpy.mock.calls[0];
      expect(keyframes.clipPath[1]).toBe(`circle(${expected}px at 500px 400px)`);
    });

    it("swallows ready-promise rejections without throwing", async () => {
      const rejected = Promise.reject(new Error("aborted"));
      // Prevent unhandled rejection noise by attaching a handler before the tick.
      rejected.catch(() => {});
      (document as unknown as { startViewTransition: unknown }).startViewTransition = vi.fn(() => ({
        ready: rejected,
        finished: Promise.resolve(),
      }));

      expect(() => runThemeReveal({ x: 0, y: 0 }, () => {})).not.toThrow();
      await rejected.catch(() => {});
    });
  });
});
