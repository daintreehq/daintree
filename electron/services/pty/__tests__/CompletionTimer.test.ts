import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CompletionTimer } from "../CompletionTimer.js";

describe("CompletionTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets emitted to true on emit", () => {
    const timer = new CompletionTimer();
    timer.emit(() => {}, 500);
    expect(timer.emitted).toBe(true);
  });

  it("fires callback after hold period", () => {
    const timer = new CompletionTimer();
    const callback = vi.fn();
    timer.emit(callback, 500);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("reset cancels timer and clears emitted", () => {
    const timer = new CompletionTimer();
    const callback = vi.fn();
    timer.emit(callback, 500);
    timer.reset();
    expect(timer.emitted).toBe(false);
    vi.advanceTimersByTime(500);
    expect(callback).not.toHaveBeenCalled();
  });

  it("dispose clears everything", () => {
    const timer = new CompletionTimer();
    const callback = vi.fn();
    timer.emit(callback, 500);
    timer.dispose();
    expect(timer.emitted).toBe(false);
    vi.advanceTimersByTime(500);
    expect(callback).not.toHaveBeenCalled();
  });

  it("replaces previous timer on re-emit", () => {
    const timer = new CompletionTimer();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    timer.emit(cb1, 500);
    timer.emit(cb2, 500);
    vi.advanceTimersByTime(500);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("delayed re-emit resets the timer deadline", () => {
    const timer = new CompletionTimer();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    timer.emit(cb1, 500);
    // Advance 300ms — first timer hasn't fired yet
    vi.advanceTimersByTime(300);
    expect(cb1).not.toHaveBeenCalled();
    // Re-emit with new callback — should start a fresh 500ms timer
    timer.emit(cb2, 500);
    // Advance 200ms — would have been enough for old timer but not for new one
    vi.advanceTimersByTime(200);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
    // Advance remaining 300ms to complete new timer
    vi.advanceTimersByTime(300);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
  });
});
