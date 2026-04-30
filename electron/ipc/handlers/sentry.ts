import { CHANNELS } from "../channels.js";
import { getTelemetryLevel, hasTelemetryPromptBeenShown } from "../../services/TelemetryService.js";
import { typedHandle } from "../utils.js";

export function registerSentryHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    typedHandle(CHANNELS.SENTRY_GET_CONSENT_STATE, () => ({
      level: getTelemetryLevel(),
      hasSeenPrompt: hasTelemetryPromptBeenShown(),
    }))
  );

  return () => cleanups.forEach((c) => c());
}
