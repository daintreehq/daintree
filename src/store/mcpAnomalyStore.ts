import { create } from "zustand";
import type { McpAuditStats } from "@shared/types/ipc/mcpServer";

/**
 * Ambient state for MCP audit anomaly signals (#10022). The audit service
 * computes anomaly signals (latency-drift, first-seen-combination,
 * failure-cluster, p95-z-score) and returns them on {@link McpAuditStats}, but
 * until now they only surfaced inside Settings → MCP Server → Audit Log. This
 * store holds the distilled "is there anything worth a glance" flag so a Tier 1
 * ambient indicator (the toolbar assistant pip and the HelpPanel footer link)
 * can surface it without anyone calling `notify()`.
 *
 * Audit stats are process-global on the main side — the same scope the Settings
 * tab already reads — so this flag is not project-scoped. The polling hook still
 * resets it on project change for UX hygiene (don't carry a stale pip across a
 * switch); see `useMcpAnomalyStats`.
 */
interface McpAnomalyState {
  hasAnomaly: boolean;
  anomalyCount: number;
}

interface McpAnomalyActions {
  /**
   * Distill the IPC stats into the ambient flag. Owns the same suppression rule
   * `McpAuditLogViewer` applies: signals only count when the ring buffer has
   * cleared its record floor (`!anomalySuppressed`) and at least one signal is
   * present. A null/undefined stats payload (failed fetch) clears the flag.
   */
  setFromStats: (stats: McpAuditStats | null | undefined) => void;
  reset: () => void;
}

const INITIAL_STATE: McpAnomalyState = {
  hasAnomaly: false,
  anomalyCount: 0,
};

export const useMcpAnomalyStore = create<McpAnomalyState & McpAnomalyActions>((set) => ({
  ...INITIAL_STATE,

  setFromStats: (stats) => {
    if (!stats || stats.anomalySuppressed || stats.anomalySignals.length === 0) {
      // Only write when transitioning out of an active state — avoids a
      // no-op render every poll while there are no anomalies.
      set((prev) => (prev.hasAnomaly ? { ...INITIAL_STATE } : prev));
      return;
    }
    const count = stats.anomalySignals.length;
    set((prev) =>
      prev.hasAnomaly && prev.anomalyCount === count
        ? prev
        : { hasAnomaly: true, anomalyCount: count }
    );
  },

  reset: () => set((prev) => (prev.hasAnomaly ? { ...INITIAL_STATE } : prev)),
}));

/** Test-only escape hatch — resets the store to its initial state. */
export function __resetMcpAnomalyStoreForTesting(): void {
  useMcpAnomalyStore.setState({ ...INITIAL_STATE });
}
