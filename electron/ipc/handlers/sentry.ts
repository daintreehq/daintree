import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { getTelemetryLevel, hasTelemetryPromptBeenShown } from "../../services/TelemetryService.js";

function handleGetConsentState(): { level: "off" | "errors" | "full"; hasSeenPrompt: boolean } {
  return {
    level: getTelemetryLevel(),
    hasSeenPrompt: hasTelemetryPromptBeenShown(),
  };
}

export const sentryNamespace = defineIpcNamespace({
  name: "sentry",
  ops: {
    getConsentState: op(CHANNELS.SENTRY_GET_CONSENT_STATE, handleGetConsentState),
  },
});

export function registerSentryHandlers(): () => void {
  return sentryNamespace.register();
}
