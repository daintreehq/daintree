import { app, shell, session } from "electron";
import { store } from "../../store.js";
import {
  closeTelemetry,
  getTelemetryLevel,
  hasTelemetryPromptBeenShown,
  setTelemetryLevel,
} from "../../services/TelemetryService.js";
import { typedBroadcast } from "../utils.js";
import { defineIpcNamespace, op } from "../define.js";
import { PRIVACY_METHOD_CHANNELS } from "./privacy.preload.js";

type TelemetryLevel = "off" | "errors" | "full";
const VALID_LEVELS: TelemetryLevel[] = ["off", "errors", "full"];
const VALID_RETENTION = [7, 30, 90, 0] as const;
type LogRetentionDays = (typeof VALID_RETENTION)[number];

export const privacyNamespace = defineIpcNamespace({
  name: "privacy",
  ops: {
    getSettings: op(
      PRIVACY_METHOD_CHANNELS.getSettings,
      (): {
        telemetryLevel: "off" | "errors" | "full";
        logRetentionDays: 0 | 7 | 30 | 90;
        dataFolderPath: string;
      } => ({
        telemetryLevel: getTelemetryLevel(),
        logRetentionDays: (store.get("privacy")?.logRetentionDays as LogRetentionDays) ?? 30,
        dataFolderPath: app.getPath("userData"),
      })
    ),
    setTelemetryLevel: op(
      PRIVACY_METHOD_CHANNELS.setTelemetryLevel,
      async (level: "off" | "errors" | "full"): Promise<void> => {
        if (typeof level !== "string" || !VALID_LEVELS.includes(level)) return;
        await setTelemetryLevel(level);
        typedBroadcast("privacy:telemetry-consent-changed", {
          level,
          hasSeenPrompt: hasTelemetryPromptBeenShown(),
        });
      }
    ),
    setLogRetention: op(PRIVACY_METHOD_CHANNELS.setLogRetention, (days: LogRetentionDays): void => {
      if (typeof days !== "number" || !VALID_RETENTION.includes(days)) return;
      store.set("privacy.logRetentionDays", days);
    }),
    openDataFolder: op(PRIVACY_METHOD_CHANNELS.openDataFolder, (): void => {
      shell.showItemInFolder(app.getPath("userData"));
    }),
    clearCache: op(PRIVACY_METHOD_CHANNELS.clearCache, async (): Promise<void> => {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearCodeCaches({});
    }),
    resetAllData: op(PRIVACY_METHOD_CHANNELS.resetAllData, async (): Promise<void> => {
      app.relaunch({ args: process.argv.slice(1).concat(["--reset-data"]) });
      await closeTelemetry();
      app.exit(0);
    }),
    getDataFolderPath: op(PRIVACY_METHOD_CHANNELS.getDataFolderPath, (): string => {
      return app.getPath("userData");
    }),
  },
});

export function registerPrivacyHandlers(): () => void {
  return privacyNamespace.register();
}
