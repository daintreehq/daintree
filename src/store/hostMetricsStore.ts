import { create } from "zustand";
import type { HostMetricsSnapshot } from "@shared/types/ipc/hostMetrics";
import type { HostId, HostMetricsSummary } from "@shared/types/remoteHosts";

/** ~15 minutes at the host's 5 s cadence; matches the main-process ring. */
export const HOST_METRICS_HISTORY_SIZE = 180;

/**
 * Host ids are user-chosen names, so a plain object would answer `constructor`
 * or `__proto__` with something inherited. A Map has no such keys.
 */
export type HostMetricsHistory = ReadonlyMap<HostId, readonly HostMetricsSummary[]>;

interface HostMetricsState {
  /** Per host, newest first. "local" is this machine. Replaced, never mutated. */
  history: HostMetricsHistory;
  seed(snapshots: HostMetricsSnapshot[]): void;
  apply(summary: HostMetricsSummary): void;
  forget(hostId: HostId): void;
  reset(): void;
}

const EMPTY: HostMetricsHistory = new Map();

/**
 * What every host last reported, and the recent run of it the overview's
 * sparklines draw. Fed only where Remote Hosts is in use.
 */
export const useHostMetricsStore = create<HostMetricsState>()((set) => ({
  history: EMPTY,
  seed(snapshots) {
    set((state) => {
      const history = new Map(state.history);
      for (const snapshot of snapshots) {
        const seeded = snapshot.history.slice(0, HOST_METRICS_HISTORY_SIZE);
        const live = history.get(snapshot.hostId) ?? [];
        // Anything pushed while the seed was in flight is newer than it.
        const newest = seeded[0]?.sampledAt ?? -Infinity;
        const fresher = live.filter((entry) => entry.sampledAt > newest);
        history.set(snapshot.hostId, [...fresher, ...seeded].slice(0, HOST_METRICS_HISTORY_SIZE));
      }
      return { history };
    });
  },
  apply(summary) {
    set((state) => {
      const ring = state.history.get(summary.hostId) ?? [];
      // Hosts have their own clocks, so only an exact repeat (a seed racing a push) is dropped.
      if (ring[0] && ring[0].sampledAt === summary.sampledAt) return state;
      const history = new Map(state.history);
      history.set(summary.hostId, [summary, ...ring].slice(0, HOST_METRICS_HISTORY_SIZE));
      return { history };
    });
  },
  forget(hostId) {
    set((state) => {
      if (!state.history.has(hostId)) return state;
      const history = new Map(state.history);
      history.delete(hostId);
      return { history };
    });
  },
  reset() {
    set({ history: EMPTY });
  },
}));

export function latestHostSummary(
  history: HostMetricsHistory,
  hostId: HostId
): HostMetricsSummary | null {
  return history.get(hostId)?.[0] ?? null;
}
