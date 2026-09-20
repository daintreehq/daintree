import type { IntervalHistogram } from "node:perf_hooks";

/**
 * Sampling period for the always-on event-loop histograms. Each sample is one
 * libuv timer wakeup, so 10–20ms cost 50–100 wakeups a second per process
 * before any real work exists (#12515). At 50ms a multi-hundred-ms stall still
 * lands as one long sample; see readExcessEventLoopDelay for why a coarser
 * period does not let that one sample set p99.
 */
export const EVENT_LOOP_HISTOGRAM_RESOLUTION_MS = 50;

// Unblocked time below which a window counts as saturated rather than as
// holding one isolated pause — see readExcessEventLoopDelay.
const SATURATED_WINDOW_UNBLOCKED_MS = 500;

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
 * The tail is p99 read as a 10ms histogram would have read it. HdrHistogram
 * ranks p99 at round(0.99 × count), which is the maximum itself once a window
 * holds 50 samples or fewer. At 10ms that took a window blocked for all but
 * ~500ms — saturation, and the maximum rightly stood. At 50ms a single 3.6s
 * pause already starves the window to ~28 samples, so the rank is capped at
 * count − 1 (keeping an isolated pause in `maxMs`, out of `p99Ms`) unless the
 * samples cover no more than SATURATED_WINDOW_UNBLOCKED_MS: a window that was
 * all but one block still reads as saturated. At 10ms the cap never changes the
 * rank.
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
  const saturated = count * resolutionMs <= SATURATED_WINDOW_UNBLOCKED_MS;
  const tailPercentile = saturated ? 99 : Math.min(99, ((count - 1) / count) * 100);
  return {
    p99Ms: excess(histogram.percentile(tailPercentile)),
    maxMs: excess(histogram.max),
  };
}
