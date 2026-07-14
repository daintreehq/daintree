// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runThemeReveal,
  runThemeCrossfade,
  prefersReducedMotion,
  THEME_WIPE_DURATION,
} from "../appThemeViewTransition";
import { UI_ENTER_DURATION } from "../animationUtils";

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
    document.body.dataset.reduceAnimations = "false";
    document.body.dataset.performanceMode = "false";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  afterEach(() => {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    delete (document as unknown as { activeViewTransition?: unknown }).activeViewTransition;
    delete document.body.dataset.reduceAnimations;
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

    it("returns true when reduce-animations is enabled", () => {
      document.body.dataset.reduceAnimations = "true";
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

    it("skips in-flight ViewTransition before starting a new one", () => {
      const skipTransition = vi.fn();
      (
        document as unknown as { activeViewTransition?: { skipTransition: () => void } }
      ).activeViewTransition = { skipTransition };
      const { startSpy } = installViewTransitionMock();

      runThemeReveal({ x: 100, y: 100 }, () => {});

      expect(skipTransition).toHaveBeenCalledTimes(1);
      expect(startSpy).toHaveBeenCalledTimes(1);
      const skipOrder = skipTransition.mock.invocationCallOrder[0]!;
      const startOrder = startSpy.mock.invocationCallOrder[0]!;
      expect(skipOrder).toBeLessThan(startOrder);
    });

    it("starts transition normally when no in-flight transition exists", () => {
      delete (document as unknown as { activeViewTransition?: unknown }).activeViewTransition;
      const { startSpy } = installViewTransitionMock();

      runThemeReveal({ x: 100, y: 100 }, () => {});

      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it("does not call skipTransition when reduced-motion fallback skips the transition", () => {
      const skipTransition = vi.fn();
      (
        document as unknown as { activeViewTransition?: { skipTransition: () => void } }
      ).activeViewTransition = { skipTransition };
      const { startSpy } = installViewTransitionMock();
      setReducedMotion(true);

      runThemeReveal({ x: 100, y: 100 }, () => {});

      expect(startSpy).not.toHaveBeenCalled();
      expect(skipTransition).not.toHaveBeenCalled();
    });

    it("does not call skipTransition when hidden-document fallback skips the transition", () => {
      const skipTransition = vi.fn();
      (
        document as unknown as { activeViewTransition?: { skipTransition: () => void } }
      ).activeViewTransition = { skipTransition };
      const { startSpy } = installViewTransitionMock();
      setVisibility("hidden");

      runThemeReveal({ x: 100, y: 100 }, () => {});

      expect(startSpy).not.toHaveBeenCalled();
      expect(skipTransition).not.toHaveBeenCalled();
    });
  });

  describe("runThemeCrossfade", () => {
    it("calls mutate synchronously when startViewTransition is unavailable", () => {
      const mutate = vi.fn();
      runThemeCrossfade(mutate);
      expect(mutate).toHaveBeenCalledTimes(1);
    });

    it("skips the transition when prefers-reduced-motion is set", () => {
      const { startSpy } = installViewTransitionMock();
      setReducedMotion(true);
      const mutate = vi.fn();

      runThemeCrossfade(mutate);

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
    });

    it("skips the transition when performance mode is enabled", () => {
      const { startSpy } = installViewTransitionMock();
      document.body.dataset.performanceMode = "true";
      const mutate = vi.fn();

      runThemeCrossfade(mutate);

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
    });

    it("skips the transition when the document is hidden", () => {
      const { startSpy } = installViewTransitionMock();
      setVisibility("hidden");
      const mutate = vi.fn();

      runThemeCrossfade(mutate);

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
    });

    it("defers mutate to the transition's update callback when guards pass", () => {
      const { startSpy, capturedMutate } = installViewTransitionMock();
      const mutate = vi.fn();

      runThemeCrossfade(mutate);

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(mutate).not.toHaveBeenCalled();
      capturedMutate()?.();
      expect(mutate).toHaveBeenCalledTimes(1);
    });

    it("does not animate before the ready promise settles", () => {
      const { animateSpy } = installViewTransitionMock();

      runThemeCrossfade(() => {});

      expect(animateSpy).not.toHaveBeenCalled();
    });

    it("fades the old root snapshot out rather than wiping it", async () => {
      const { animateSpy } = installViewTransitionMock();

      runThemeCrossfade(() => {});
      await Promise.resolve();

      expect(animateSpy).toHaveBeenCalledTimes(1);
      const [keyframes, options] = animateSpy.mock.calls[0]!;
      // Opacity only — a clip-path here would encode a direction the programmatic
      // path has no gesture origin for.
      expect(keyframes).toEqual({ opacity: [1, 0] });
      expect(options).toMatchObject({
        pseudoElement: "::view-transition-old(root)",
        duration: UI_ENTER_DURATION,
        easing: "ease-out",
        fill: "forwards",
      });
    });

    it("leaves the new root snapshot untouched (its opacity is the crossfade)", async () => {
      const { animateSpy } = installViewTransitionMock();

      runThemeCrossfade(() => {});
      await Promise.resolve();

      const targets = animateSpy.mock.calls.map(([, options]) => options.pseudoElement);
      expect(targets).not.toContain("::view-transition-new(root)");
    });

    it("is briefer than the deliberate-pick wipe", () => {
      expect(UI_ENTER_DURATION).toBeLessThan(THEME_WIPE_DURATION);
    });

    it("skips an in-flight ViewTransition before starting a new one", () => {
      const skipTransition = vi.fn();
      (
        document as unknown as { activeViewTransition?: { skipTransition: () => void } }
      ).activeViewTransition = { skipTransition };
      const { startSpy } = installViewTransitionMock();

      runThemeCrossfade(() => {});

      expect(skipTransition).toHaveBeenCalledTimes(1);
      expect(startSpy).toHaveBeenCalledTimes(1);
      const skipOrder = skipTransition.mock.invocationCallOrder[0]!;
      const startOrder = startSpy.mock.invocationCallOrder[0]!;
      expect(skipOrder).toBeLessThan(startOrder);
    });

    it("does not call skipTransition when a guard skips the transition", () => {
      const skipTransition = vi.fn();
      (
        document as unknown as { activeViewTransition?: { skipTransition: () => void } }
      ).activeViewTransition = { skipTransition };
      const { startSpy } = installViewTransitionMock();
      setReducedMotion(true);

      runThemeCrossfade(() => {});

      expect(startSpy).not.toHaveBeenCalled();
      expect(skipTransition).not.toHaveBeenCalled();
    });

    it("swallows ready-promise rejections without throwing", async () => {
      const rejected = Promise.reject(new Error("aborted"));
      rejected.catch(() => {});
      (document as unknown as { startViewTransition: unknown }).startViewTransition = vi.fn(() => ({
        ready: rejected,
        finished: Promise.resolve(),
      }));

      expect(() => runThemeCrossfade(() => {})).not.toThrow();
      await rejected.catch(() => {});
    });
  });
});
