import { app, shell, session } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import {
  closeTelemetry,
  getTelemetryLevel,
  hasTelemetryPromptBeenShown,
  setTelemetryLevel,
  type TelemetryLevel,
} from "../../services/TelemetryService.js";
import { typedBroadcast, typedHandle } from "../utils.js";
const VALID_LEVELS: TelemetryLevel[] = ["off", "errors", "full"];
const VALID_RETENTION = [7, 30, 90, 0] as const;

export function registerPrivacyHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    typedHandle(CHANNELS.PRIVACY_GET_SETTINGS, () => ({
      telemetryLevel: getTelemetryLevel(),
      logRetentionDays: store.get("privacy")?.logRetentionDays ?? 30,
      dataFolderPath: app.getPath("userData"),
    }))
  );

  cleanups.push(
    typedHandle(CHANNELS.PRIVACY_SET_TELEMETRY_LEVEL, async (level: unknown) => {
      if (typeof level !== "string" || !VALID_LEVELS.includes(level as TelemetryLevel)) return;
      await setTelemetryLevel(level as TelemetryLevel);
      typedBroadcast("privacy:telemetry-consent-changed", {
        level: level as TelemetryLevel,
        hasSeenPrompt: hasTelemetryPromptBeenShown(),
      });
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.PRIVACY_SET_LOG_RETENTION, (days: unknown) => {
      if (
        typeof days !== "number" ||
        !VALID_RETENTION.includes(days as (typeof VALID_RETENTION)[number])
      )
        return;
      store.set("privacy.logRetentionDays", days as 7 | 30 | 90 | 0);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.PRIVACY_OPEN_DATA_FOLDER, () => {
      shell.showItemInFolder(app.getPath("userData"));
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.PRIVACY_CLEAR_CACHE, async () => {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearCodeCaches({});
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.PRIVACY_RESET_ALL_DATA, async () => {
      app.relaunch({ args: process.argv.slice(1).concat(["--reset-data"]) });
      await closeTelemetry();
      app.exit(0);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.PRIVACY_GET_DATA_FOLDER_PATH, () => {
      return app.getPath("userData");
    })
  );

  return () => cleanups.forEach((c) => c());
}
