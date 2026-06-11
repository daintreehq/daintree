import { app } from "electron";
import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import {
  isGpuDisabledByFlag,
  isGpuAngleFallbackApplied,
  writeGpuDisabledFlag,
  clearGpuDisabledFlag,
  clearGpuAngleFallbackFlag,
} from "../../../services/GpuCrashMonitorService.js";
import { closeTelemetry } from "../../../services/TelemetryService.js";
import { typedHandle } from "../../utils.js";

export function registerGpuHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleGetStatus = () => {
    const userDataPath = app.getPath("userData");
    return {
      hardwareAccelerationDisabled: isGpuDisabledByFlag(userDataPath),
      angleFallbackActive: isGpuAngleFallbackApplied(userDataPath),
    };
  };
  handlers.push(typedHandle(CHANNELS.GPU_GET_STATUS, handleGetStatus));

  const handleSetHardwareAcceleration = async (enabled: boolean) => {
    const userDataPath = app.getPath("userData");
    if (enabled) {
      clearGpuDisabledFlag(userDataPath);
      try {
        clearGpuAngleFallbackFlag(userDataPath);
      } catch (err) {
        // The disabled flag is already gone — proceed with the relaunch so the
        // user's re-enable still lands; a stale ANGLE flag only re-applies the
        // soft fallback switches and clears on the next successful toggle.
        console.warn("[GPU] Failed to clear ANGLE fallback flag on re-enable:", err);
      }
      store.set("gpu", { hardwareAccelerationDisabled: false });
    } else {
      writeGpuDisabledFlag(userDataPath, "user");
      store.set("gpu", { hardwareAccelerationDisabled: true });
    }
    app.relaunch();
    await closeTelemetry();
    app.exit(0);
  };
  handlers.push(typedHandle(CHANNELS.GPU_SET_HARDWARE_ACCELERATION, handleSetHardwareAcceleration));

  return () => handlers.forEach((cleanup) => cleanup());
}
