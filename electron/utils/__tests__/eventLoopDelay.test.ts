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

/** A histogram over explicit samples (ms), ranked the way HdrHistogram_c does. */
function sampledHistogram(samplesMs: number[]): IntervalHistogram {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    count: sorted.length,
    percentile: (p: number) => {
      const rank = Math.max(1, Math.trunc((Math.min(p, 100) / 100) * sorted.length + 0.5));
      return sorted[rank - 1] * 1_000_000;
    },
    max: sorted[sorted.length - 1] * 1_000_000,
  } as unknown as IntervalHistogram;
}

describe("readExcessEventLoopDelay", () => {
  it("keeps one isolated pause out of p99 even when it starves the window of samples", () => {
    // A 3.6s block inside a 5s window leaves ~27 samples at 50ms; a plain p99
    // would rank the pause itself.
    const reading = readExcessEventLoopDelay(sampledHistogram([...Array(27).fill(52), 3650]), 50);
    expect(reading.p99Ms).toBeCloseTo(2);
    expect(reading.maxMs).toBe(3600);
  });

  it("reads a window blocked almost throughout as saturated", () => {
    // The loop ran for ~50ms of a 5s window: that is saturation, not an
    // isolated pause, and a 10ms histogram's p99 would have been this block.
    const reading = readExcessEventLoopDelay(sampledHistogram([52, 4950]), 50);
    expect(reading.p99Ms).toBe(4900);
  });

  it("matches the plain p99 rank at 10ms, where the cap never applies", () => {
    for (const count of [2, 30, 50, 51, 99, 100, 101, 250]) {
      const samples = [...Array(count - 1).fill(11), 900];
      const histogram = sampledHistogram(samples);
      const plain = Math.max(0, histogram.percentile(99) / 1_000_000 - 10);
      expect(readExcessEventLoopDelay(histogram, 10).p99Ms).toBe(plain);
    }
  });

  it("lets two stalls in one window reach p99", () => {
    const reading = readExcessEventLoopDelay(
      sampledHistogram([...Array(40).fill(51), 450, 460]),
      50
    );
    expect(reading.p99Ms).toBe(400);
  });

  it("uses a true p99 once the window is large", () => {
    const samples = [...Array(494).fill(51), 300, 310, 320, 330, 340, 350];
    // round(0.99 × 500) = 495 → the sixth-worst sample, as before this change.
    expect(readExcessEventLoopDelay(sampledHistogram(samples), 50).p99Ms).toBe(250);
  });

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
