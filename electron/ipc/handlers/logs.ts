import { shell } from "electron";
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
import { typedHandle } from "../utils.js";

export function registerLogsHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleLogsGetAll = async (filters?: LogFilterOptions) => {
    if (filters) {
      return logBuffer.getFiltered(filters);
    }
    return logBuffer.getAll();
  };
  handlers.push(typedHandle(CHANNELS.LOGS_GET_ALL, handleLogsGetAll));

  const handleLogsGetSources = async () => {
    return logBuffer.getSources();
  };
  handlers.push(typedHandle(CHANNELS.LOGS_GET_SOURCES, handleLogsGetSources));

  const handleLogsClear = async () => {
    logBuffer.clear();
  };
  handlers.push(typedHandle(CHANNELS.LOGS_CLEAR, handleLogsClear));

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
  handlers.push(typedHandle(CHANNELS.LOGS_OPEN_FILE, handleLogsOpenFile));

  const handleLogsSetVerbose = async (enabled: boolean) => {
    if (typeof enabled !== "boolean") {
      logError("Invalid verbose logging payload", undefined, { payload: enabled });
      return { success: false };
    }
    setVerboseLogging(enabled);
    logInfo(`Verbose logging ${enabled ? "enabled" : "disabled"} by user`);
    return { success: true };
  };
  handlers.push(typedHandle(CHANNELS.LOGS_SET_VERBOSE, handleLogsSetVerbose));

  const handleLogsGetVerbose = async () => {
    return isVerboseLogging();
  };
  handlers.push(typedHandle(CHANNELS.LOGS_GET_VERBOSE, handleLogsGetVerbose));

  const handleLogsWrite = async (payload: {
    level: LogLevel;
    message: string;
    context?: Record<string, unknown>;
  }) => {
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
  handlers.push(typedHandle(CHANNELS.LOGS_WRITE, handleLogsWrite));

  return () => handlers.forEach((cleanup) => cleanup());
}
