import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  hasTelemetryPromptBeenShown,
  markTelemetryPromptShown,
} from "../../services/TelemetryService.js";

export function registerTelemetryHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  ipcMain.handle(CHANNELS.TELEMETRY_GET, () => ({
    enabled: isTelemetryEnabled(),
    hasSeenPrompt: hasTelemetryPromptBeenShown(),
  }));
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.TELEMETRY_GET));

  ipcMain.handle(CHANNELS.TELEMETRY_SET_ENABLED, (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") return;
    setTelemetryEnabled(enabled);
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.TELEMETRY_SET_ENABLED));

  ipcMain.handle(CHANNELS.TELEMETRY_MARK_PROMPT_SHOWN, () => {
    markTelemetryPromptShown();
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.TELEMETRY_MARK_PROMPT_SHOWN));

  return () => cleanups.forEach((c) => c());
}
