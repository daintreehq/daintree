import type { IntervalHistogram } from "node:perf_hooks";

/**
 * Sampling period for the always-on event-loop histograms. Each sample is one
 * libuv timer wakeup, so 10–20ms cost 50–100 wakeups a second per process
 * before any real work exists (#12515). At 50ms a multi-hundred-ms stall still
 * lands as one long sample; see readExcessEventLoopDelay for why a coarser
 * period does not let that one sample set p99.
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
 *
 * The tail is p99, but never the single worst sample. HdrHistogram ranks p99
 * at round(0.99 × count), which is the maximum itself once a window holds
 * fewer than ~100 samples — and one long pause both is the maximum and eats
 * the window's samples (a 3.6s block leaves ~28 at 50ms). Capping the rank at
 * count − 1 keeps an isolated pause in `maxMs` and out of `p99Ms`, as it was
 * at 10ms where windows held hundreds of samples.
 */
export function readExcessEventLoopDelay(
  histogram: IntervalHistogram,
  resolutionMs: number
): EventLoopDelayReading {
  const excess = (ns: number): number => {
    const ms = ns / 1_000_000 - resolutionMs;
    return Number.isFinite(ms) ? Math.max(0, ms) : 0;
  };
  const count = histogram.count;
  if (count === 0) return { p99Ms: 0, maxMs: 0 };
  const tailPercentile = count > 1 ? Math.min(99, ((count - 1) / count) * 100) : 100;
  return {
    p99Ms: excess(histogram.percentile(tailPercentile)),
    maxMs: excess(histogram.max),
  };
}
