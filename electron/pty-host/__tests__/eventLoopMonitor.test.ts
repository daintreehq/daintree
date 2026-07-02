import { describe, it, expect, afterEach } from "vitest";
import {
  startEventLoopMonitor,
  getEventLoopStats,
  stopEventLoopMonitorForTesting,
} from "../eventLoopMonitor.js";

describe("eventLoopMonitor", () => {
  afterEach(() => {
    stopEventLoopMonitorForTesting();
  });

  it("returns null when never started", () => {
    expect(getEventLoopStats()).toBeNull();
  });

  it("reports finite loop stats after sampling a live loop", async () => {
    startEventLoopMonitor();
    // Give the histogram a few loop turns to record intervals.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const stats = getEventLoopStats();
    expect(stats).not.toBeNull();
    expect(Number.isFinite(stats!.p99Ms)).toBe(true);
    expect(Number.isFinite(stats!.maxMs)).toBe(true);
    expect(stats!.p99Ms).toBeGreaterThanOrEqual(0);
    expect(stats!.maxMs).toBeGreaterThanOrEqual(stats!.p99Ms);
    expect(stats!.utilization).toBeGreaterThanOrEqual(0);
    expect(stats!.utilization).toBeLessThanOrEqual(1);
  });

  it("resets the window on each read so pulls report deltas, not high-water marks", async () => {
    startEventLoopMonitor();
    // Let the histogram's sampling timer establish itself before blocking.
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Block the loop long enough to guarantee a large max in window 1.
    const start = Date.now();
    while (Date.now() - start < 120) {
      // busy-wait
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    const first = getEventLoopStats();
    expect(first!.maxMs).toBeGreaterThan(50);

    // A quiet second window must not inherit the first window's spike.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = getEventLoopStats();
    expect(second!.maxMs).toBeLessThan(first!.maxMs);
  });

  it("is idempotent across repeated starts", () => {
    startEventLoopMonitor();
    startEventLoopMonitor();
    expect(getEventLoopStats()).not.toBeNull();
  });
});
