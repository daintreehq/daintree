import { normalizeScrollbackLines } from "../../../shared/config/scrollback.js";
import { setSessionPersistSuppressed } from "../../services/pty/terminalSessionPersistence.js";
import type { HandlerMap, HostContext } from "./types.js";

export function createStateConfigHandlers(ctx: HostContext): HandlerMap {
  const { ptyManager, ipcDataMirrorTerminals, sendEvent } = ctx;

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

    "trim-state": (msg) => {
      const targetLines = normalizeScrollbackLines(msg.targetLines);
      ptyManager.trimScrollback(targetLines);
      setTimeout(() => {
        if (global.gc) global.gc();
      }, 100);
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
  };
}
