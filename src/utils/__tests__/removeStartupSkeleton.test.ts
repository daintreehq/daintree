// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_EXIT_DURATION } from "../../lib/animationUtils";

describe("removeStartupSkeleton", () => {
  let rafQueue: FrameRequestCallback[];
  let notifyFirstInteractive: ReturnType<typeof vi.fn>;
  let matchesReducedMotion: boolean;

  beforeEach(async () => {
    vi.resetModules();
    rafQueue = [];
    notifyFirstInteractive = vi.fn(() => Promise.resolve());
    matchesReducedMotion = false;

    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });

    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? matchesReducedMotion : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    (
      window as unknown as { electron: { app: { notifyFirstInteractive: () => Promise<void> } } }
    ).electron = {
      app: { notifyFirstInteractive: notifyFirstInteractive as unknown as () => Promise<void> },
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    document.getElementById("startup-skeleton")?.remove();
    delete (document as { startViewTransition?: unknown }).startViewTransition;
    delete document.body.dataset.performanceMode;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  function addSkeleton(): HTMLDivElement {
    const el = document.createElement("div");
    el.id = "startup-skeleton";
    document.body.appendChild(el);
    return el;
  }

  function flushRaf() {
    const batch = rafQueue.splice(0);
    for (const cb of batch) cb(performance.now());
  }

  it("falls back to fade-out class + UI_EXIT_DURATION setTimeout when startViewTransition is unavailable", async () => {
    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    const el = addSkeleton();
    removeStartupSkeleton();

    expect(el.classList.contains("fade-out")).toBe(false);
    expect(notifyFirstInteractive).not.toHaveBeenCalled();

    flushRaf(); // outer RAF — schedules inner
    expect(el.classList.contains("fade-out")).toBe(false);
    expect(notifyFirstInteractive).not.toHaveBeenCalled();

    flushRaf(); // inner RAF — fires signal, adds fade-out, schedules setTimeout
    expect(el.classList.contains("fade-out")).toBe(true);
    expect(el.getAttribute("aria-busy")).toBe("false");
    expect(notifyFirstInteractive).toHaveBeenCalledTimes(1);
    expect(document.getElementById("startup-skeleton")).toBe(el);

    vi.advanceTimersByTime(UI_EXIT_DURATION);
    expect(document.getElementById("startup-skeleton")).toBeNull();
  });

  it("uses startViewTransition and removes the skeleton inside its callback when available", async () => {
    let capturedCallback: (() => void) | null = null;
    const startViewTransition = vi.fn((cb: () => void) => {
      capturedCallback = cb;
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    });
    (
      document as unknown as { startViewTransition: typeof startViewTransition }
    ).startViewTransition = startViewTransition;

    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    const el = addSkeleton();
    removeStartupSkeleton();

    flushRaf();
    flushRaf();

    expect(notifyFirstInteractive).toHaveBeenCalledTimes(1);
    expect(el.getAttribute("aria-busy")).toBe("false");
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(document.getElementById("startup-skeleton")).toBe(el);
    // No fallback setTimeout was scheduled — advancing the timer is a no-op
    vi.advanceTimersByTime(UI_EXIT_DURATION);
    expect(document.getElementById("startup-skeleton")).toBe(el);

    expect(capturedCallback).toBeTypeOf("function");
    capturedCallback!();
    expect(document.getElementById("startup-skeleton")).toBeNull();
  });

  it("animates ::view-transition-old(root) opacity over UI_EXIT_DURATION on transition.ready", async () => {
    const startViewTransition = vi.fn(() => ({
      ready: Promise.resolve(),
      finished: Promise.resolve(),
    }));
    (
      document as unknown as { startViewTransition: typeof startViewTransition }
    ).startViewTransition = startViewTransition;

    const animate = vi.fn();
    const originalAnimate = (document.documentElement as unknown as { animate?: unknown }).animate;
    (document.documentElement as unknown as { animate: typeof animate }).animate = animate;

    try {
      const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
      addSkeleton();
      removeStartupSkeleton();

      flushRaf();
      flushRaf();

      // transition.ready resolves microtask-async; flush the queue so the
      // .then handler that drives the WAAPI animation runs before assertions.
      await Promise.resolve();
      await Promise.resolve();

      expect(animate).toHaveBeenCalledTimes(1);
      const call = animate.mock.calls[0];
      expect(call).toBeDefined();
      const [keyframes, options] = call!;
      expect(keyframes).toEqual({ opacity: [1, 0] });
      expect(options).toMatchObject({
        duration: UI_EXIT_DURATION,
        pseudoElement: "::view-transition-old(root)",
        fill: "forwards",
      });
    } finally {
      (document.documentElement as unknown as { animate?: unknown }).animate = originalAnimate;
    }
  });

  it("skips the View Transitions path when prefers-reduced-motion is set", async () => {
    matchesReducedMotion = true;
    const startViewTransition = vi.fn();
    (
      document as unknown as { startViewTransition: typeof startViewTransition }
    ).startViewTransition = startViewTransition;

    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    const el = addSkeleton();
    removeStartupSkeleton();

    flushRaf();
    flushRaf();

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(el.classList.contains("fade-out")).toBe(true);
    vi.advanceTimersByTime(UI_EXIT_DURATION);
    expect(document.getElementById("startup-skeleton")).toBeNull();
  });

  it("skips the View Transitions path when performance mode is enabled", async () => {
    document.body.dataset.performanceMode = "true";
    const startViewTransition = vi.fn();
    (
      document as unknown as { startViewTransition: typeof startViewTransition }
    ).startViewTransition = startViewTransition;

    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    const el = addSkeleton();
    removeStartupSkeleton();

    flushRaf();
    flushRaf();

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(el.classList.contains("fade-out")).toBe(true);
    vi.advanceTimersByTime(UI_EXIT_DURATION);
    expect(document.getElementById("startup-skeleton")).toBeNull();
  });

  it("signals first-interactive even when skeleton is absent", async () => {
    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    removeStartupSkeleton();
    expect(rafQueue.length).toBe(0);
    expect(notifyFirstInteractive).toHaveBeenCalledTimes(1);
  });

  it("only notifies first-interactive once across repeated calls", async () => {
    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    addSkeleton();
    removeStartupSkeleton();
    removeStartupSkeleton();

    flushRaf(); // both outer RAFs run
    flushRaf(); // both inner RAFs run

    expect(notifyFirstInteractive).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(UI_EXIT_DURATION);
    expect(document.getElementById("startup-skeleton")).toBeNull();

    removeStartupSkeleton(); // no-op, should not throw
    expect(notifyFirstInteractive).toHaveBeenCalledTimes(1);
  });

  it("swallows errors from the IPC bridge", async () => {
    const throwing = vi.fn(() => {
      throw new Error("bridge unavailable");
    });
    (
      window as unknown as { electron: { app: { notifyFirstInteractive: () => Promise<void> } } }
    ).electron = {
      app: { notifyFirstInteractive: throwing as unknown as () => Promise<void> },
    };
    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    expect(() => removeStartupSkeleton()).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
  });
});
