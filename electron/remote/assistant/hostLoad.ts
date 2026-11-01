import type { HostListEntry } from "../../../shared/types/hostControl.js";
import type { HostMetricsSummary } from "../../../shared/types/remoteHosts.js";
import {
  busyCores,
  reportedCapacity,
  reportsMemoryCapacity,
} from "../../../shared/utils/hostCapacity.js";
import type { SampleFreshness } from "../metrics/summaryReceipt.js";

export { HOST_LOAD_STALE_MS } from "../metrics/summaryReceipt.js";

type HostLoad = NonNullable<HostListEntry["load"]>;

const finiteOrNull = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const hundredths = (value: number): number => Math.round(value * 100) / 100;

/**
 * What a host's summary says about its capacity, for the assistant: the
 * producer's own meanings (the overview's derivations), with anything
 * unmeasured, stale or from an older host left null rather than zero. Stale
 * samples keep only what hardware fixes. `sampledAt` stays the host's own
 * clock, for provenance; the age is the freshness verdict's. A Windows Shell's
 * sample of itself has no platform the assistant's contract names, so it is null.
 */
export function projectHostLoad(
  summary: HostMetricsSummary,
  freshness: SampleFreshness
): HostLoad | null {
  if (summary.platform === "win32") return null;
  const { stale } = freshness;
  const usable = !stale;
  const cores = finiteOrNull(summary.cpuLogicalCoreCount);
  const capacity = reportedCapacity(summary);
  const total = finiteOrNull(summary.memoryTotalBytes);
  const busy = usable ? busyCores(summary) : null;
  return {
    sampledAt: summary.sampledAt,
    receivedAt: freshness.receivedAt,
    ageMs: freshness.ageMs,
    stale,
    staleReason: freshness.staleReason,
    platform: summary.platform,
    cpuPercent: usable ? finiteOrNull(summary.cpuPercent) : null,
    cpuLogicalCores: cores !== null && cores > 0 ? cores : null,
    cpuBusyCores: busy ? hundredths(busy.busy) : null,
    cpuIdleCores: busy ? hundredths(Math.max(0, busy.total - busy.busy)) : null,
    memoryTotalBytes: total !== null && total > 0 ? total : null,
    memoryUsedBytes: usable && capacity ? capacity.used : null,
    memoryAvailableBytes: usable && capacity ? Math.max(0, capacity.total - capacity.used) : null,
    memoryCapacityReported: reportsMemoryCapacity(summary),
    memoryPressure: usable ? summary.memoryPressure : null,
    thermal: usable ? summary.thermal : null,
    ...(summary.metricsScope !== undefined ? { metricsScope: summary.metricsScope } : {}),
    ...(summary.memoryPressureSomeAvg10 !== undefined
      ? { memoryPressureSomeAvg10: usable ? finiteOrNull(summary.memoryPressureSomeAvg10) : null }
      : {}),
    ...(summary.temperatureCelsius !== undefined
      ? {
          temperatureCelsius: usable ? finiteOrNull(summary.temperatureCelsius) : null,
          temperatureZone: usable ? (summary.temperatureZone ?? null) : null,
        }
      : {}),
  };
}
