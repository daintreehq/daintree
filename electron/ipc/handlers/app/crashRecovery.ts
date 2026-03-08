import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { getCrashRecoveryService } from "../../../services/CrashRecoveryService.js";
import type {
  CrashRecoveryAction,
  CrashRecoveryConfig,
} from "../../../../shared/types/ipc/crashRecovery.js";

export function registerCrashRecoveryHandlers(): () => void {
  const handlers: Array<() => void> = [];

  ipcMain.handle(CHANNELS.CRASH_RECOVERY_GET_PENDING, () => {
    return getCrashRecoveryService().getPendingCrash();
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.CRASH_RECOVERY_GET_PENDING));

  ipcMain.handle(CHANNELS.CRASH_RECOVERY_RESOLVE, (_event, action: CrashRecoveryAction) => {
    const service = getCrashRecoveryService();
    if (action === "restore") {
      const ok = service.restoreBackup();
      if (!ok) {
        console.warn("[CrashRecovery] restoreBackup returned false — no backup or read error");
      }
    } else {
      service.resetToFresh();
    }
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.CRASH_RECOVERY_RESOLVE));

  ipcMain.handle(CHANNELS.CRASH_RECOVERY_GET_CONFIG, () => {
    return getCrashRecoveryService().getConfig();
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.CRASH_RECOVERY_GET_CONFIG));

  ipcMain.handle(
    CHANNELS.CRASH_RECOVERY_SET_CONFIG,
    (_event, config: Partial<CrashRecoveryConfig>) => {
      return getCrashRecoveryService().setConfig(config);
    }
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.CRASH_RECOVERY_SET_CONFIG));

  return () => handlers.forEach((cleanup) => cleanup());
}
