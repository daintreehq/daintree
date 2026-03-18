import { ipcMain, app } from "electron";
import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import {
  isGpuDisabledByFlag,
  writeGpuDisabledFlag,
  clearGpuDisabledFlag,
} from "../../../services/GpuCrashMonitorService.js";

export function registerGpuHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleGetStatus = () => {
    const userDataPath = app.getPath("userData");
    return {
      hardwareAccelerationDisabled: isGpuDisabledByFlag(userDataPath),
    };
  };
  ipcMain.handle(CHANNELS.GPU_GET_STATUS, handleGetStatus);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GPU_GET_STATUS));

  const handleSetHardwareAcceleration = (_event: Electron.IpcMainInvokeEvent, enabled: boolean) => {
    const userDataPath = app.getPath("userData");
    if (enabled) {
      clearGpuDisabledFlag(userDataPath);
      store.set("gpu", { hardwareAccelerationDisabled: false });
    } else {
      writeGpuDisabledFlag(userDataPath);
      store.set("gpu", { hardwareAccelerationDisabled: true });
    }
    app.relaunch();
    app.exit(0);
  };
  ipcMain.handle(CHANNELS.GPU_SET_HARDWARE_ACCELERATION, handleSetHardwareAcceleration);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GPU_SET_HARDWARE_ACCELERATION));

  return () => handlers.forEach((cleanup) => cleanup());
}
