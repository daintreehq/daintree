import { ipcMain, shell } from "electron";
import { CHANNELS } from "../channels.js";
import { logBuffer } from "../../services/LogBuffer.js";
import {
  setVerboseLogging,
  isVerboseLogging,
  logInfo,
  logDebug,
  logWarn,
  logError,
  getLogFilePath,
  type LogLevel,
} from "../../utils/logger.js";
import type { FilterOptions as LogFilterOptions } from "../../services/LogBuffer.js";

export function registerLogsHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleLogsGetAll = async (
    _event: Electron.IpcMainInvokeEvent,
    filters?: LogFilterOptions
  ) => {
    if (filters) {
      return logBuffer.getFiltered(filters);
    }
    return logBuffer.getAll();
  };
  ipcMain.handle(CHANNELS.LOGS_GET_ALL, handleLogsGetAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_GET_ALL));

  const handleLogsGetSources = async () => {
    return logBuffer.getSources();
  };
  ipcMain.handle(CHANNELS.LOGS_GET_SOURCES, handleLogsGetSources);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_GET_SOURCES));

  const handleLogsClear = async () => {
    logBuffer.clear();
  };
  ipcMain.handle(CHANNELS.LOGS_CLEAR, handleLogsClear);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_CLEAR));

  const handleLogsOpenFile = async () => {
    const logFilePath = getLogFilePath();
    try {
      const fs = await import("fs");
      await fs.promises.access(logFilePath);
      const openResult = await shell.openPath(logFilePath);
      if (openResult) {
        const { dirname } = await import("path");
        await shell.openPath(dirname(logFilePath));
      }
    } catch (error) {
      const fs = await import("fs");
      const { dirname } = await import("path");
      const dir = dirname(logFilePath);

      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.writeFile(logFilePath, "", "utf8");
          const openResult = await shell.openPath(logFilePath);
          if (openResult) {
            await shell.openPath(dir);
          }
        } catch {
          await shell.openPath(dir);
        }
      } else {
        await shell.openPath(dir);
      }
    }
  };
  ipcMain.handle(CHANNELS.LOGS_OPEN_FILE, handleLogsOpenFile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_OPEN_FILE));

  const handleLogsSetVerbose = async (_event: Electron.IpcMainInvokeEvent, enabled: boolean) => {
    if (typeof enabled !== "boolean") {
      logError("Invalid verbose logging payload", undefined, { payload: enabled });
      return { success: false };
    }
    setVerboseLogging(enabled);
    logInfo(`Verbose logging ${enabled ? "enabled" : "disabled"} by user`);
    return { success: true };
  };
  ipcMain.handle(CHANNELS.LOGS_SET_VERBOSE, handleLogsSetVerbose);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_SET_VERBOSE));

  const handleLogsGetVerbose = async () => {
    return isVerboseLogging();
  };
  ipcMain.handle(CHANNELS.LOGS_GET_VERBOSE, handleLogsGetVerbose);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_GET_VERBOSE));

  const handleLogsWrite = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { level: LogLevel; message: string; context?: Record<string, unknown> }
  ) => {
    const { level, message, context } = payload;
    const contextWithSource = { ...context, source: "Renderer" };
    switch (level) {
      case "debug":
        logDebug(message, contextWithSource);
        break;
      case "info":
        logInfo(message, contextWithSource);
        break;
      case "warn":
        logWarn(message, contextWithSource);
        break;
      case "error":
        logError(message, context?.error, contextWithSource);
        break;
    }
  };
  ipcMain.handle(CHANNELS.LOGS_WRITE, handleLogsWrite);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_WRITE));

  return () => handlers.forEach((cleanup) => cleanup());
}
