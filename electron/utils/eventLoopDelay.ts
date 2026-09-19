import type { IntervalHistogram } from "node:perf_hooks";

/**
 * Sampling period for the always-on event-loop histograms. Each sample is one
 * libuv timer wakeup, so 10–20ms cost 50–100 wakeups a second per process
 * before any real work exists (#12515). At 50ms a multi-hundred-ms stall still
 * lands as one long sample, and a 5s window still holds ~100 samples, so a
 * single isolated pause cannot set p99 on its own.
 */
export const EVENT_LOOP_HISTOGRAM_RESOLUTION_MS = 50;

export interface EventLoopDelayReading {
  /** p99 delay beyond the sampling period, ms. */
  p99Ms: number;
  /** Worst delay beyond the sampling period, ms. */
  maxMs: number;
}

/**
 * Read a `monitorEventLoopDelay` histogram as *excess* delay. Every sample
 * records the whole gap between timer callbacks, so an idle loop reads as the
 * sampling period itself; subtracting it keeps thresholds meaningful whatever
 * resolution the histogram was built with. An empty histogram, or a read that
 * yields a non-finite value, reads as no measured delay.
 */
export function readExcessEventLoopDelay(
  histogram: IntervalHistogram,
  resolutionMs: number
): EventLoopDelayReading {
  const excess = (ns: number): number => {
    const ms = ns / 1_000_000 - resolutionMs;
    return Number.isFinite(ms) ? Math.max(0, ms) : 0;
  };
  if (histogram.count === 0) return { p99Ms: 0, maxMs: 0 };
  return { p99Ms: excess(histogram.percentile(99)), maxMs: excess(histogram.max) };
}
