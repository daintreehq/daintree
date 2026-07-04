import {
  getAppMetricsSnapshot,
  getAppMetricsSnapshotTimestamp,
} from "../utils/appMetricsSnapshot.js";
import type { PtyClient } from "./PtyClient.js";
import type { MemoryRollup } from "../../shared/types/pty-host.js";
import {
  TERMINAL_WORKLOAD_STALE_MS,
  type CompositeMemorySnapshot,
  type ElectronMemorySlice,
  type TerminalWorkloadSlice,
} from "../../shared/types/memoryAccounting.js";

/**
 * Read-through cache for the cross-process memory rollup, aligned with the
 * appMetricsSnapshot TTL so the badge popover (4s), the why-slow dock (5s),
 * and the resource-profile eval (30s) share one pty-host round-trip per
 * window instead of stacking their own.
 */
const ROLLUP_TTL_MS = 5_000;

let cachedRollup: MemoryRollup | null = null;
let cachedRollupAt = 0;
let rollupInflight: Promise<MemoryRollup> | null = null;

/**
 * Fetch the terminal-workload memory rollup through the shared TTL cache.
 * Never rejects: PtyClient.getMemoryRollup already resolves to an
 * `available: false` rollup on IPC failure. Returns null only when no
 * PtyClient is wired (tests, early startup).
 */
export async function getCachedMemoryRollup(
  ptyClient: PtyClient | null
): Promise<MemoryRollup | null> {
  // Structural guard for partial doubles (tests, degraded startup wiring):
  // a missing rollup surface reads as "no source" — an unavailable slice —
  // rather than a rejection every consumer would have to fence.
  if (!ptyClient || typeof ptyClient.getMemoryRollup !== "function") return null;
  const age = Date.now() - cachedRollupAt;
  // Negative age = clock moved backwards (suspend correction, fake timers) —
  // treat the cache as stale rather than trusting it.
  if (cachedRollup !== null && age >= 0 && age <= ROLLUP_TTL_MS) {
    return cachedRollup;
  }
  if (rollupInflight) return rollupInflight;
  rollupInflight = ptyClient
    .getMemoryRollup()
    .then((rollup) => {
      cachedRollup = rollup;
      cachedRollupAt = Date.now();
      return rollup;
    })
    .finally(() => {
      rollupInflight = null;
    });
  return rollupInflight;
}

/**
 * Pure composition of the two slices — the seam unit tests exercise. Either
 * input may be null/unavailable; the output always represents that explicitly
 * instead of collapsing to a plausible-looking zero.
 */
export function composeMemorySnapshot(
  metrics: Electron.ProcessMetric[] | null,
  metricsSampledAt: number,
  rollup: MemoryRollup | null,
  now: number
): CompositeMemorySnapshot {
  let electron: ElectronMemorySlice;
  if (metrics === null) {
    electron = { available: false, totalWorkingSetMb: 0, processCount: 0, sampledAt: 0 };
  } else {
    let totalKb = 0;
    for (const proc of metrics) {
      // workingSetSize is the only cross-platform field — privateBytes is
      // Windows-only and reports 0 (not undefined) on macOS/Linux (lesson #8646).
      totalKb += proc.memory.workingSetSize;
    }
    electron = {
      available: true,
      totalWorkingSetMb: Math.round(totalKb / 1024),
      processCount: metrics.length,
      sampledAt: metricsSampledAt,
    };
  }

  let terminalWorkloads: TerminalWorkloadSlice;
  if (rollup === null) {
    terminalWorkloads = {
      available: false,
      stale: false,
      ageMs: null,
      sampledAt: 0,
      totalMemoryMb: 0,
      processCount: 0,
      terminalCount: 0,
      byProject: [],
    };
  } else {
    // sampledAt is the last SUCCESSFUL process-table sweep. An unavailable
    // rollup still carries the previous sweep's numbers (the pty-host
    // aggregates over its retained cache), so last-good values survive a ps
    // failure — flagged, never silently presented as fresh.
    const hasSample = rollup.sampledAt > 0;
    const ageMs = hasSample ? Math.max(0, now - rollup.sampledAt) : null;
    terminalWorkloads = {
      available: rollup.available,
      stale: hasSample ? ageMs! > TERMINAL_WORKLOAD_STALE_MS : false,
      ageMs,
      sampledAt: rollup.sampledAt,
      totalMemoryMb: Math.round(rollup.totalMemoryKb / 1024),
      processCount: rollup.totalProcessCount,
      terminalCount: rollup.terminalCount,
      byProject: rollup.byProject.map((p) => ({
        projectId: p.projectId,
        terminalCount: p.terminalCount,
        processCount: p.processCount,
        memoryMb: Math.round(p.memoryKb / 1024),
        topProcesses: p.topProcesses,
      })),
    };
  }

  return { timestamp: now, electron, terminalWorkloads };
}

/**
 * The unified memory snapshot: Electron working-set + terminal descendant RSS,
 * grouped by project, with per-slice freshness. Both reads go through their
 * TTL caches, so pulling this on a popover/diagnostics cadence costs at most
 * one metrics sweep and one pty-host round-trip per 5s across all consumers.
 */
export async function getCompositeMemorySnapshot(
  ptyClient: PtyClient | null
): Promise<CompositeMemorySnapshot> {
  let metrics: Electron.ProcessMetric[] | null;
  try {
    metrics = getAppMetricsSnapshot();
  } catch {
    metrics = null;
  }
  const rollup = await getCachedMemoryRollup(ptyClient);
  return composeMemorySnapshot(metrics, getAppMetricsSnapshotTimestamp(), rollup, Date.now());
}

/** Drop the rollup cache so tests with mocked PtyClients stay isolated. */
export function resetMemoryAccountingForTesting(): void {
  cachedRollup = null;
  cachedRollupAt = 0;
  rollupInflight = null;
}
