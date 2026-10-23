import type { HostListEntry } from "../../../shared/types/hostControl.js";
import type { HostMetricsSummary } from "../../../shared/types/remoteHosts.js";
import {
  busyCores,
  reportedCapacity,
  reportsMemoryCapacity,
} from "../../../shared/utils/hostCapacity.js";
import { HOST_METRICS_INTERVAL_MS } from "../metrics/sampler.js";

/** Three missed samples; past this the figures describe a machine that may have changed. */
export const HOST_LOAD_STALE_MS = 3 * HOST_METRICS_INTERVAL_MS;

type HostLoad = NonNullable<HostListEntry["load"]>;

const finiteOrNull = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const hundredths = (value: number): number => Math.round(value * 100) / 100;

/**
 * What a host's summary says about its capacity, for the assistant: the
 * producer's own meanings (the overview's derivations), with anything
 * unmeasured, stale or from an older host left null rather than zero. Stale
 * samples keep only what hardware fixes; remote `sampledAt` is the remote
 * clock, so a timestamp far from ours counts as unusable, not as fresh.
 */
export function projectHostLoad(summary: HostMetricsSummary, now: number): HostLoad {
  const age = Number.isFinite(summary.sampledAt) ? now - summary.sampledAt : Number.NaN;
  const usable = Number.isFinite(age) && Math.abs(age) <= HOST_LOAD_STALE_MS;
  const stale = !usable;
  const cores = finiteOrNull(summary.cpuLogicalCoreCount);
  const capacity = reportedCapacity(summary);
  const total = finiteOrNull(summary.memoryTotalBytes);
  const busy = usable ? busyCores(summary) : null;
  return {
    sampledAt: summary.sampledAt,
    ageMs: Number.isFinite(age) ? Math.max(0, age) : 0,
    stale,
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
    // Fixed by the hardware, like the total it is worked out from: kept when stale.
    ...(summary.agentLaunchLimit !== undefined
      ? { agentLaunchLimit: finiteOrNull(summary.agentLaunchLimit) }
      : {}),
    ...(summary.temperatureCelsius !== undefined
      ? {
          temperatureCelsius: usable ? finiteOrNull(summary.temperatureCelsius) : null,
          temperatureZone: usable ? (summary.temperatureZone ?? null) : null,
        }
      : {}),
  };
}
