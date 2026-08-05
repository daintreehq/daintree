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
     * Main's memory-pressure trim. The scope decides who is fair game, because
     * main's two callers are not the same kind of event (#11674):
     *
     * - `idle-only` (ProcessMemoryMonitor tier 1) is a graduated lever,
     *   redundant with the governor's own ranked reclaim. Flattening a live
     *   agent's canonical scrollback — which is also its serialize/restore
     *   source — costs far more there than it reclaims, so the governance
     *   policy protects it.
     * - `all` (the `host-throttled` listener) is the post-pause emergency. The
     *   governor skips its own pre-pause trim entirely at critical utilization
     *   and pauses immediately, so this is the only buffer reclaim left on that
     *   path; exempting the active agents holding the memory would leave
     *   nothing to reclaim (#10948).
     *
     * The counts are the reply because a scrollback trim only drops JS
     * references; main's footprint re-sample cannot attribute a delta to it.
     */
    "trim-state": (msg) => {
      const targetLines = normalizeScrollbackLines(msg.targetLines);
      const { trimmed, skipped } =
        msg.scope === "all"
          ? ptyManager.trimScrollback(targetLines)
          : ptyManager.trimIdleAnalysisSessions({ targetLines });
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
