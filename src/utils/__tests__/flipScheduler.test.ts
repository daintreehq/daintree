/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scheduleFlip } from "../flipScheduler";

describe("scheduleFlip", () => {
  let visibilityState: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityState = "visible";
    Object.defineProperty(document, "hidden", {
      get: () => visibilityState === "hidden",
      configurable: true,
    });
    Object.defineProperty(document, "visibilityState", {
      get: () => visibilityState,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setVisibility(state: DocumentVisibilityState) {
    visibilityState = state;
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("fires the callback once after the requested delay", () => {
    const onFlip = vi.fn();
    scheduleFlip(5000, onFlip);

    vi.advanceTimersByTime(4999);
    expect(onFlip).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm itself (one-shot)", () => {
    const onFlip = vi.fn();
    scheduleFlip(1000, onFlip);

    vi.advanceTimersByTime(5000);
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("clamps absurdly small delays to a floor instead of busy-looping", () => {
    const onFlip = vi.fn();
    scheduleFlip(0, onFlip);

    vi.advanceTimersByTime(1);
    expect(onFlip).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60);
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("does not immediately fire for a MONTH-sized delay (INT32 overflow guard)", () => {
    const onFlip = vi.fn();
    scheduleFlip(2_592_000_001, onFlip); // 30 days + 1ms — exceeds MAX_INT32

    vi.advanceTimersByTime(100);
    expect(onFlip).not.toHaveBeenCalled();

    // Fires once at the capped MAX_INT32 boundary, never spins.
    vi.advanceTimersByTime(2_147_483_647);
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending timer while the document is hidden", () => {
    const onFlip = vi.fn();
    scheduleFlip(5000, onFlip);

    setVisibility("hidden");
    vi.advanceTimersByTime(10_000);
    expect(onFlip).not.toHaveBeenCalled();
  });

  it("fires an immediate catch-up flip on visibility restore", () => {
    const onFlip = vi.fn();
    scheduleFlip(5000, onFlip);

    setVisibility("hidden");
    setVisibility("visible");
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("does not arm a timer when scheduled while hidden", () => {
    visibilityState = "hidden";
    const onFlip = vi.fn();
    scheduleFlip(1000, onFlip);

    vi.advanceTimersByTime(5000);
    expect(onFlip).not.toHaveBeenCalled();
  });

  it("clears the timer and listener on cleanup", () => {
    const onFlip = vi.fn();
    const cleanup = scheduleFlip(1000, onFlip);

    cleanup();
    vi.advanceTimersByTime(5000);
    setVisibility("hidden");
    setVisibility("visible");
    expect(onFlip).not.toHaveBeenCalled();
  });
});
