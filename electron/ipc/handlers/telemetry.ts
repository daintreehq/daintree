import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  hasTelemetryPromptBeenShown,
  markTelemetryPromptShown,
  trackEvent,
} from "../../services/TelemetryService.js";
import { ANALYTICS_EVENTS } from "../../../shared/config/telemetry.js";

const ALLOWED_EVENTS = new Set<string>(ANALYTICS_EVENTS);

export function registerTelemetryHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  ipcMain.handle(CHANNELS.TELEMETRY_GET, () => ({
    enabled: isTelemetryEnabled(),
    hasSeenPrompt: hasTelemetryPromptBeenShown(),
  }));
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.TELEMETRY_GET));

  ipcMain.handle(CHANNELS.TELEMETRY_SET_ENABLED, async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") return;
    await setTelemetryEnabled(enabled);
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.TELEMETRY_SET_ENABLED));

  ipcMain.handle(CHANNELS.TELEMETRY_MARK_PROMPT_SHOWN, () => {
    markTelemetryPromptShown();
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.TELEMETRY_MARK_PROMPT_SHOWN));

  ipcMain.handle(CHANNELS.TELEMETRY_TRACK, (_event, eventName: unknown, properties: unknown) => {
    if (typeof eventName !== "string" || !ALLOWED_EVENTS.has(eventName)) return;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return;
    trackEvent(eventName, properties as Record<string, unknown>);
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.TELEMETRY_TRACK));

  return () => cleanups.forEach((c) => c());
}
