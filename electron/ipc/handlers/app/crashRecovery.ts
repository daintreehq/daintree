import { CHANNELS } from "../../channels.js";
import { getCrashRecoveryService } from "../../../services/CrashRecoveryService.js";
import { getCrashLoopGuard } from "../../../services/CrashLoopGuardService.js";
import type {
  CrashRecoveryAction,
  CrashRecoveryConfig,
} from "../../../../shared/types/ipc/crashRecovery.js";
import { typedHandle } from "../../utils.js";

export function registerCrashRecoveryHandlers(): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandle(CHANNELS.CRASH_RECOVERY_GET_PENDING, () => {
      if (getCrashLoopGuard().isSafeMode()) {
        return null;
      }
      const pending = getCrashRecoveryService().getPendingCrash();
      if (!pending) return null;
      return { ...pending, crashCount: getCrashLoopGuard().getCrashCount() };
    })
  );

  handlers.push(
    typedHandle(CHANNELS.CRASH_RECOVERY_RESOLVE, (action: CrashRecoveryAction) => {
      const service = getCrashRecoveryService();
      if (action.kind === "restore") {
        const ok = service.restoreBackup(action.panelIds);
        if (ok) {
          service.setPanelFilter(action.panelIds);
          service.clearPendingCrash();
        } else {
          // Propagate the failure to the renderer. `restoreBackup` returns
          // false for: no parseable snapshot, zero-match panel filter, no
          // restorable content, or apply-time exceptions. Throwing here
          // routes the failure through the dialog's existing
          // "Recovery failed" inline banner (and skips the false-positive
          // "Session restored" confirmation on the auto-restore path).
          // The backup is preserved on disk by the service so the user can
          // retry — see FILTER_WITH_NO_MATCHES_KEEPS_RECOVERY_SOURCE_FOR_RETRY.
          throw new Error("Crash recovery restore failed");
        }
      } else {
        service.resetToFresh();
        service.clearPendingCrash();
      }
    })
  );

  handlers.push(
    typedHandle(CHANNELS.CRASH_RECOVERY_GET_CONFIG, () => {
      return getCrashRecoveryService().getConfig();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.CRASH_RECOVERY_SET_CONFIG, (config: Partial<CrashRecoveryConfig>) => {
      return getCrashRecoveryService().setConfig(config);
    })
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
