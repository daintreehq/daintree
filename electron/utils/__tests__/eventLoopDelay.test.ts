import { describe, expect, it } from "vitest";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { EVENT_LOOP_HISTOGRAM_RESOLUTION_MS, readExcessEventLoopDelay } from "../eventLoopDelay.js";

function fakeHistogram(values: { count: number; p99Ms: number; maxMs: number }): IntervalHistogram {
  return {
    count: values.count,
    percentile: () => values.p99Ms * 1_000_000,
    max: values.maxMs * 1_000_000,
  } as unknown as IntervalHistogram;
}

describe("readExcessEventLoopDelay", () => {
  it("subtracts the sampling period so an idle loop reads as no delay", () => {
    const reading = readExcessEventLoopDelay(
      fakeHistogram({ count: 90, p99Ms: 52, maxMs: 58 }),
      50
    );
    expect(reading.p99Ms).toBeCloseTo(2);
    expect(reading.maxMs).toBeCloseTo(8);
  });

  it("clamps samples that land early to zero", () => {
    const reading = readExcessEventLoopDelay(fakeHistogram({ count: 5, p99Ms: 48, maxMs: 49 }), 50);
    expect(reading).toEqual({ p99Ms: 0, maxMs: 0 });
  });

  it("reads an empty histogram as no measured delay", () => {
    const reading = readExcessEventLoopDelay(fakeHistogram({ count: 0, p99Ms: 0, maxMs: 0 }), 50);
    expect(reading).toEqual({ p99Ms: 0, maxMs: 0 });
  });

  it("treats a non-finite read as no delay", () => {
    const reading = readExcessEventLoopDelay(
      fakeHistogram({ count: 3, p99Ms: Number.NaN, maxMs: Number.POSITIVE_INFINITY }),
      50
    );
    expect(reading).toEqual({ p99Ms: 0, maxMs: 0 });
  });

  it("still sees a real stall at the coarse resolution", async () => {
    const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_HISTOGRAM_RESOLUTION_MS });
    histogram.enable();
    try {
      // Wait for real sampling ticks before blocking: an interval spanning
      // enable() is never recorded (nodejs/node#34661).
      while (histogram.count < 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const start = Date.now();
      while (Date.now() - start < 300) {
        // busy-wait
      }
      const countBefore = histogram.count;
      while (histogram.count <= countBefore) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const reading = readExcessEventLoopDelay(histogram, EVENT_LOOP_HISTOGRAM_RESOLUTION_MS);
      expect(reading.maxMs).toBeGreaterThan(200);
    } finally {
      histogram.disable();
    }
  });
});
