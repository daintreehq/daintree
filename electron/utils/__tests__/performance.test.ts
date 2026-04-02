import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ now: 0 }));

vi.mock("node:perf_hooks", () => ({
  performance: {
    now: () => state.now,
    timeOrigin: 1_000_000,
  },
}));

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
  },
}));

import { logWarn } from "../logger.js";
import { startEventLoopLagMonitor, rebaseRendererElapsedMs, APP_BOOT_T0, mainTimeOrigin } from "../performance.js";

describe("startEventLoopLagMonitor", () => {
  let stopFn: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    state.now = 0;
    vi.mocked(logWarn).mockClear();
  });

  afterEach(() => {
    stopFn?.();
    stopFn = null;
    vi.useRealTimers();
  });

  it("returns a cleanup function", () => {
    stopFn = startEventLoopLagMonitor(1000, 100);
    expect(typeof stopFn).toBe("function");
  });

  it("does not warn when lag is below threshold", () => {
    state.now = 0;
    stopFn = startEventLoopLagMonitor(1000, 100);

    state.now = 1000;
    vi.advanceTimersByTime(1000);

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("suppresses warnings during first 5 seconds", () => {
    state.now = 0;
    stopFn = startEventLoopLagMonitor(1000, 100);

    state.now = 1200;
    vi.advanceTimersByTime(1000);

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("warns after suppression window when lag exceeds threshold", () => {
    state.now = 0;
    stopFn = startEventLoopLagMonitor(1000, 100);

    state.now = 6000;
    vi.advanceTimersByTime(1000);

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("Event loop lag detected", {
      lagMs: 5000,
      intervalMs: 1000,
    });
  });

  it("rate-limits warnings to one per 10 seconds", () => {
    state.now = 0;
    stopFn = startEventLoopLagMonitor(1000, 100);

    // Tick 1: lag at 6s → warns
    state.now = 6000;
    vi.advanceTimersByTime(1000);
    expect(logWarn).toHaveBeenCalledTimes(1);

    // Tick 2: lag at 7.2s → rate-limited
    state.now = 7200;
    vi.advanceTimersByTime(1000);
    expect(logWarn).toHaveBeenCalledTimes(1);

    // Tick 3: lag at 17.5s → warns (>10s since last)
    state.now = 17500;
    vi.advanceTimersByTime(1000);
    expect(logWarn).toHaveBeenCalledTimes(2);
  });

  it("cleanup clears the interval", () => {
    state.now = 0;
    stopFn = startEventLoopLagMonitor(1000, 100);
    stopFn();
    stopFn = null;

    state.now = 6200;
    vi.advanceTimersByTime(1000);

    expect(logWarn).not.toHaveBeenCalled();
  });
});

describe("rebaseRendererElapsedMs", () => {
  it("computes correct rebased elapsed time", () => {
    // APP_BOOT_T0 = 0 (performance.now() at module load, mocked to 0)
    // mainTimeOrigin = 1_000_000 (mocked)
    // rendererTimeOrigin = 1_000_100 (renderer started 100ms after main)
    // rendererT0 = 5 (performance.now() in renderer at module load)
    // elapsedMs = 200 (time since rendererT0)
    // Expected: (1_000_100 + 5 + 200) - (1_000_000 + 0) = 305
    const result = rebaseRendererElapsedMs(1_000_100, 5, 200);
    expect(result).toBe(305);
  });

  it("produces values greater than renderer elapsed when renderer started after main", () => {
    // Renderer started 500ms after main boot
    const result = rebaseRendererElapsedMs(1_000_500, 10, 50);
    // (1_000_500 + 10 + 50) - (1_000_000 + 0) = 560
    expect(result).toBe(560);
  });

  it("exports APP_BOOT_T0 and mainTimeOrigin", () => {
    expect(typeof APP_BOOT_T0).toBe("number");
    expect(typeof mainTimeOrigin).toBe("number");
  });
});
