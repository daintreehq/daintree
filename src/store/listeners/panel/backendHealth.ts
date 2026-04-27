import type { CrashType } from "@shared/types/pty-host";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { logInfo, logError } from "@/utils/logger";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { usePanelStore } from "@/store/panelStore";

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

        // Cancel any pending recovery timer
        if (recoveryTimer) {
          clearTimeout(recoveryTimer);
          recoveryTimer = null;
        }

        usePanelStore.setState({
          backendStatus: "disconnected",
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
