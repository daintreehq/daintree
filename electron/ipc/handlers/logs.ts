import { shell } from "electron";
import { CHANNELS } from "../channels.js";
import { logBuffer } from "../../services/LogBuffer.js";
import {
  isVerboseLogging,
  logInfo,
  logDebug,
  logWarn,
  logError,
  getLogFilePath,
  getPreviousSessionTail,
  getLogLevelOverrides,
  setLogLevelOverrides,
  getRegisteredLoggerNames,
  isValidLogOverrideLevel,
  type LogLevel,
} from "../../utils/logger.js";
import type { FilterOptions as LogFilterOptions } from "../../services/LogBuffer.js";
import { typedHandle } from "../utils.js";
import { store } from "../../store.js";
import { AppError } from "../../utils/errorTypes.js";
import type { HandlerDependencies } from "../types.js";

/**
 * When verbose is toggled on, the user's prior `"*"` wildcard (if any) is
 * stashed here so toggling verbose off restores it instead of silently
 * dropping an explicit user override. Module-scoped because verbose state
 * toggling is a global user action that outlives handler registration.
 */
let savedWildcardBeforeVerbose: string | null = null;

function sanitizeOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || typeof key !== "string") continue;
    if (!isValidLogOverrideLevel(value)) continue;
    clean[key] = value;
  }
  return clean;
}

function fanOut(
  overrides: Record<string, string>,
  deps: Pick<HandlerDependencies, "ptyClient" | "worktreeService">
): void {
  deps.ptyClient?.setLogLevelOverrides(overrides);
  deps.worktreeService?.setLogLevelOverrides(overrides);
}

export function registerLogsHandlers(
  deps: Pick<HandlerDependencies, "ptyClient" | "worktreeService"> = {}
): () => void {
  const handlers: Array<() => void> = [];

  const handleLogsGetAll = async (filters?: LogFilterOptions) => {
    const previousSession = getPreviousSessionTail();
    let logs = filters ? logBuffer.getFiltered(filters) : logBuffer.getAll();

    if (previousSession && !filters) {
      const separatorEntry: (typeof logs)[0] = {
        id: "previous-session-separator",
        timestamp: Date.now(),
        level: "info",
        message: "Previous session",
        context: { previousSession: true, tail: previousSession },
        source: undefined,
      };
      logs = [separatorEntry, ...logs];
    }

    return logs;
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

  const handleLogsSetVerbose = async (enabled: boolean): Promise<void> => {
    if (typeof enabled !== "boolean") {
      logError("Invalid verbose logging payload", undefined, { payload: enabled });
      throw new AppError({
        code: "VALIDATION",
        message: "logs:set-verbose requires a boolean",
      });
    }
    // Verbose toggle maps to the `"*"` wildcard override so it flows through
    // the same persistence + utility-process propagation as explicit per-module
    // overrides. Enabling unconditionally sets `"*": "debug"`; disabling
    // restores whatever wildcard existed before the user turned verbose on
    // (tracked in `savedWildcardBeforeVerbose`) so a pre-existing explicit
    // `"*": "warn"` isn't wiped by a verbose on/off cycle.
    const current = sanitizeOverrides(store.get("logLevelOverrides") ?? {});
    if (enabled) {
      if (current["*"] !== "debug") {
        savedWildcardBeforeVerbose = current["*"] ?? null;
      }
      current["*"] = "debug";
    } else {
      if (savedWildcardBeforeVerbose && savedWildcardBeforeVerbose !== "debug") {
        current["*"] = savedWildcardBeforeVerbose;
      } else {
        delete current["*"];
      }
      savedWildcardBeforeVerbose = null;
    }
    store.set("logLevelOverrides", current);
    setLogLevelOverrides(current);
    fanOut(current, deps);
    logInfo(`Verbose logging ${enabled ? "enabled" : "disabled"} by user`);
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

  const handleGetLevelOverrides = async (): Promise<Record<string, string>> => {
    // Return the in-memory sanitized map (not the raw store value) so the UI
    // never shows overrides that the logger silently dropped as invalid.
    return getLogLevelOverrides();
  };
  handlers.push(typedHandle(CHANNELS.LOGS_GET_LEVEL_OVERRIDES, handleGetLevelOverrides));

  const handleSetLevelOverrides = async (overrides: Record<string, string>) => {
    const clean = sanitizeOverrides(overrides);
    store.set("logLevelOverrides", clean);
    setLogLevelOverrides(clean);
    fanOut(clean, deps);
    logInfo("Log level overrides updated", { count: Object.keys(clean).length });
    return { success: true };
  };
  handlers.push(typedHandle(CHANNELS.LOGS_SET_LEVEL_OVERRIDES, handleSetLevelOverrides));

  const handleClearLevelOverrides = async () => {
    // electron-store v11: `set(..., undefined)` throws. Clear by writing the
    // default empty object explicitly.
    store.set("logLevelOverrides", {});
    setLogLevelOverrides({});
    fanOut({}, deps);
    logInfo("Log level overrides cleared");
    return { success: true };
  };
  handlers.push(typedHandle(CHANNELS.LOGS_CLEAR_LEVEL_OVERRIDES, handleClearLevelOverrides));

  const handleGetRegistry = async (): Promise<string[]> => {
    // Main-process registry only. Utility-process loggers are represented via
    // the static manifest in `shared/config/loggerNames.ts`.
    return getRegisteredLoggerNames();
  };
  handlers.push(typedHandle(CHANNELS.LOGS_GET_REGISTRY, handleGetRegistry));

  // Re-hydrate in-process overrides from disk on handler registration — this
  // is the canonical point where main-process logging is wired after `store`
  // is ready, and catches the case where initializeLogger runs before store
  // initialization during some test setups.
  const stored = store.get("logLevelOverrides") ?? {};
  const cleanStored = sanitizeOverrides(stored);
  setLogLevelOverrides(cleanStored);
  fanOut(cleanStored, deps);

  return () => handlers.forEach((cleanup) => cleanup());
}
