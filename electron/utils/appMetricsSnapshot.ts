import { app } from "electron";

/**
 * Shared snapshot for `app.getAppMetrics()` — a synchronous full-process-table
 * sweep costing 5–50 ms of main-thread work that grows with process count
 * (browser + N renderers + utility hosts). Several samplers poll on the same
 * wall-clock-aligned 30 s cadence (ProcessMemoryMonitor's poll,
 * ResourceProfileService's eval, per-window cached-view samplers, eviction
 * passes), so without sharing, duplicate sweeps stack in the same tick.
 *
 * The TTL is short enough that any consumer tolerant of one poll period of
 * staleness loses nothing; consumers that measure before/after deltas must
 * use {@link refreshAppMetricsSnapshot} instead. Throws from
 * `app.getAppMetrics()` propagate to the caller (every call site already
 * guards) and are never cached.
 */
const SNAPSHOT_TTL_MS = 5_000;

let cachedMetrics: Electron.ProcessMetric[] | null = null;
let cachedAt = 0;

export function getAppMetricsSnapshot(
  maxAgeMs: number = SNAPSHOT_TTL_MS
): Electron.ProcessMetric[] {
  const age = Date.now() - cachedAt;
  // A negative age means the clock moved backwards (suspend correction, fake
  // timers in tests) — treat the cache as stale rather than trusting it.
  if (cachedMetrics !== null && age >= 0 && age <= maxAgeMs) {
    return cachedMetrics;
  }
  return refreshAppMetricsSnapshot();
}

/** Force a fresh sweep and prime the cache for read-through consumers. */
export function refreshAppMetricsSnapshot(): Electron.ProcessMetric[] {
  const metrics = app.getAppMetrics();
  cachedMetrics = metrics;
  cachedAt = Date.now();
  return metrics;
}

/**
 * Wall-clock time of the cached sweep, or 0 when none has succeeded yet.
 * Lets composite consumers report the true sample time instead of overstating
 * freshness with their own read time.
 */
export function getAppMetricsSnapshotTimestamp(): number {
  return cachedAt;
}

/** Drop the cached snapshot so tests with mocked metrics stay isolated. */
export function resetAppMetricsSnapshotForTesting(): void {
  cachedMetrics = null;
  cachedAt = 0;
}
