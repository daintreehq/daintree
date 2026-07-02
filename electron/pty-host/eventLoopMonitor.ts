import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import type { PtyHostEventLoopStats } from "../../shared/types/pty-host.js";

/**
 * Self-measurement of the pty-host UtilityProcess event loop. The main
 * process's lag monitor (ResourceProfileService) watches only its OWN loop —
 * it is blind to pty-host saturation, which is exactly where multi-terminal
 * parse load lands. This histogram is the ground truth for "the pty-host
 * thread was busy", surfaced through the flow-control snapshot into the
 * "why am I slow?" panel (a stall here with zero paused terminals is the
 * CPU-saturation signature, as opposed to queue backpressure).
 *
 * Snapshot reads reset the histogram so each pull reports the window since
 * the previous pull rather than an all-time high-water mark.
 */

let histogram: IntervalHistogram | null = null;
let lastEluSample: ReturnType<typeof performance.eventLoopUtilization> | null = null;

export function startEventLoopMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  lastEluSample = performance.eventLoopUtilization();
}

export function getEventLoopStats(): PtyHostEventLoopStats | null {
  if (!histogram) return null;
  const p99Ms = histogram.percentile(99) / 1e6;
  const maxMs = histogram.max / 1e6;
  const elu = performance.eventLoopUtilization(lastEluSample ?? undefined);
  lastEluSample = performance.eventLoopUtilization();
  histogram.reset();
  return {
    p99Ms: Number(p99Ms.toFixed(1)),
    maxMs: Number(maxMs.toFixed(1)),
    utilization: Number(elu.utilization.toFixed(3)),
  };
}

/** Test seam: stop and discard the histogram. */
export function stopEventLoopMonitorForTesting(): void {
  histogram?.disable();
  histogram = null;
  lastEluSample = null;
}
