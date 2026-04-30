import { getErrorDetails } from "./errorTypes.js";
import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { join } from "path";
import { logBuffer, type LogEntry } from "../services/LogBuffer.js";
import { CHANNELS } from "../ipc/channels.js";
import { resilientRenameSync } from "./fs.js";
import { scrubSecrets } from "./secretScrubber.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Override-only levels. `"off"` is a filter sentinel that suppresses all
 * output from a logger; it is never stored on `LogEntry.level`.
 */
export type LogOverrideLevel = LogLevel | "off";

export type LogLevelOverrides = Record<string, LogOverrideLevel>;

interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: unknown, context?: LogContext): void;
  /** Stable identifier used for override lookups and `LogEntry.source`. */
  readonly name: string;
}

/**
 * Numeric ordering so level comparisons are O(1). Lower numbers are more
 * verbose; a message at level X is suppressed when `LEVELS[X] < LEVELS[effective]`.
 * "off" is highest — anything < Infinity is suppressed.
 */
const LEVELS: Record<LogOverrideLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: Number.POSITIVE_INFINITY,
};

const WILDCARD = "*";

let storagePath: string | null = null;

export const ROTATION_MAX_SIZE = 5 * 1024 * 1024;
export const ROTATION_MAX_FILES = 5;
const PREVIOUS_SESSION_TAIL_LINES = 100;
let previousSessionTail: string | null = null;
let isRotating = false;

function preservePreviousSessionTail(basePath: string): void {
  const logFile = join(basePath, "logs", "daintree.log");
  try {
    if (!existsSync(logFile)) {
      return;
    }

    const stats = statSync(logFile);
    if (stats.size === 0) {
      return;
    }

    const lines: string[] = [];
    const handle = openSync(logFile, "r");
    const CHUNK_SIZE = 65536;

    try {
      let cursor = stats.size;
      let buffer = Buffer.alloc(0);

      while (lines.length < PREVIOUS_SESSION_TAIL_LINES - 1 && cursor > 0) {
        const bytesToRead = Math.min(cursor, CHUNK_SIZE);
        cursor -= bytesToRead;

        const chunk = Buffer.alloc(bytesToRead);
        readSync(handle, chunk, 0, bytesToRead, cursor);

        buffer = Buffer.concat([chunk, buffer]);

        const text = buffer.toString("utf8");
        const splitLines = text.split(/\r?\n/);
        const lastLine = splitLines.pop() ?? "";

        buffer = Buffer.from(lastLine, "utf8");

        for (let i = splitLines.length - 1; i >= 0; i--) {
          const line = splitLines[i].trim();
          if (line) {
            lines.push(line);
          }
          if (lines.length >= PREVIOUS_SESSION_TAIL_LINES - 1) {
            break;
          }
        }
      }

      lines.reverse();

      if (buffer.length > 0) {
        const lastLine = buffer.toString("utf8").trim();
        if (lastLine) {
          lines.push(lastLine);
        }
      }

      previousSessionTail = lines.join("\n");
    } finally {
      closeSync(handle);
    }
  } catch {
    previousSessionTail = null;
  }
}

function rotateLogsIfNeeded(): boolean {
  if (isRotating) return true;

  const logFile = getLogFilePath();
  try {
    if (!existsSync(logFile)) return true;

    const stats = statSync(logFile);
    if (stats.size < ROTATION_MAX_SIZE) return true;

    isRotating = true;

    const logDir = getLogDirectory();
    let rotationSucceeded = true;

    for (let i = ROTATION_MAX_FILES - 1; i >= 1; i--) {
      const oldFile = join(logDir, `daintree.log.${i}`);
      const newFile = join(logDir, `daintree.log.${i + 1}`);

      if (existsSync(oldFile)) {
        if (i === ROTATION_MAX_FILES - 1) {
          try {
            unlinkSync(oldFile);
          } catch {
            rotationSucceeded = false;
          }
        } else {
          try {
            resilientRenameSync(oldFile, newFile);
          } catch {
            rotationSucceeded = false;
          }
        }
      }
    }

    try {
      resilientRenameSync(logFile, join(logDir, "daintree.log.1"));
    } catch {
      rotationSucceeded = false;
    }

    return rotationSucceeded;
  } catch {
    return false;
  } finally {
    isRotating = false;
  }
}

function clearDebugLogs(basePath: string): void {
  const debugDir = join(basePath, "debug");
  if (!existsSync(debugDir)) return;

  try {
    const files = readdirSync(debugDir);
    for (const file of files) {
      if (!file.endsWith(".log")) continue;
      try {
        writeFileSync(join(debugDir, file), "", "utf8");
      } catch {
        // Skip locked or inaccessible files (Windows antivirus, etc.)
      }
    }
  } catch {
    // Directory read failed — non-fatal
  }
}

export function initializeLogger(path: string): void {
  storagePath = path;

  preservePreviousSessionTail(path);
  clearDebugLogs(path);
}

export function getPreviousSessionTail(): string | null {
  return previousSessionTail;
}

export function resetLoggerStateForTesting(): void {
  previousSessionTail = null;
  isRotating = false;
  storagePath = null;
  loggerRegistry.clear();
  levelOverrides.clear();
  defaultLevel = IS_DEBUG_BOOT ? "debug" : "info";
}

export function pruneOldLogs(basePath: string, retentionDays: number | 0): void {
  if (retentionDays === 0) return;

  const threshold = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const dirs = [join(basePath, "logs"), join(basePath, "debug")];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        try {
          const filePath = join(dir, file);
          const stats = statSync(filePath);
          if (stats.isFile() && stats.mtimeMs < threshold) {
            unlinkSync(filePath);
          }
        } catch {
          // Skip locked or inaccessible files
        }
      }
    } catch {
      // Directory read failed — non-fatal
    }
  }
}

export function getLogDirectory(): string {
  // Priority 1: Environment variable (Utility Processes)
  if (process.env.DAINTREE_USER_DATA) {
    return join(process.env.DAINTREE_USER_DATA, "logs");
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

export function getLogFilePath(): string {
  return join(getLogDirectory(), "daintree.log");
}

const SENSITIVE_KEYS = new Set([
  "token",
  "password",
  "apikey",
  "secret",
  "accesstoken",
  "refreshtoken",
  "lastoutput",
  "authorization",
  "cookie",
  "session",
  "clientsecret",
  "privatekey",
]);

const IS_DEBUG_BOOT = process.env.NODE_ENV === "development" || Boolean(process.env.DAINTREE_DEBUG);
const IS_TEST = process.env.NODE_ENV === "test";
const ENABLE_FILE_LOGGING = !IS_TEST && process.env.DAINTREE_DISABLE_FILE_LOGGING !== "1";

/**
 * Effective level for a logger resolves in order:
 *   exact name → process-scoped wildcard (`"<proc>:*"`) → global `"*"` → defaultLevel.
 *
 * The map is a single module-level singleton so live updates (e.g. from an IPC
 * message received after boot) propagate to all loggers without recreating
 * factory instances.
 */
const levelOverrides = new Map<string, LogOverrideLevel>();
const loggerRegistry = new Set<string>();

let defaultLevel: LogOverrideLevel = IS_DEBUG_BOOT ? "debug" : "info";

/** Detect the process this logger runs in — baked into generated names. */
function detectProcessTag(): "main" | "pty-host" | "workspace-host" | "utility" {
  // Utility processes have parentPort; main does not.
  if (typeof process !== "undefined" && (process as { parentPort?: unknown }).parentPort) {
    if (process.env.DAINTREE_UTILITY_PROCESS_KIND === "pty-host") return "pty-host";
    if (process.env.DAINTREE_UTILITY_PROCESS_KIND === "workspace-host") return "workspace-host";
    return "utility";
  }
  return "main";
}

const PROCESS_TAG = detectProcessTag();

function processWildcardKey(loggerName: string): string {
  const colon = loggerName.indexOf(":");
  if (colon <= 0) return `${PROCESS_TAG}:*`;
  return `${loggerName.slice(0, colon)}:*`;
}

function resolveEffectiveLevel(loggerName: string): LogOverrideLevel {
  const exact = levelOverrides.get(loggerName);
  if (exact !== undefined) return exact;
  const procWildcard = levelOverrides.get(processWildcardKey(loggerName));
  if (procWildcard !== undefined) return procWildcard;
  const globalWildcard = levelOverrides.get(WILDCARD);
  if (globalWildcard !== undefined) return globalWildcard;
  return defaultLevel;
}

function shouldLog(loggerName: string, level: LogLevel): boolean {
  const effective = resolveEffectiveLevel(loggerName);
  if (effective === "off") return false;
  return LEVELS[level] >= LEVELS[effective];
}

/**
 * Replace the entire override map atomically. Passing `{}` clears all
 * overrides. Validates every value against the known level set; unknown
 * values are dropped with a warning rather than rejected, so a malformed
 * persisted entry doesn't brick the app.
 */
export function setLogLevelOverrides(overrides: Record<string, string>): void {
  levelOverrides.clear();
  if (!overrides || typeof overrides !== "object") return;

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof key !== "string" || !key) continue;
    if (!isValidLogOverrideLevel(value)) {
      console.warn(`[logger] Dropping invalid override: ${key} = ${String(value)}`);
      continue;
    }
    levelOverrides.set(key, value);
  }
}

export function getLogLevelOverrides(): Record<string, LogOverrideLevel> {
  return Object.fromEntries(levelOverrides.entries());
}

export function isValidLogOverrideLevel(value: unknown): value is LogOverrideLevel {
  return (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error" ||
    value === "off"
  );
}

/**
 * Register a logger name and return an instance bound to that name. Callers
 * pass a stable `"<process>:Module"` identifier — these survive minification
 * (unlike the old stack-inference fallback).
 */
export function createLogger(name: string): Logger {
  if (typeof name !== "string") {
    throw new Error("createLogger requires a string name");
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("createLogger requires a non-empty name");
  }
  if (trimmed !== name) {
    throw new Error(`createLogger name must not contain leading/trailing whitespace: "${name}"`);
  }
  loggerRegistry.add(name);
  return {
    name,
    debug: (message, context) => emit(name, "debug", message, context),
    info: (message, context) => emit(name, "info", message, context),
    warn: (message, context) => emit(name, "warn", message, context),
    error: (message, error, context) => emitError(name, message, error, context),
  };
}

/** Enumerate loggers registered in this process (e.g. for diagnostics UI). */
export function getRegisteredLoggerNames(): string[] {
  return Array.from(loggerRegistry).sort();
}

const LOG_THROTTLE_MS = 16;
let lastLogTime = 0;
let pendingLogs: LogEntry[] = [];
let throttleTimeout: NodeJS.Timeout | null = null;

type BroadcastFn = (channel: string, ...args: unknown[]) => void;
type HasWindowFn = () => boolean;

let registeredBroadcast: BroadcastFn | null = null;
let registeredHasWindow: HasWindowFn | null = null;

/**
 * Register renderer broadcast functions. Called by the main process only —
 * utility processes (pty-host, workspace-host) never call this, so they
 * never pull in BrowserWindow or ipc/utils via the bundler.
 */
export function registerLoggerTransport(broadcast: BroadcastFn, hasWindow: HasWindowFn): void {
  registeredBroadcast = broadcast;
  registeredHasWindow = hasWindow;
}

function getBroadcast(): BroadcastFn | null {
  return registeredBroadcast;
}

function hasAnyWindow(): boolean {
  return registeredHasWindow ? registeredHasWindow() : false;
}

function sendLogToRenderer(entry: LogEntry): void {
  if (!hasAnyWindow()) {
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

  if (pendingLogs.length === 0 || !hasAnyWindow()) {
    pendingLogs = [];
    return;
  }

  const MAX_LOGS_PER_FLUSH = 60;
  const logsToSend = pendingLogs.slice(0, MAX_LOGS_PER_FLUSH);

  const broadcast = getBroadcast();
  if (!broadcast) {
    pendingLogs = [];
    return;
  }

  try {
    broadcast(CHANNELS.LOGS_BATCH, logsToSend);
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

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const sensitivePatterns = ["secret", "token", "password", "key"];

  try {
    return JSON.stringify(
      value,
      (key, val) => {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_KEYS.has(lowerKey)) return "[redacted]";

        if (sensitivePatterns.some((pattern) => lowerKey.includes(pattern))) {
          return "[redacted]";
        }

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

  try {
    const logFile = getLogFilePath();
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${safeStringify(context)}` : "";
    const logLine = `[${timestamp}] [${level}] ${message}${contextStr}\n`;

    const logDir = getLogDirectory();
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    if (!rotateLogsIfNeeded()) {
      return;
    }
    appendFileSync(logFile, scrubSecrets(logLine), "utf8");
  } catch (_error) {
    // ignore
  }
}

function redactSensitiveData(
  obj: Record<string, unknown>,
  visited = new WeakSet<object>()
): Record<string, unknown> {
  if (visited.has(obj)) {
    return "[Circular]" as unknown as Record<string, unknown>;
  }
  visited.add(obj);

  const sensitivePatterns = ["secret", "token", "password", "key"];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      SENSITIVE_KEYS.has(lowerKey) ||
      sensitivePatterns.some((pattern) => lowerKey.includes(pattern))
    ) {
      result[key] = "[redacted]";
    } else if (Array.isArray(value)) {
      result[key] = redactArrayWithCycleDetection(value, visited);
    } else if (value !== null && typeof value === "object") {
      result[key] = redactSensitiveData(value as Record<string, unknown>, visited);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function redactArrayWithCycleDetection(arr: unknown[], visited: WeakSet<object>): unknown[] {
  if (visited.has(arr)) {
    return "[Circular]" as unknown as unknown[];
  }
  visited.add(arr);

  return arr.map((item) => {
    if (item === null) {
      return item;
    }
    if (Array.isArray(item)) {
      return redactArrayWithCycleDetection(item, visited);
    }
    if (typeof item === "object") {
      return redactSensitiveData(item as Record<string, unknown>, visited);
    }
    return item;
  });
}

function emit(source: string, level: LogLevel, message: string, context?: LogContext): void {
  if (!shouldLog(source, level)) return;

  const safeContext = context ? redactSensitiveData(context) : undefined;

  const entry = logBuffer.push({
    timestamp: Date.now(),
    level,
    message,
    context: safeContext,
    source,
  });

  sendLogToRenderer(entry);
  writeToLogFile(level.toUpperCase(), message, safeContext);

  if (!IS_TEST) {
    const prefix = `[${level.toUpperCase()}] [${source}]`;
    const consoleFn =
      level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleFn(
      `${prefix} ${scrubSecrets(message)}`,
      context ? scrubSecrets(safeStringify(safeContext)) : ""
    );
  }
}

function emitError(source: string, message: string, error?: unknown, context?: LogContext): void {
  if (!shouldLog(source, "error")) return;

  const errorDetails = error ? getErrorDetails(error) : undefined;
  const safeContext = redactSensitiveData({ ...context, error: errorDetails });

  const entry = logBuffer.push({
    timestamp: Date.now(),
    level: "error",
    message,
    context: safeContext,
    source,
  });

  sendLogToRenderer(entry);
  writeToLogFile("ERROR", message, safeContext);

  if (!IS_TEST) {
    console.error(
      `[ERROR] [${source}] ${scrubSecrets(message)}`,
      errorDetails ? scrubSecrets(safeStringify(errorDetails)) : "",
      context ? scrubSecrets(safeStringify(context)) : ""
    );
  }
}

// --- Backward-compat shims --------------------------------------------------
// The bare `logDebug/logInfo/logWarn/logError` free functions remain wired to
// a shared `"main"` logger so unmigrated call-sites still compile and route
// through the override machinery. Migrated modules should use `createLogger`
// with a stable `"<process>:Module"` name instead.

const defaultSharedLogger = createLogger(`${PROCESS_TAG}:default`);

export function setVerboseLogging(enabled: boolean): void {
  if (enabled) {
    const copy = getLogLevelOverrides();
    copy[WILDCARD] = "debug";
    setLogLevelOverrides(copy);
  } else {
    const copy = getLogLevelOverrides();
    delete copy[WILDCARD];
    setLogLevelOverrides(copy);
  }
}

export function isVerboseLogging(): boolean {
  return levelOverrides.get(WILDCARD) === "debug";
}

export function logDebug(message: string, context?: LogContext): void {
  defaultSharedLogger.debug(message, context);
}

export function logInfo(message: string, context?: LogContext): void {
  defaultSharedLogger.info(message, context);
}

export function logWarn(message: string, context?: LogContext): void {
  defaultSharedLogger.warn(message, context);
}

export function logError(message: string, error?: unknown, context?: LogContext): void {
  defaultSharedLogger.error(message, error, context);
}
