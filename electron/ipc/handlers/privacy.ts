import { ipcMain, app, shell, session } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import {
  getTelemetryLevel,
  setTelemetryLevel,
  type TelemetryLevel,
} from "../../services/TelemetryService.js";

const VALID_LEVELS: TelemetryLevel[] = ["off", "errors", "full"];
const VALID_RETENTION = [7, 30, 90, 0] as const;

export function registerPrivacyHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  ipcMain.handle(CHANNELS.PRIVACY_GET_SETTINGS, () => ({
    telemetryLevel: getTelemetryLevel(),
    logRetentionDays: store.get("privacy")?.logRetentionDays ?? 30,
    dataFolderPath: app.getPath("userData"),
  }));
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.PRIVACY_GET_SETTINGS));

  ipcMain.handle(CHANNELS.PRIVACY_SET_TELEMETRY_LEVEL, async (_event, level: unknown) => {
    if (typeof level !== "string" || !VALID_LEVELS.includes(level as TelemetryLevel)) return;
    await setTelemetryLevel(level as TelemetryLevel);
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.PRIVACY_SET_TELEMETRY_LEVEL));

  ipcMain.handle(CHANNELS.PRIVACY_SET_LOG_RETENTION, (_event, days: unknown) => {
    if (
      typeof days !== "number" ||
      !VALID_RETENTION.includes(days as (typeof VALID_RETENTION)[number])
    )
      return;
    const privacy = store.get("privacy") ?? {
      telemetryLevel: "off" as const,
      logRetentionDays: 30 as const,
    };
    store.set("privacy", { ...privacy, logRetentionDays: days as 7 | 30 | 90 | 0 });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.PRIVACY_SET_LOG_RETENTION));

  ipcMain.handle(CHANNELS.PRIVACY_OPEN_DATA_FOLDER, () => {
    shell.showItemInFolder(app.getPath("userData"));
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.PRIVACY_OPEN_DATA_FOLDER));

  ipcMain.handle(CHANNELS.PRIVACY_CLEAR_CACHE, async () => {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearCodeCaches({});
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.PRIVACY_CLEAR_CACHE));

  ipcMain.handle(CHANNELS.PRIVACY_RESET_ALL_DATA, () => {
    app.relaunch({ args: process.argv.slice(1).concat(["--reset-data"]) });
    app.exit(0);
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.PRIVACY_RESET_ALL_DATA));

  ipcMain.handle(CHANNELS.PRIVACY_GET_DATA_FOLDER_PATH, () => {
    return app.getPath("userData");
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.PRIVACY_GET_DATA_FOLDER_PATH));

  return () => cleanups.forEach((c) => c());
}
