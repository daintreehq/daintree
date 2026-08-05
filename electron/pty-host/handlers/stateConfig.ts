import { normalizeScrollbackLines } from "../../../shared/config/scrollback.js";
import { setSessionPersistSuppressed } from "../../services/pty/terminalSessionPersistence.js";
import type { MemoryRollupProject } from "../../../shared/types/pty-host.js";
import type { HandlerMap, HostContext } from "./types.js";

export function createStateConfigHandlers(ctx: HostContext): HandlerMap {
  const { ptyManager, processTreeCache, ipcDataMirrorTerminals, sendEvent } = ctx;

  return {
    "set-analysis-enabled": (msg) => {
      if (typeof msg.id === "string" && typeof msg.enabled === "boolean") {
        ptyManager.setAnalysisEnabled(msg.id, msg.enabled);
      } else {
        console.warn("[PtyHost] Invalid set-analysis-enabled message:", msg);
      }
    },

    "set-ipc-data-mirror": (msg) => {
      if (typeof msg.id === "string" && typeof msg.enabled === "boolean") {
        if (msg.enabled) {
          ipcDataMirrorTerminals.add(msg.id);
        } else {
          ipcDataMirrorTerminals.delete(msg.id);
        }
      }
    },

    /**
     * Main's memory-pressure trim (ProcessMemoryMonitor tier 1 and the
     * `host-throttled` listener both land here). Routed through the guarded
     * pass, not `trimScrollback`: this lever is redundant with the governor's
     * own ranked reclaim, and flattening a live agent's canonical scrollback —
     * which is also its serialize/restore source — costs far more than it
     * reclaims (#11674).
     *
     * The counts are the reply because a scrollback trim only drops JS
     * references; main's footprint re-sample cannot attribute a delta to it.
     */
    "trim-state": (msg) => {
      const targetLines = normalizeScrollbackLines(msg.targetLines);
      const { trimmed, skipped } = ptyManager.trimIdleAnalysisSessions({ targetLines });
      sendEvent({
        type: "trim-state-result",
        requestId: msg.requestId,
        result: { trimmed, skipped },
      });
    },

    "set-session-persist-suppressed": (msg) => {
      setSessionPersistSuppressed(msg.suppressed);
    },

    "get-project-stats": (msg) => {
      const rawStats = ptyManager.getProjectStats(msg.projectId);
      sendEvent({
        type: "project-stats",
        requestId: msg.requestId,
        stats: {
          terminalCount: rawStats.terminalCount,
          processIds: rawStats.processIds,
          detectedAgents: rawStats.terminalTypes,
        },
      });
    },

    "get-memory-rollup": (msg) => {
      const roots = ptyManager.getLiveTerminalRoots();
      // Group by projectId ("" = unattributed); the cache dedupes PIDs across
      // roots so nested/overlapping trees aren't double-counted.
      const agg = processTreeCache.aggregateSubtreeMemory(
        roots.map((r) => ({ key: r.projectId ?? "", rootPid: r.rootPid }))
      );
      const terminalCountByKey = new Map<string, number>();
      for (const r of roots) {
        const key = r.projectId ?? "";
        terminalCountByKey.set(key, (terminalCountByKey.get(key) ?? 0) + 1);
      }
      const byProject: MemoryRollupProject[] = Object.entries(agg.byKey).map(([key, value]) => ({
        projectId: key === "" ? null : key,
        terminalCount: terminalCountByKey.get(key) ?? 0,
        processCount: value.processCount,
        memoryKb: value.memoryKb,
        topProcesses: value.topProcesses,
      }));
      sendEvent({
        type: "memory-rollup",
        requestId: msg.requestId,
        rollup: {
          byProject,
          totalMemoryKb: agg.totalMemoryKb,
          totalProcessCount: agg.totalProcessCount,
          terminalCount: roots.length,
          // A ps/PowerShell failure leaves the tree cache stale — signal it so the
          // renderer falls back to the per-terminal estimate rather than a wrong 0.
          available: processTreeCache.getLastError() === null,
          // Report the actual last successful refresh, not handler-run time — the
          // cache can be seconds old under adaptive backoff, so Date.now() here
          // would overstate freshness.
          sampledAt: processTreeCache.getLastRefreshTime(),
        },
      });
    },
  };
}
