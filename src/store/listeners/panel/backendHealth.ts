import type { CrashType } from "@shared/types/pty-host";
import { isPtyPanel } from "@shared/types/panel";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { logInfo, logError, logWarn } from "@/utils/logger";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { usePanelStore } from "@/store/panelStore";
import { deriveRuntimeStatus } from "@/store/slices/panelRegistry/helpers";
import { cancelPanelStatusBuffer } from "@/store/panelStatusBuffer";

/**
 * Clear stale flow state on every PTY panel after a pty-host crash + recovery.
 * The host only re-emits flow status on a pause/resume transition, so a panel
 * paused at crash time would keep showing the "Paused" pill forever once the
 * host comes back. One batched setState handles all panels to avoid N Zustand
 * subscriber notifications; unchanged panels are left untouched (#9899).
 */
function clearFlowStateOnRecovery(): void {
  // Drop every buffered status patch first — they were enqueued before the
  // crash and the recovered host won't re-emit them, so a pending RAF flush
  // would otherwise restore the stale "paused" pill right after we clear it.
  cancelPanelStatusBuffer();

  usePanelStore.setState((state) => {
    const nextById = { ...state.panelsById };
    let changed = false;
    for (const id of Object.keys(nextById)) {
      const panel = nextById[id];
      if (!panel || !isPtyPanel(panel)) continue;
      const nextRuntimeStatus = deriveRuntimeStatus(
        panel.isVisible,
        undefined,
        panel.runtimeStatus
      );
      if (
        panel.flowStatus === undefined &&
        panel.flowStatusTimestamp === undefined &&
        panel.heldDurationMs === undefined &&
        panel.runtimeStatus === nextRuntimeStatus
      ) {
        continue;
      }
      nextById[id] = {
        ...panel,
        flowStatus: undefined,
        flowStatusTimestamp: undefined,
        heldDurationMs: undefined,
        runtimeStatus: nextRuntimeStatus,
      };
      changed = true;
    }
    if (!changed) return state;
    return { panelsById: nextById };
  });
}

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

// Managed dynamically inside backendCrashed / backendReady callbacks — set and
// cleared mid-flight, so it cannot be registered with the DisposableStore at
// setup time. Cleanup is wired through a dedicated disposable below.
let recoveryTimer: NodeJS.Timeout | null = null;

export function setupBackendHealthListeners(): DisposableStore {
  const d = new DisposableStore();

  d.add(
    toDisposable(() => {
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }
    })
  );

  d.add(
    toDisposable(
      terminalRegistryController.onBackendCrashed((details) => {
        logError("Backend crashed", undefined, { details });

        if (recoveryTimer) {
          clearTimeout(recoveryTimer);
          recoveryTimer = null;
        }

        // The PTYs died with the host, so the geometry each pane last echoed
        // describes a process that no longer exists. Panes keep resizing for the
        // whole outage and no echo can arrive to correct the record (#11641).
        terminalInstanceService.handleBackendCrash();

        usePanelStore.setState({
          backendStatus: "disconnected",
          lastCrashType: normalizeCrashType(details?.crashType),
        });
      })
    )
  );

  d.add(
    toDisposable(
      terminalRegistryController.onBackendRecovering((details) => {
        logWarn("Backend recovering (auto-restart in progress)", { details });

        if (recoveryTimer) {
          clearTimeout(recoveryTimer);
          recoveryTimer = null;
        }

        usePanelStore.setState({
          backendStatus: "recovering",
          lastCrashType: normalizeCrashType(details?.crashType),
        });
      })
    )
  );

  d.add(
    toDisposable(
      terminalRegistryController.onBackendReady(() => {
        logInfo("Backend recovered, resetting renderers...");

        // Cancel any pending recovery timer from previous crash
        if (recoveryTimer) {
          clearTimeout(recoveryTimer);
          recoveryTimer = null;
        }

        usePanelStore.setState({ backendStatus: "recovering" });

        // Clear flow state left over from before the crash — the recovered host
        // won't re-emit it, so a paused-at-crash panel would stay "Paused" (#9899).
        clearFlowStateOnRecovery();

        // Reset all xterm instances to fix white text
        terminalInstanceService.handleBackendRecovery();

        // Mark as connected after a short delay to show recovery state
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null;
          usePanelStore.setState({ backendStatus: "connected", lastCrashType: null });
        }, 500);
      })
    )
  );

  return d;
}
