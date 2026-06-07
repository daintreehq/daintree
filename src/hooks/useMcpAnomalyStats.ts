import { useCallback, useEffect, useRef } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useMcpAnomalyStore } from "@/store/mcpAnomalyStore";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { logWarn } from "@/utils/logger";

/**
 * Cadence for the ambient anomaly poll. Slow on purpose (#10022): anomaly
 * signals are background diagnostics, not live state, so a 30s glance keeps IPC
 * churn negligible while still surfacing a freshly-fired signal within a normal
 * attention window. Matches `useProjectPresetsSubscription`'s interval.
 */
const POLL_INTERVAL_MS = 30_000;

/**
 * App-level hook that keeps {@link useMcpAnomalyStore} fed from
 * `getAuditStats()` so the toolbar pip and HelpPanel footer link can surface
 * MCP audit anomalies as a Tier 1 ambient signal — no `notify()`, no toast.
 *
 * Mount once near `useMcpBridge` so the poll runs regardless of whether the
 * toolbar button or HelpPanel is currently rendered. `getAuditStats()` is an
 * in-memory computation on the main side, so a 30s poll is cheap.
 *
 * Audit stats are process-global (same scope the Settings tab reads), so the
 * flag isn't truly project-scoped — but we still `reset()` on project change so
 * a stale pip never lingers across a switch while the first poll for the new
 * context is in flight. The `activeIdRef` guard discards any response that
 * resolves after the project has changed.
 */
export function useMcpAnomalyStats(): void {
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const setFromStats = useMcpAnomalyStore((s) => s.setFromStats);
  const reset = useMcpAnomalyStore((s) => s.reset);
  const activeIdRef = useRef<string | null>(null);

  const poll = useCallback(async () => {
    const projectId = activeIdRef.current;
    try {
      const stats = await window.electron.mcpServer.getAuditStats();
      if (activeIdRef.current !== projectId) return;
      setFromStats(stats);
    } catch (error) {
      if (activeIdRef.current !== projectId) return;
      // Fail closed: a failed fetch must not strand a stale "anomaly" pip, and
      // the user can't act on the fetch failure itself — Tier 0 silent log.
      logWarn("[useMcpAnomalyStats] Failed to load MCP audit stats", { error });
      setFromStats(null);
    }
  }, [setFromStats]);

  useEffect(() => {
    activeIdRef.current = currentProjectId;
    // Clear immediately on every project change (including to "no project") so
    // the pip can't carry over from the previous context, then take a fresh
    // reading right away — the interval below only fires after the first
    // POLL_INTERVAL_MS, so without this the pip would lag 30s on launch.
    reset();
    void poll();
  }, [currentProjectId, reset, poll]);

  useVisibilityAwareInterval(() => void poll(), POLL_INTERVAL_MS);
}
