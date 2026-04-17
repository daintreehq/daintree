import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  hasTelemetryPromptBeenShown,
  markTelemetryPromptShown,
  getTelemetryLevel,
  trackEvent,
} from "../../services/TelemetryService.js";
import { ANALYTICS_EVENTS } from "../../../shared/config/telemetry.js";
import { typedBroadcast } from "../utils.js";

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
    typedBroadcast("privacy:telemetry-consent-changed", {
      level: getTelemetryLevel(),
      hasSeenPrompt: hasTelemetryPromptBeenShown(),
    });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.TELEMETRY_SET_ENABLED));

  ipcMain.handle(CHANNELS.TELEMETRY_MARK_PROMPT_SHOWN, () => {
    markTelemetryPromptShown();
    typedBroadcast("privacy:telemetry-consent-changed", {
      level: getTelemetryLevel(),
      hasSeenPrompt: true,
    });
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
