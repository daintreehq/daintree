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
      return getCrashRecoveryService().getPendingCrash();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.CRASH_RECOVERY_RESOLVE, (action: CrashRecoveryAction) => {
      const service = getCrashRecoveryService();
      if (action.kind === "restore") {
        const ok = service.restoreBackup(action.panelIds);
        if (ok) {
          service.setPanelFilter(action.panelIds);
        } else {
          console.warn("[CrashRecovery] restoreBackup returned false — no backup or read error");
        }
      } else {
        service.resetToFresh();
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
