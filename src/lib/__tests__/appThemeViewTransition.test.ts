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
      expect(mutate).not.toHaveBeenCalled();
      capturedMutate()?.();
      expect(mutate).toHaveBeenCalledTimes(1);
    });

    it("wipes left-to-right when click is on the left side", async () => {
      const { animateSpy } = installViewTransitionMock();

      runThemeReveal({ x: 100, y: 400 }, () => {});
      await Promise.resolve();

      expect(animateSpy).toHaveBeenCalledTimes(1);
      const [keyframes, options] = animateSpy.mock.calls[0]!;
      expect(keyframes).toEqual({
        clipPath: ["inset(0 0 0 0)", "inset(0 0 0 100%)"],
      });
      expect(options).toMatchObject({
        pseudoElement: "::view-transition-old(root)",
        duration: 400,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        fill: "forwards",
      });
    });

    it("wipes right-to-left when click is on the right side", async () => {
      const { animateSpy } = installViewTransitionMock();

      runThemeReveal({ x: 800, y: 400 }, () => {});
      await Promise.resolve();

      const [keyframes] = animateSpy.mock.calls[0]!;
      expect(keyframes).toEqual({
        clipPath: ["inset(0 0 0 0)", "inset(0 100% 0 0)"],
      });
    });

    it("defaults to left-to-right wipe when origin is null", async () => {
      const { animateSpy } = installViewTransitionMock();

      runThemeReveal(null, () => {});
      await Promise.resolve();

      const [keyframes] = animateSpy.mock.calls[0]!;
      expect(keyframes).toEqual({
        clipPath: ["inset(0 0 0 0)", "inset(0 0 0 100%)"],
      });
    });

    it("swallows ready-promise rejections without throwing", async () => {
      const rejected = Promise.reject(new Error("aborted"));
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
