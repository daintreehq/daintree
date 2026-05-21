import { getTelemetryLevel, hasTelemetryPromptBeenShown } from "../../services/TelemetryService.js";
import { defineIpcNamespace, op } from "../define.js";
import { SENTRY_METHOD_CHANNELS } from "./sentry.preload.js";

export const sentryNamespace = defineIpcNamespace({
  name: "sentry",
  ops: {
    getConsentState: op(
      SENTRY_METHOD_CHANNELS.getConsentState,
      (): { level: "off" | "errors" | "full"; hasSeenPrompt: boolean } => ({
        level: getTelemetryLevel(),
        hasSeenPrompt: hasTelemetryPromptBeenShown(),
      })
    ),
  },
});

export function registerSentryHandlers(): () => void {
  return sentryNamespace.register();
}
