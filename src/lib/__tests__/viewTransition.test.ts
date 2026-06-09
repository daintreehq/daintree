// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withViewTransition, supportsViewTransitions } from "../viewTransition";

interface MockTransition {
  ready: Promise<void>;
  finished: Promise<void>;
}

function installDocumentTransitionMock(): { startSpy: ReturnType<typeof vi.fn> } {
  const startSpy = vi.fn((callback: () => void): MockTransition => {
    callback();
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  });
  (document as unknown as { startViewTransition: typeof startSpy }).startViewTransition = startSpy;
  return { startSpy };
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
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("withViewTransition", () => {
  beforeEach(() => {
    setReducedMotion(false);
    setVisibility("visible");
    document.body.dataset.reduceAnimations = "false";
    document.body.dataset.performanceMode = "false";
  });

  afterEach(() => {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    delete (document as unknown as { activeViewTransition?: unknown }).activeViewTransition;
    delete document.body.dataset.reduceAnimations;
    delete document.body.dataset.performanceMode;
    vi.restoreAllMocks();
  });

  it("runs the mutation and returns null when the API is unavailable", () => {
    const mutate = vi.fn();
    expect(supportsViewTransitions()).toBe(false);
    const result = withViewTransition(mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it("falls back to a plain mutation when reduced motion is preferred", () => {
    const { startSpy } = installDocumentTransitionMock();
    setReducedMotion(true);
    const mutate = vi.fn();

    const result = withViewTransition(mutate);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("falls back to a plain mutation when the document is hidden", () => {
    const { startSpy } = installDocumentTransitionMock();
    setVisibility("hidden");
    const mutate = vi.fn();

    const result = withViewTransition(mutate);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("drives the document View Transition when guards pass", () => {
    const { startSpy } = installDocumentTransitionMock();
    const mutate = vi.fn();

    const result = withViewTransition(mutate);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1); // the mock invokes the callback
    expect(result).not.toBeNull();
    expect(supportsViewTransitions()).toBe(true);
  });

  it("ends an in-flight transition before starting a new one", () => {
    const skipTransition = vi.fn();
    (
      document as unknown as { activeViewTransition?: { skipTransition: () => void } }
    ).activeViewTransition = { skipTransition };
    const { startSpy } = installDocumentTransitionMock();

    withViewTransition(vi.fn());

    expect(skipTransition).toHaveBeenCalledTimes(1);
    expect(skipTransition.mock.invocationCallOrder[0]!).toBeLessThan(
      startSpy.mock.invocationCallOrder[0]!
    );
  });

  it("uses the element-scoped API when a scope element is provided", () => {
    const { startSpy: docStart } = installDocumentTransitionMock();
    const el = document.createElement("div");
    const elStart = vi.fn((callback: () => void) => {
      callback();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    });
    (el as unknown as { startViewTransition: typeof elStart }).startViewTransition = elStart;
    const mutate = vi.fn();

    withViewTransition(mutate, el);

    expect(elStart).toHaveBeenCalledTimes(1);
    expect(docStart).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the transition's finished promise rejects", async () => {
    const rejected = Promise.reject(new Error("aborted"));
    rejected.catch(() => {});
    (document as unknown as { startViewTransition: unknown }).startViewTransition = vi.fn(() => ({
      ready: Promise.resolve(),
      finished: rejected,
    }));

    expect(() => withViewTransition(() => {})).not.toThrow();
    await rejected.catch(() => {});
  });
});
