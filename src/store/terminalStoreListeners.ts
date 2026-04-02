import type {
  AgentStateChangePayload,
  TerminalActivityPayload,
  TerminalStatusPayload,
} from "@shared/types";
import type { CrashType } from "@shared/types/pty-host";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "./worktreeStore";
import { useResourceMonitoringStore } from "./resourceMonitoringStore";
import { flushTerminalPersistence } from "./slices";
import { isAgentTerminal } from "@/utils/terminalType";
import { logInfo, logWarn, logError } from "@/utils/logger";
import { SCROLLBACK_BACKGROUND } from "@shared/config/scrollback";
import { clearAllRestartGuards, isTerminalRestarting } from "./restartExitSuppression";
import { useTerminalStore, type PanelGridState } from "./terminalStore";

function normalizeCrashType(value: unknown): CrashType | null {
  const validTypes: CrashType[] = [
    "OUT_OF_MEMORY",
    "ASSERTION_FAILURE",
    "SIGNAL_TERMINATED",
    "UNKNOWN_CRASH",
    "CLEAN_EXIT",
  ];
  return validTypes.includes(value as CrashType) ? (value as CrashType) : null;
}

let agentStateUnsubscribe: (() => void) | null = null;
let agentDetectedUnsubscribe: (() => void) | null = null;
let agentExitedUnsubscribe: (() => void) | null = null;
let activityUnsubscribe: (() => void) | null = null;
let trashedUnsubscribe: (() => void) | null = null;
let restoredUnsubscribe: (() => void) | null = null;
let exitUnsubscribe: (() => void) | null = null;
let flowStatusUnsubscribe: (() => void) | null = null;
let backendCrashedUnsubscribe: (() => void) | null = null;
let backendReadyUnsubscribe: (() => void) | null = null;
let spawnResultUnsubscribe: (() => void) | null = null;
let reduceScrollbackUnsubscribe: (() => void) | null = null;
let restoreScrollbackUnsubscribe: (() => void) | null = null;
let resourceMetricsUnsubscribe: (() => void) | null = null;
let reclaimMemoryUnsubscribe: (() => void) | null = null;
let recoveryTimer: NodeJS.Timeout | null = null;
let beforeUnloadHandler: (() => void) | null = null;

const activityBuffer = new Map<string, TerminalActivityPayload>();
let activityRafId: number | null = null;

function flushActivityBuffer(): void {
  activityRafId = null;
  if (activityBuffer.size === 0) return;
  const store = useTerminalStore.getState();
  for (const data of activityBuffer.values()) {
    store.updateActivity(
      data.terminalId,
      data.headline,
      data.status,
      data.type,
      data.timestamp,
      data.lastCommand
    );
  }
  activityBuffer.clear();
}

function cancelActivityBuffer(): void {
  if (activityRafId !== null) {
    cancelAnimationFrame(activityRafId);
    activityRafId = null;
  }
  activityBuffer.clear();
}

export function cleanupTerminalStoreListeners() {
  clearAllRestartGuards();
  cancelActivityBuffer();
  if (agentStateUnsubscribe) {
    agentStateUnsubscribe();
    agentStateUnsubscribe = null;
  }
  if (agentDetectedUnsubscribe) {
    agentDetectedUnsubscribe();
    agentDetectedUnsubscribe = null;
  }
  if (agentExitedUnsubscribe) {
    agentExitedUnsubscribe();
    agentExitedUnsubscribe = null;
  }
  if (activityUnsubscribe) {
    activityUnsubscribe();
    activityUnsubscribe = null;
  }
  if (trashedUnsubscribe) {
    trashedUnsubscribe();
    trashedUnsubscribe = null;
  }
  if (restoredUnsubscribe) {
    restoredUnsubscribe();
    restoredUnsubscribe = null;
  }
  if (exitUnsubscribe) {
    exitUnsubscribe();
    exitUnsubscribe = null;
  }
  if (flowStatusUnsubscribe) {
    flowStatusUnsubscribe();
    flowStatusUnsubscribe = null;
  }
  if (backendCrashedUnsubscribe) {
    backendCrashedUnsubscribe();
    backendCrashedUnsubscribe = null;
  }
  if (backendReadyUnsubscribe) {
    backendReadyUnsubscribe();
    backendReadyUnsubscribe = null;
  }
  if (spawnResultUnsubscribe) {
    spawnResultUnsubscribe();
    spawnResultUnsubscribe = null;
  }
  if (reduceScrollbackUnsubscribe) {
    reduceScrollbackUnsubscribe();
    reduceScrollbackUnsubscribe = null;
  }
  if (restoreScrollbackUnsubscribe) {
    restoreScrollbackUnsubscribe();
    restoreScrollbackUnsubscribe = null;
  }
  if (resourceMetricsUnsubscribe) {
    resourceMetricsUnsubscribe();
    resourceMetricsUnsubscribe = null;
  }
  if (reclaimMemoryUnsubscribe) {
    reclaimMemoryUnsubscribe();
    reclaimMemoryUnsubscribe = null;
  }
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  if (beforeUnloadHandler) {
    window.removeEventListener("beforeunload", beforeUnloadHandler);
    beforeUnloadHandler = null;
  }
}

export function setupTerminalStoreListeners() {
  if (typeof window === "undefined") return () => {};

  // Idempotent: return early if already setup to prevent event loss window and overlapping cleanup
  if (exitUnsubscribe !== null) {
    return cleanupTerminalStoreListeners;
  }

  agentStateUnsubscribe = terminalRegistryController.onAgentStateChanged(
    (data: AgentStateChangePayload) => {
      const {
        terminalId,
        state,
        timestamp,
        trigger,
        confidence,
        waitingReason,
        sessionCost,
        sessionTokens,
      } = data;

      if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
        logWarn("Invalid timestamp in agent state event", { data });
        return;
      }

      if (!terminalId) {
        logWarn("Missing terminalId in agent state event", { data });
        return;
      }

      const clampedConfidence = Math.max(0, Math.min(1, confidence || 0));

      const terminal = useTerminalStore.getState().terminals.find((t) => t.id === terminalId);

      if (!terminal) {
        return;
      }

      if (terminal.isRestarting) {
        return;
      }

      if (terminal.lastStateChange && timestamp < terminal.lastStateChange) {
        return;
      }

      terminalInstanceService.setAgentState(terminalId, state);

      if (terminal.agentState === "directing" && state === "waiting") {
        return;
      }

      useTerminalStore
        .getState()
        .updateAgentState(
          terminalId,
          state,
          undefined,
          timestamp,
          trigger,
          clampedConfidence,
          waitingReason,
          sessionCost,
          sessionTokens
        );

      if (state === "waiting" || state === "idle") {
        useTerminalStore.getState().processQueue(terminalId);
      }
    }
  );

  agentDetectedUnsubscribe = terminalRegistryController.onAgentDetected((data) => {
    const { terminalId, processIconId } = data;
    if (!terminalId || !processIconId) return;

    useTerminalStore.setState((state) => {
      const terminal = state.terminals.find((t) => t.id === terminalId);
      if (!terminal || terminal.detectedProcessId === processIconId) return state;
      return {
        terminals: state.terminals.map((t) =>
          t.id === terminalId ? { ...t, detectedProcessId: processIconId } : t
        ),
      };
    });
  });

  agentExitedUnsubscribe = terminalRegistryController.onAgentExited((data) => {
    const { terminalId } = data;
    if (!terminalId) return;

    useTerminalStore.setState((state) => {
      const terminal = state.terminals.find((t) => t.id === terminalId);
      if (!terminal || !terminal.detectedProcessId) return state;
      return {
        terminals: state.terminals.map((t) =>
          t.id === terminalId ? { ...t, detectedProcessId: undefined } : t
        ),
      };
    });
  });

  activityUnsubscribe = terminalRegistryController.onActivity((data: TerminalActivityPayload) => {
    activityBuffer.set(data.terminalId, data);
    if (activityRafId === null) {
      activityRafId = requestAnimationFrame(flushActivityBuffer);
    }
  });

  trashedUnsubscribe = terminalRegistryController.onTrashed(
    (data: { id: string; expiresAt: number }) => {
      const { id, expiresAt } = data;
      const state = useTerminalStore.getState();
      const terminal = state.terminals.find((t) => t.id === id);
      const originalLocation: "dock" | "grid" = terminal?.location === "dock" ? "dock" : "grid";
      state.markAsTrashed(id, expiresAt, originalLocation);

      const updates: Partial<PanelGridState> = {};
      if (state.focusedId === id) {
        const activeWt = useWorktreeSelectionStore.getState().activeWorktreeId ?? undefined;
        const gridTerminals = state.terminals.filter(
          (t) => t.id !== id && t.location === "grid" && (t.worktreeId ?? undefined) === activeWt
        );
        updates.focusedId = gridTerminals[0]?.id ?? null;
      }
      if (state.maximizedId === id) {
        updates.maximizedId = null;
      }
      if (Object.keys(updates).length > 0) {
        useTerminalStore.setState(updates);
      }
    }
  );

  restoredUnsubscribe = terminalRegistryController.onRestored((data: { id: string }) => {
    const { id } = data;
    useTerminalStore.getState().markAsRestored(id);
    useTerminalStore.setState({ focusedId: id });
  });

  exitUnsubscribe = terminalRegistryController.onExit((id, exitCode) => {
    // Check synchronous restart guard FIRST - this handles the race condition where
    // the store's isRestarting flag hasn't propagated yet during bulk restarts
    if (isTerminalRestarting(id)) {
      return;
    }

    const state = useTerminalStore.getState();
    const terminal = state.terminals.find((t) => t.id === id);

    if (!terminal) return;

    // Also check store flag for safety (handles edge cases)
    if (terminal.isRestarting) {
      return;
    }

    // Clean up resource metrics for exited terminal
    useResourceMonitoringStore.getState().removeTerminal(id);

    // Store exit code on the terminal before applying exit behavior
    useTerminalStore.setState((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, exitCode } : t)),
    }));

    state.setRuntimeStatus(id, "exited");

    // If already trashed, this is TTL expiry cleanup - permanently remove
    if (terminal.location === "trash") {
      state.removeTerminal(id);
      return;
    }

    // Non-zero exit codes always preserve terminal for debugging, regardless of exitBehavior
    // This ensures failures are visible for review
    if (exitCode !== 0) {
      return;
    }

    // Respect explicit exitBehavior if set (only honored on successful exit)
    if (terminal.exitBehavior === "remove") {
      state.removeTerminal(id);
      return;
    }

    if (terminal.exitBehavior === "trash") {
      state.trashTerminal(id);
      return;
    }

    if (terminal.exitBehavior === "keep" || terminal.exitBehavior === "restart") {
      // "keep": preserve terminal for review
      // "restart": preserve terminal; TerminalPane triggers the restart via its exit effect
      // Note: non-zero exits are already preserved above, so this only matters for exit code 0
      return;
    }

    // exitBehavior undefined - use default behavior based on terminal type
    // Preserve dev-preview panels so users can inspect stopped/error states
    if (terminal.kind === "dev-preview") {
      return;
    }

    // Preserve successfully completed agent terminals to enable reboot and output review
    if (isAgentTerminal(terminal.kind ?? terminal.type, terminal.agentId)) {
      return;
    }

    // Auto-trash non-agent terminals on exit (preserves history for review, consistent with manual close)
    state.trashTerminal(id);
  });

  flowStatusUnsubscribe = terminalRegistryController.onStatus((data: TerminalStatusPayload) => {
    const { id, status, timestamp } = data;
    useTerminalStore.getState().updateFlowStatus(id, status, timestamp);
    if (status === "suspended" || status === "paused-backpressure") {
      terminalInstanceService.wake(id);
    }
  });

  backendCrashedUnsubscribe = terminalRegistryController.onBackendCrashed((details) => {
    logError("Backend crashed", undefined, { details });

    // Cancel any pending recovery timer
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }

    useTerminalStore.setState({
      backendStatus: "disconnected",
      lastCrashType: normalizeCrashType(details?.crashType),
    });
  });

  backendReadyUnsubscribe = terminalRegistryController.onBackendReady(() => {
    logInfo("Backend recovered, resetting renderers...");

    // Cancel any pending recovery timer from previous crash
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }

    useTerminalStore.setState({ backendStatus: "recovering" });

    // Reset all xterm instances to fix white text
    terminalInstanceService.handleBackendRecovery();

    // Mark as connected after a short delay to show recovery state
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      useTerminalStore.setState({ backendStatus: "connected", lastCrashType: null });
    }, 500);
  });

  spawnResultUnsubscribe = terminalRegistryController.onSpawnResult((id, result) => {
    if (!result.success) {
      if (result.error) {
        logError(`Spawn failed for terminal ${id}`, undefined, { error: result.error });
        useTerminalStore.getState().setSpawnError(id, result.error);
      } else {
        // Spawn failed but no error details provided - set generic error
        logError(`Spawn failed for terminal ${id} with no error details`);
        useTerminalStore.getState().setSpawnError(id, {
          code: "UNKNOWN",
          message: "Failed to start terminal process",
        });
      }
    } else {
      // Spawn succeeded - clear any previous spawn error
      const terminal = useTerminalStore.getState().terminals.find((t) => t.id === id);
      if (terminal?.spawnError) {
        useTerminalStore.getState().clearSpawnError(id);
      }
    }
  });

  reduceScrollbackUnsubscribe = terminalRegistryController.onReduceScrollback(
    ({ terminalIds, targetLines }) => {
      for (const id of terminalIds) {
        terminalInstanceService.reduceScrollback(id, targetLines);
      }
    }
  );

  restoreScrollbackUnsubscribe = terminalRegistryController.onRestoreScrollback(
    ({ terminalIds }) => {
      for (const id of terminalIds) {
        terminalInstanceService.restoreScrollback(id);
      }
    }
  );

  // Resource metrics listener
  resourceMetricsUnsubscribe = window.electron.terminal.onResourceMetrics((data) => {
    const rmStore = useResourceMonitoringStore.getState();
    if (rmStore.enabled) {
      rmStore.updateMetrics(data.metrics);
    }
  });

  // Memory pressure: reduce scrollback on all background terminals
  reclaimMemoryUnsubscribe = window.electron.terminal.onReclaimMemory(() => {
    terminalInstanceService.reduceScrollbackAllBackground(SCROLLBACK_BACKGROUND);
  });

  // Flush pending terminal persistence on window close to prevent data loss
  beforeUnloadHandler = () => {
    flushTerminalPersistence();
  };
  window.addEventListener("beforeunload", beforeUnloadHandler);

  return cleanupTerminalStoreListeners;
}
