import { app, shell, session } from "electron";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { store } from "../../store.js";
import {
  closeTelemetry,
  getTelemetryLevel,
  hasTelemetryPromptBeenShown,
  setTelemetryLevel,
} from "../../services/TelemetryService.js";
import { typedBroadcast } from "../utils.js";

const VALID_LEVELS: Array<"off" | "errors" | "full"> = ["off", "errors", "full"];
const VALID_RETENTION = [7, 30, 90, 0] as const;

type LogRetentionDays = (typeof VALID_RETENTION)[number];

function handleGetSettings(): {
  telemetryLevel: "off" | "errors" | "full";
  logRetentionDays: 0 | 7 | 30 | 90;
  dataFolderPath: string;
} {
  return {
    telemetryLevel: getTelemetryLevel(),
    logRetentionDays: store.get("privacy")?.logRetentionDays ?? 30,
    dataFolderPath: app.getPath("userData"),
  };
}

async function handleSetTelemetryLevel(level: "off" | "errors" | "full"): Promise<void> {
  if (typeof level !== "string" || !VALID_LEVELS.includes(level)) return;
  await setTelemetryLevel(level);
  typedBroadcast("privacy:telemetry-consent-changed", {
    level,
    hasSeenPrompt: hasTelemetryPromptBeenShown(),
  });
}

function handleSetLogRetention(days: LogRetentionDays): void {
  if (typeof days !== "number" || !VALID_RETENTION.includes(days)) return;
  store.set("privacy.logRetentionDays", days);
}

function handleOpenDataFolder(): void {
  shell.showItemInFolder(app.getPath("userData"));
}

async function handleClearCache(): Promise<void> {
  await session.defaultSession.clearCache();
  await session.defaultSession.clearCodeCaches({});
}

async function handleResetAllData(): Promise<void> {
  app.relaunch({ args: process.argv.slice(1).concat(["--reset-data"]) });
  await closeTelemetry();
  app.exit(0);
}

function handleGetDataFolderPath(): string {
  return app.getPath("userData");
}

export const privacyNamespace = defineIpcNamespace({
  name: "privacy",
  ops: {
    getSettings: op(CHANNELS.PRIVACY_GET_SETTINGS, handleGetSettings),
    setTelemetryLevel: op(CHANNELS.PRIVACY_SET_TELEMETRY_LEVEL, handleSetTelemetryLevel),
    setLogRetention: op(CHANNELS.PRIVACY_SET_LOG_RETENTION, handleSetLogRetention),
    openDataFolder: op(CHANNELS.PRIVACY_OPEN_DATA_FOLDER, handleOpenDataFolder),
    clearCache: op(CHANNELS.PRIVACY_CLEAR_CACHE, handleClearCache),
    resetAllData: op(CHANNELS.PRIVACY_RESET_ALL_DATA, handleResetAllData),
    getDataFolderPath: op(CHANNELS.PRIVACY_GET_DATA_FOLDER_PATH, handleGetDataFolderPath),
  },
});

export function registerPrivacyHandlers(): () => void {
  return privacyNamespace.register();
}
