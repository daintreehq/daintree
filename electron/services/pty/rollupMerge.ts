/**
 * rollupMerge - Pure functions for merging per-shard PTY host aggregates into
 * one app-wide view. Extracted verbatim from PtyClient.ts (#11007) — no
 * behavior changes.
 */

import type {
  FlowControlShardSnapshot,
  FlowControlSnapshot,
  MemoryRollup,
  MemoryRollupProject,
} from "../../../shared/types/pty-host.js";

/**
 * Merge per-shard memory rollups into one app-wide rollup. The fabric places
 * a project on exactly one shard, so per-project rows never overlap across
 * shards — the by-key merge below is defensive (and collapses the null-project
 * row if it ever appears on more than one shard). `available` is a global
 * claim ("the process table was read"), so one failed shard marks the merged
 * rollup unavailable rather than silently under-reporting.
 */
export function mergeMemoryRollups(rollups: MemoryRollup[]): MemoryRollup {
  const byKey = new Map<string | null, MemoryRollupProject>();
  for (const rollup of rollups) {
    for (const row of rollup.byProject) {
      const existing = byKey.get(row.projectId);
      if (!existing) {
        byKey.set(row.projectId, { ...row, topProcesses: [...row.topProcesses] });
        continue;
      }
      existing.terminalCount += row.terminalCount;
      existing.processCount += row.processCount;
      existing.memoryKb += row.memoryKb;
      existing.topProcesses = [...existing.topProcesses, ...row.topProcesses]
        .sort((a, b) => b.memoryKb - a.memoryKb)
        .slice(0, 5);
    }
  }
  return {
    byProject: [...byKey.values()],
    totalMemoryKb: rollups.reduce((sum, r) => sum + r.totalMemoryKb, 0),
    totalProcessCount: rollups.reduce((sum, r) => sum + r.totalProcessCount, 0),
    terminalCount: rollups.reduce((sum, r) => sum + r.terminalCount, 0),
    available: rollups.every((r) => r.available),
    sampledAt: Math.max(...rollups.map((r) => r.sampledAt)),
  };
}

/**
 * Merge per-shard flow-control snapshots. Terminal rows and queue depths
 * concatenate (terminals are disjoint across shards); counters sum; the
 * top-level governor/event-loop fields carry the worst-shard view so single-
 * number diagnostics ("is the terminal backend throttled", "PTY host lag
 * p99") stay meaningful; `shards` carries the per-shard breakdown.
 */
export function mergeFlowControlSnapshots(
  entries: Array<{ shardKey: string; snapshot: FlowControlSnapshot }>
): FlowControlSnapshot {
  const snapshots = entries.map((e) => e.snapshot);
  const smoothed = snapshots
    .map((s) => s.resourceGovernor.smoothedUtilizationPercent)
    .filter((v): v is number => v !== null);
  const eventLoops = snapshots
    .map((s) => s.eventLoop)
    .filter((v): v is NonNullable<FlowControlSnapshot["eventLoop"]> => v !== null);
  const worstEventLoop =
    eventLoops.length > 0
      ? eventLoops.reduce((worst, current) => (current.p99Ms > worst.p99Ms ? current : worst))
      : null;
  const shards: FlowControlShardSnapshot[] = entries.map(({ shardKey, snapshot }) => ({
    shardKey,
    terminalCount: snapshot.terminals.length,
    totalPendingBytes: snapshot.totalPendingBytes,
    resourceGovernor: snapshot.resourceGovernor,
    eventLoop: snapshot.eventLoop,
  }));
  return {
    timestamp: Math.max(...snapshots.map((s) => s.timestamp)),
    terminals: snapshots.flatMap((s) => s.terminals),
    queueDepth: snapshots.flatMap((s) => s.queueDepth),
    totalPendingBytes: snapshots.reduce((sum, s) => sum + s.totalPendingBytes, 0),
    stats: {
      pauseCount: snapshots.reduce((sum, s) => sum + s.stats.pauseCount, 0),
      resumeCount: snapshots.reduce((sum, s) => sum + s.stats.resumeCount, 0),
      suspendCount: snapshots.reduce((sum, s) => sum + s.stats.suspendCount, 0),
      forceResumeCount: snapshots.reduce((sum, s) => sum + s.stats.forceResumeCount, 0),
    },
    resourceGovernor: {
      isThrottling: snapshots.some((s) => s.resourceGovernor.isThrottling),
      isWarning: snapshots.some((s) => s.resourceGovernor.isWarning),
      activeProfile: snapshots[0].resourceGovernor.activeProfile,
      smoothedUtilizationPercent: smoothed.length > 0 ? Math.max(...smoothed) : null,
      throttleDurationMs: Math.max(...snapshots.map((s) => s.resourceGovernor.throttleDurationMs)),
    },
    eventLoop: worstEventLoop,
    shards,
  };
}
