import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { getTelemetryLevel, hasTelemetryPromptBeenShown } from "../../services/TelemetryService.js";

export function registerSentryHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  ipcMain.handle(CHANNELS.SENTRY_GET_CONSENT_STATE, () => ({
    level: getTelemetryLevel(),
    hasSeenPrompt: hasTelemetryPromptBeenShown(),
  }));
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.SENTRY_GET_CONSENT_STATE));

  return () => cleanups.forEach((c) => c());
}
