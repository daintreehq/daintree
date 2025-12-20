import { getErrorDetails } from "./errorTypes.js";
import { appendFileSync, mkdirSync, existsSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import type { BrowserWindow } from "electron";
import { logBuffer, type LogEntry } from "../services/LogBuffer.js";
import { CHANNELS } from "../ipc/channels.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

let storagePath: string | null = null;

function clearSessionLogs(basePath: string): void {
  const logsDir = join(basePath, "logs");
  const debugDir = join(basePath, "debug");

  // Clear main logs directory
  if (existsSync(logsDir)) {
    try {
      const files = readdirSync(logsDir);
      for (const file of files) {
        if (file.endsWith(".log")) {
          const filePath = join(logsDir, file);
          writeFileSync(filePath, "", "utf8");
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  // Clear debug directory (frame-sequences.log, etc.)
  if (existsSync(debugDir)) {
    try {
      const files = readdirSync(debugDir);
      for (const file of files) {
        if (file.endsWith(".log")) {
          const filePath = join(debugDir, file);
          writeFileSync(filePath, "", "utf8");
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  }
}

export function initializeLogger(path: string): void {
  storagePath = path;

  // Clear all log files at startup for single-session logging
  clearSessionLogs(path);
}

function getLogDirectory(): string {
  // Priority 1: Environment variable (Utility Processes)
  if (process.env.CANOPY_USER_DATA) {
    return join(process.env.CANOPY_USER_DATA, "logs");
  }

  // Priority 2: Explicitly initialized path (Main Process)
  if (storagePath) {
    return join(storagePath, "logs");
  }

  // Priority 3: Development fallback
  if (process.env.NODE_ENV === "development") {
    return join(process.cwd(), "logs");
  }

  // Fallback
  return join(process.cwd(), "logs");
}

function getLogFilePath(): string {
  return join(getLogDirectory(), "canopy.log");
}

const SENSITIVE_KEYS = new Set([
  "token",
  "password",
  "apikey",
  "secret",
  "accesstoken",
  "refreshtoken",
]);

const IS_DEBUG_BOOT = process.env.NODE_ENV === "development" || Boolean(process.env.CANOPY_DEBUG);
const IS_TEST = process.env.NODE_ENV === "test";
const ENABLE_FILE_LOGGING = !IS_TEST && process.env.CANOPY_DISABLE_FILE_LOGGING !== "1";

let verboseLogging = IS_DEBUG_BOOT;

export function setVerboseLogging(enabled: boolean): void {
  verboseLogging = enabled;
}

export function isVerboseLogging(): boolean {
  return verboseLogging;
}

let mainWindow: BrowserWindow | null = null;

const LOG_THROTTLE_MS = 16;
let lastLogTime = 0;
let pendingLogs: LogEntry[] = [];
let throttleTimeout: NodeJS.Timeout | null = null;

export function setLoggerWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

function sendLogToRenderer(entry: LogEntry): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  pendingLogs.push(entry);
  const now = Date.now();

  if (now - lastLogTime >= LOG_THROTTLE_MS) {
    flushLogs();
  } else if (!throttleTimeout) {
    throttleTimeout = setTimeout(flushLogs, LOG_THROTTLE_MS);
  }
}

function flushLogs(): void {
  if (throttleTimeout) {
    clearTimeout(throttleTimeout);
    throttleTimeout = null;
  }

  if (pendingLogs.length === 0 || !mainWindow || mainWindow.isDestroyed()) {
    pendingLogs = [];
    return;
  }

  const MAX_LOGS_PER_FLUSH = 60;
  const logsToSend = pendingLogs.slice(0, MAX_LOGS_PER_FLUSH);

  const webContents = mainWindow.webContents;
  if (webContents.isDestroyed()) {
    pendingLogs = [];
    return;
  }

  try {
    webContents.send(CHANNELS.LOGS_BATCH, logsToSend);
  } catch {
    pendingLogs = [];
    return;
  }

  pendingLogs = pendingLogs.slice(MAX_LOGS_PER_FLUSH);
  lastLogTime = Date.now();

  if (pendingLogs.length > 0 && !throttleTimeout) {
    throttleTimeout = setTimeout(flushLogs, LOG_THROTTLE_MS);
  }
}

function getCallerSource(): string | undefined {
  const err = new Error();
  const stack = err.stack?.split("\n");
  if (!stack || stack.length < 4) return undefined;

  const callerLine = stack[4];
  if (!callerLine) return undefined;

  const match = callerLine.match(/\(([^)]+)\)/) || callerLine.match(/at\s+(.+)$/);
  if (!match) return undefined;

  const fullPath = match[1];
  const pathParts = fullPath.split(/[/\\]/);
  const fileName = pathParts[pathParts.length - 1]?.split(":")[0];

  if (fileName?.includes("WorktreeService")) return "WorktreeService";
  if (fileName?.includes("WorktreeMonitor")) return "WorktreeMonitor";
  if (fileName?.includes("PtyManager")) return "PtyManager";
  if (fileName?.includes("CopyTreeService")) return "CopyTreeService";
  if (fileName?.includes("main")) return "Main";
  if (fileName?.includes("handlers")) return "IPC";

  return fileName?.replace(/\.[tj]s$/, "");
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (SENSITIVE_KEYS.has(key)) return "[redacted]";

        if (typeof val === "bigint") return val.toString();

        if (val && typeof val === "object") {
          if (seen.has(val as object)) return "[Circular]";
          seen.add(val as object);
        }

        return val;
      },
      2
    );
  } catch (error) {
    return `[Unable to stringify: ${String(error)}]`;
  }
}

function writeToLogFile(level: string, message: string, context?: LogContext): void {
  if (!ENABLE_FILE_LOGGING) return;

  const normalizedLevel = level.toLowerCase() as LogLevel;
  if (
    normalizedLevel === "debug" &&
    !isVerboseLogging() &&
    process.env.NODE_ENV !== "development"
  ) {
    return;
  }

  try {
    const logFile = getLogFilePath();
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : "";
    const logLine = `[${timestamp}] [${level}] ${message}${contextStr}\n`;

    const logDir = getLogDirectory();
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    appendFileSync(logFile, logLine, "utf8");
  } catch (_error) {
    // ignore
  }
}

function log(level: LogLevel, message: string, context?: LogContext): LogEntry {
  // Only capture source in verbose mode or for errors/warnings
  const source =
    isVerboseLogging() || level === "warn" || level === "error" ? getCallerSource() : undefined;

  const safeContext = context ? redactSensitiveData(context) : undefined;

  const entry = logBuffer.push({
    timestamp: Date.now(),
    level,
    message,
    context: safeContext,
    source,
  });

  sendLogToRenderer(entry);

  return entry;
}

function redactSensitiveData(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = "[redacted]";
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (item && typeof item === "object") {
          return redactSensitiveData(item as Record<string, unknown>);
        }
        return item;
      });
    } else if (value && typeof value === "object") {
      result[key] = redactSensitiveData(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function logDebug(message: string, context?: LogContext): void {
  log("debug", message, context);
  writeToLogFile("DEBUG", message, context);
  if (isVerboseLogging() && !IS_TEST) {
    console.log(`[DEBUG] ${message}`, context ? safeStringify(context) : "");
  }
}

export function logInfo(message: string, context?: LogContext): void {
  log("info", message, context);
  writeToLogFile("INFO", message, context);
  if (isVerboseLogging() && !IS_TEST) {
    console.log(`[INFO] ${message}`, context ? safeStringify(context) : "");
  }
}

export function logWarn(message: string, context?: LogContext): void {
  log("warn", message, context);
  writeToLogFile("WARN", message, context);
  if (isVerboseLogging() && !IS_TEST) {
    console.warn(`[WARN] ${message}`, context ? safeStringify(context) : "");
  }
}

export function logError(message: string, error?: unknown, context?: LogContext): void {
  const errorDetails = error ? getErrorDetails(error) : undefined;
  const fullContext = { ...context, error: errorDetails };
  log("error", message, fullContext);
  writeToLogFile("ERROR", message, fullContext);

  if (IS_TEST) return;

  console.error(
    `[ERROR] ${message}`,
    errorDetails ? safeStringify(errorDetails) : "",
    context ? safeStringify(context) : ""
  );
}
