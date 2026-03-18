import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
  },
}));

describe("startEventLoopLagMonitor", () => {
  let logWarn: ReturnType<typeof vi.fn>;
  let startEventLoopLagMonitor: typeof import("../performance.js").startEventLoopLagMonitor;
  let mockNow: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    mockNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => mockNow);

    vi.resetModules();

    const loggerMod = await import("../logger.js");
    logWarn = loggerMod.logWarn as ReturnType<typeof vi.fn>;

    const perfMod = await import("../performance.js");
    startEventLoopLagMonitor = perfMod.startEventLoopLagMonitor;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a cleanup function", () => {
    const stop = startEventLoopLagMonitor(1000, 100);
    expect(typeof stop).toBe("function");
    stop();
  });

  it("does not warn when lag is below threshold", () => {
    mockNow = 6000;
    startEventLoopLagMonitor(1000, 100);

    // Advance by exactly 1000ms (no lag)
    mockNow = 7000;
    vi.advanceTimersByTime(1000);

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("suppresses warnings during first 5 seconds", () => {
    mockNow = 0;
    startEventLoopLagMonitor(1000, 100);

    // Simulate lag at 2s (within suppression window)
    mockNow = 2200;
    vi.advanceTimersByTime(1000);

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("warns after suppression window when lag exceeds threshold", () => {
    mockNow = 0;
    startEventLoopLagMonitor(1000, 100);

    // Advance past suppression window with lag
    mockNow = 6200;
    vi.advanceTimersByTime(1000);

    expect(logWarn).toHaveBeenCalledWith("Event loop lag detected", {
      lagMs: expect.any(Number),
      intervalMs: 1000,
    });
  });

  it("rate-limits warnings to one per 10 seconds", () => {
    mockNow = 0;
    startEventLoopLagMonitor(1000, 100);

    // First lag event at 6s — should warn
    mockNow = 6200;
    vi.advanceTimersByTime(1000);
    expect(logWarn).toHaveBeenCalledTimes(1);

    // Second lag event at 7s — rate-limited
    mockNow = 7200;
    vi.advanceTimersByTime(1000);
    expect(logWarn).toHaveBeenCalledTimes(1);

    // Third lag event at 17s — past rate limit
    mockNow = 17200;
    vi.advanceTimersByTime(10000);
    expect(logWarn).toHaveBeenCalledTimes(2);
  });

  it("cleanup clears the interval", () => {
    mockNow = 0;
    const stop = startEventLoopLagMonitor(1000, 100);
    stop();

    mockNow = 6200;
    vi.advanceTimersByTime(1000);

    expect(logWarn).not.toHaveBeenCalled();
  });
});
