import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the scroll-to-section retry logic used in SettingsDialog (issue #4060).
 *
 * The tryScroll function retries via requestAnimationFrame until the target
 * element is both present in the DOM and visible (offsetParent !== null).
 * This is necessary because tab panels use display:none (Tailwind "hidden"
 * class) until React commits the activeTab state change.
 */

type TryScrollFn = () => void;

function createTryScroll(opts: {
  getElementById: (id: string) => {
    offsetParent: Element | null;
    scrollIntoView: (options?: ScrollIntoViewOptions) => void;
    querySelector: <T extends Element>(selector: string) => T | null;
    classList: { add: (cls: string) => void; remove: (cls: string) => void };
  } | null;
  sectionId: string;
  maxAttempts?: number;
  onFrame: (cb: FrameRequestCallback) => number;
}): { tryScroll: TryScrollFn; getAttempts: () => number } {
  const { getElementById, sectionId, maxAttempts = 20, onFrame } = opts;
  let attempt = 0;

  const tryScroll: TryScrollFn = () => {
    const el = getElementById(sectionId);
    if (el && el.offsetParent !== null) {
      el.scrollIntoView({ behavior: "instant", block: "start" });
      el.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
      el.classList.add("settings-highlight");
      return;
    }
    attempt++;
    if (attempt < maxAttempts) {
      onFrame(tryScroll);
    }
  };

  return { tryScroll, getAttempts: () => attempt };
}

describe("Settings scroll-to-section retry logic", () => {
  let rafCallbacks: FrameRequestCallback[];
  let frameId: number;
  const onFrame = (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return ++frameId;
  };

  beforeEach(() => {
    rafCallbacks = [];
    frameId = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call scrollIntoView when element is not found", () => {
    const { tryScroll, getAttempts } = createTryScroll({
      getElementById: () => null,
      sectionId: "section-font-size",
      onFrame,
    });

    tryScroll();
    expect(getAttempts()).toBe(1);
    expect(rafCallbacks).toHaveLength(1);
  });

  it("does not call scrollIntoView when element has offsetParent === null (hidden)", () => {
    const scrollIntoView = vi.fn();
    const mockEl = {
      offsetParent: null,
      scrollIntoView,
      querySelector: () => null,
      classList: { add: vi.fn(), remove: vi.fn() },
    };

    const { tryScroll } = createTryScroll({
      getElementById: () => mockEl,
      sectionId: "section-font-size",
      onFrame,
    });

    tryScroll();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(rafCallbacks).toHaveLength(1);
  });

  it("calls scrollIntoView with instant behavior when element is visible", () => {
    const scrollIntoView = vi.fn();
    const classList = { add: vi.fn(), remove: vi.fn() };
    const mockEl = {
      offsetParent: {} as Element,
      scrollIntoView,
      querySelector: () => null,
      classList,
    };

    const { tryScroll, getAttempts } = createTryScroll({
      getElementById: () => mockEl,
      sectionId: "section-font-size",
      onFrame,
    });

    tryScroll();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
    expect(classList.add).toHaveBeenCalledWith("settings-highlight");
    expect(getAttempts()).toBe(0);
    expect(rafCallbacks).toHaveLength(0);
  });

  it("retries until element becomes visible", () => {
    const scrollIntoView = vi.fn();
    const classList = { add: vi.fn(), remove: vi.fn() };
    let visible = false;
    const mockEl = {
      get offsetParent() {
        return visible ? ({} as Element) : null;
      },
      scrollIntoView,
      querySelector: () => null,
      classList,
    };

    const { tryScroll, getAttempts } = createTryScroll({
      getElementById: () => mockEl,
      sectionId: "section-font-size",
      onFrame,
    });

    tryScroll();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(rafCallbacks).toHaveLength(1);

    // Simulate element becoming visible on next frame
    visible = true;
    rafCallbacks[0](performance.now());

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
    expect(getAttempts()).toBe(1);
  });

  it("stops retrying after maxAttempts", () => {
    const { tryScroll, getAttempts } = createTryScroll({
      getElementById: () => null,
      sectionId: "section-nonexistent",
      maxAttempts: 3,
      onFrame,
    });

    tryScroll();
    // Drain all frames
    while (rafCallbacks.length > 0) {
      const cb = rafCallbacks.shift()!;
      cb(performance.now());
    }

    expect(getAttempts()).toBe(3);
    expect(rafCallbacks).toHaveLength(0);
  });

  it("focuses input inside the section when found", () => {
    const focus = vi.fn();
    const mockEl = {
      offsetParent: {} as Element,
      scrollIntoView: vi.fn(),
      querySelector: (selector: string) => (selector === "input" ? { focus } : null),
      classList: { add: vi.fn(), remove: vi.fn() },
    };

    const { tryScroll } = createTryScroll({
      getElementById: () => mockEl,
      sectionId: "section-font-size",
      onFrame,
    });

    tryScroll();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
