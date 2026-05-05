import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setAlignedInterval } from "../setAlignedInterval.js";

describe("setAlignedInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires first tick at next wall-clock boundary", () => {
    const fn = vi.fn();

    vi.setSystemTime(15_000);
    setAlignedInterval(fn, 30_000);

    // At 15s wall time, next 30s boundary is at 30s → 15s delay
    vi.advanceTimersByTime(14_999);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires immediately when already at a boundary", () => {
    const fn = vi.fn();

    vi.setSystemTime(0);
    setAlignedInterval(fn, 30_000);

    // At 0ms wall time, delay is 0 → fires immediately
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires at correct cadence after alignment", () => {
    const fn = vi.fn();

    vi.setSystemTime(10_000);
    setAlignedInterval(fn, 30_000);

    // First tick at 30s (20s delay)
    vi.advanceTimersByTime(20_000);
    expect(fn).toHaveBeenCalledTimes(1);

    // Subsequent ticks every 30s
    vi.advanceTimersByTime(30_000);
    expect(fn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60_000);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("cleanup before first tick prevents callback", () => {
    const fn = vi.fn();

    vi.setSystemTime(15_000);
    const clear = setAlignedInterval(fn, 30_000);

    vi.advanceTimersByTime(5_000);
    clear();

    vi.advanceTimersByTime(20_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cleanup after first tick stops recurring ticks", () => {
    const fn = vi.fn();

    vi.setSystemTime(0);
    const clear = setAlignedInterval(fn, 30_000);

    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);

    clear();

    vi.advanceTimersByTime(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cleanup is idempotent", () => {
    const fn = vi.fn();

    vi.setSystemTime(15_000);
    const clear = setAlignedInterval(fn, 30_000);

    clear();
    clear();
    clear();

    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("handles non-boundary cadences", () => {
    const fn = vi.fn();

    vi.setSystemTime(1_000);
    setAlignedInterval(fn, 7_000);

    // At 1000ms wall time, next 7s boundary is at 7000ms → 6000ms delay
    vi.advanceTimersByTime(5_999);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(7_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
