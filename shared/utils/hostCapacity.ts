import type { HostMetricsSummary } from "../types/remoteHosts.js";

/**
 * Whether the host counts used memory as Activity Monitor does. Older hosts
 * sent used bytes that included the file cache, and they predate the core
 * count that shipped alongside the fix: a present field, even null, marks the
 * newer reading.
 */
export function reportsMemoryCapacity(summary: HostMetricsSummary): boolean {
  return summary.cpuLogicalCoreCount !== undefined;
}

export function reportedCapacity(
  summary: HostMetricsSummary
): { used: number; total: number } | null {
  if (!reportsMemoryCapacity(summary)) return null;
  const { memoryUsedBytes: used, memoryTotalBytes: total } = summary;
  if (used === null || !Number.isFinite(used) || used < 0) return null;
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  return { used, total };
}

/**
 * Busy cores, from the share of all cores and the count the host says that
 * share covers. Null for a host that doesn't report the count: never a guess.
 */
export function busyCores(summary: HostMetricsSummary): { busy: number; total: number } | null {
  const cpu = summary.cpuPercent;
  // A quota makes the capacity fractional, which the integer core count can't say.
  const total = summary.cpuCapacityCores ?? summary.cpuLogicalCoreCount;
  if (cpu === null || !Number.isFinite(cpu) || !total || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return { busy: (cpu / 100) * total, total };
}
