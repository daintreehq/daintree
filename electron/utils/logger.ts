// eager-import-allow: writes logs via sync fs so early-boot logs survive a crash before async transports exist
import { configure } from "safe-stable-stringify";
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
  promises as fsp,
} from "fs";
import { join } from "path";
import { logBuffer, type LogEntry } from "../services/LogBuffer.js";
import { CHANNELS } from "../ipc/channels.js";
import { resilientRenameSync } from "./fs.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";
import { isErrorLike, serializeError } from "../../shared/utils/ipcErrorSerialization.js";
import { getWritesSuppressed } from "../services/diskPressureState.js";

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
  trackedLogFile = null;
  trackedLogSize = -1;
  bytesSinceSizeRefresh = 0;
  // Drop any buffered async writes so a deferred flush can't bleed into the
  // next test (an already-scheduled setImmediate finds an empty buffer).
  pendingLogLines = [];
  pendingLogBytes = 0;
  asyncFlushScheduled = false;
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

/**
 * Async twin of {@link pruneOldLogs}. Uses `fs/promises` so the scan/delete pass
 * yields to the event loop between files instead of blocking it with sync fs.
 * Use this from async contexts (e.g. the deferred-init queue); keep the sync
 * version for callers that run in a synchronous context (DiskSpaceMonitor).
 */
export async function pruneOldLogsAsync(
  basePath: string,
  retentionDays: number | 0
): Promise<void> {
  if (retentionDays === 0) return;

  const threshold = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const dirs = [join(basePath, "logs"), join(basePath, "debug")];

  for (const dir of dirs) {
    try {
      const handle = await fsp.opendir(dir);
      for await (const dirent of handle) {
        // dirent.isFile() (unlike the sync twin's statSync().isFile()) does not
        // follow symlinks; log dirs in userData never contain symlinks, so this
        // is equivalent in practice while avoiding an extra stat per entry.
        if (!dirent.isFile()) continue;
        try {
          const filePath = join(dir, dirent.name);
          const stats = await fsp.stat(filePath);
          if (stats.mtimeMs < threshold) {
            await fsp.unlink(filePath);
          }
        } catch {
          // Skip locked or inaccessible files
        }
      }
    } catch {
      // Directory read failed or doesn't exist — non-fatal
    }
  }
}

/**
 * Cap on retained `*.heapsnapshot` files in `app.getPath("logs")`. V8's
 * `setHeapSnapshotNearHeapLimit` (main, pty-host, workspace-host, watchdog) dumps
 * 55–60 MB snapshots there on near-OOM; with frequent OOM restarts they accumulate
 * unbounded (#10728). 10 ≈ 600 MB and leaves room for all processes to each emit a
 * full set without dropping the freshest diagnostics.
 */
export const MAX_HEAP_SNAPSHOTS = 10;

const HEAP_SNAPSHOT_EXT = ".heapsnapshot";

/**
 * Count-based prune of V8 heap snapshots in `logsDir` (= `app.getPath("logs")`).
 * Keeps the `maxCount` newest `*.heapsnapshot` files by mtime and deletes the
 * rest. Time-based pruning (like {@link pruneOldLogs}) is the wrong model here —
 * each snapshot is ~55 MB and old dumps have no diagnostic value once superseded.
 * Strictly filters by extension so sibling logs (daintree.log, crash reports) are
 * never touched. Missing/unreadable dir and per-file unlink failures are no-ops.
 */
export function pruneHeapSnapshots(logsDir: string, maxCount: number): void {
  if (maxCount < 0) return;
  if (!existsSync(logsDir)) return;

  try {
    const snapshots: { path: string; mtimeMs: number }[] = [];
    for (const file of readdirSync(logsDir)) {
      if (!file.endsWith(HEAP_SNAPSHOT_EXT)) continue;
      try {
        const filePath = join(logsDir, file);
        const stats = statSync(filePath);
        if (stats.isFile()) {
          snapshots.push({ path: filePath, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // Skip locked or inaccessible files
      }
    }

    if (snapshots.length <= maxCount) return;

    snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { path } of snapshots.slice(maxCount)) {
      try {
        unlinkSync(path);
      } catch {
        // Skip locked or inaccessible files
      }
    }
  } catch {
    // Directory read failed — non-fatal
  }
}

/**
 * Async twin of {@link pruneHeapSnapshots}. Uses `fs/promises` so the scan/delete
 * pass yields to the event loop instead of blocking it. Use this from async
 * contexts (deferred-init queue, periodic cleanup); keep the sync version for the
 * synchronous DiskSpaceMonitor critical-edge handler.
 */
export async function pruneHeapSnapshotsAsync(logsDir: string, maxCount: number): Promise<void> {
  if (maxCount < 0) return;

  const snapshots: { path: string; mtimeMs: number }[] = [];
  try {
    const handle = await fsp.opendir(logsDir);
    for await (const dirent of handle) {
      // dirent.isFile() does not follow symlinks; the logs dir never contains
      // symlinks, so this matches the sync twin while avoiding an extra stat.
      if (!dirent.isFile()) continue;
      if (!dirent.name.endsWith(HEAP_SNAPSHOT_EXT)) continue;
      try {
        const filePath = join(logsDir, dirent.name);
        const stats = await fsp.stat(filePath);
        snapshots.push({ path: filePath, mtimeMs: stats.mtimeMs });
      } catch {
        // Skip locked or inaccessible files
      }
    }
  } catch {
    // Directory read failed or doesn't exist — non-fatal
    return;
  }

  if (snapshots.length <= maxCount) return;

  snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { path } of snapshots.slice(maxCount)) {
    try {
      await fsp.unlink(path);
    } catch {
      // Skip locked or inaccessible files
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

/**
 * The effective floor applied when no override matches — `"debug"` under
 * debug-boot (`NODE_ENV=development` / `DAINTREE_DEBUG`), else `"info"`. The
 * renderer mirrors this so its pre-IPC gate matches what main would accept for
 * an unmatched logger (`resolveEffectiveLevel`'s final fallback).
 */
export function getDefaultLogLevel(): LogOverrideLevel {
  return defaultLevel;
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

const loggerStringify = configure({ bigint: false });

const SENSITIVE_KEY_PATTERNS = ["secret", "token", "password", "key"];

// Bounds for `redactSensitiveData`. Context objects are deep-cloned into the
// 500-entry in-memory ring (LogBuffer); without caps a single stack trace,
// diff, or worktree snapshot accumulates unbounded. These clamp per-entry cost
// — depth × array-items × string-chars ≈ 200KB worst case — mirroring the
// per-field clamping runHistoryLog applies to its persisted records.
const MAX_REDACT_DEPTH = 5;
const MAX_REDACT_STRING_CHARS = 2000;
const MAX_REDACT_ARRAY_ITEMS = 20;

// Scrub content-based secrets BEFORE clamping. The downstream `scrubSecrets`
// in `emit`/`emitError` runs on the already-clamped value, so a secret straddling
// the `MAX_REDACT_STRING_CHARS` boundary would have its high-entropy tail sliced
// off here first, leaving a surviving prefix too short for the scrubber to match
// — leaking the leading bytes to disk. Scrubbing first is exactly the upstream
// ordering `shared/utils/secretScrubber.ts` documents as mandatory (it applies
// no pre-truncation itself for this reason). Only then do we length-clamp.
function clampLogString(value: string): string {
  const scrubbed = scrubSecrets(value);
  if (scrubbed.length <= MAX_REDACT_STRING_CHARS) return scrubbed;
  return `${scrubbed.slice(0, MAX_REDACT_STRING_CHARS)}[…+${scrubbed.length - MAX_REDACT_STRING_CHARS}]`;
}

function safeStringify(value: unknown): string {
  try {
    return loggerStringify(
      value,
      (key, val) => {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_KEYS.has(lowerKey)) return "[redacted]";

        if (SENSITIVE_KEY_PATTERNS.some((pattern) => lowerKey.includes(pattern))) {
          return "[redacted]";
        }

        if (typeof val === "bigint") return val.toString();

        return val;
      },
      2
    ) as string;
  } catch (error) {
    return `[Unable to stringify: ${String(error)}]`;
  }
}

// Per-line fs bookkeeping: the directory is ensured and the file size statted
// once, then the size is tracked incrementally from appended bytes. Other
// processes (pty-host, workspace-host, watchdog) append to the same file, so
// the tracked size is refreshed from disk periodically to bound drift.
const SIZE_REFRESH_INTERVAL_BYTES = 256 * 1024;
let trackedLogFile: string | null = null;
let trackedLogSize = -1;
let bytesSinceSizeRefresh = 0;

// Async batched file logging (#10769). A per-line `appendFileSync` on the main
// thread is the dominant event-loop stall under multi-agent load: a single
// workspace-host `worktree-update` fans out to several sync writes through the
// event bus, and a busy session issues hundreds of log lines per second — each
// 0.2–20ms incl. the periodic rotation `statSync`. Non-error lines are buffered
// and flushed once per event-loop turn with a single async `appendFile`,
// collapsing N syscalls into 1 and keeping the write off the synchronous hot
// path. ERROR lines stay synchronous (see `writeToLogFile`) so they survive a
// crash, matching the eager-import sync-fs rationale at the top of this file.
const ASYNC_FLUSH_MAX_PENDING_BYTES = 256 * 1024;
let pendingLogLines: string[] = [];
let pendingLogBytes = 0;
let asyncFlushScheduled = false;
let asyncFlushInFlight: Promise<void> | null = null;
let exitFlushRegistered = false;

function rotateIfNeededTracked(logFile: string): boolean {
  if (
    trackedLogSize < 0 ||
    bytesSinceSizeRefresh >= SIZE_REFRESH_INTERVAL_BYTES ||
    trackedLogSize >= ROTATION_MAX_SIZE
  ) {
    bytesSinceSizeRefresh = 0;
    trackedLogSize = existsSync(logFile) ? statSync(logFile).size : 0;
    if (trackedLogSize >= ROTATION_MAX_SIZE) {
      if (!rotateLogsIfNeeded()) return false;
      trackedLogSize = 0;
    }
  }
  return true;
}

/** Ensure the log directory exists; re-stat on the next write if the path moved. */
function ensureLogDir(logFile: string): void {
  if (logFile !== trackedLogFile) {
    mkdirSync(getLogDirectory(), { recursive: true });
    trackedLogFile = logFile;
    trackedLogSize = -1;
  }
}

function recordWrittenBytes(bytes: number): void {
  trackedLogSize += bytes;
  bytesSinceSizeRefresh += bytes;
}

/** Synchronously append `data` to the active log file, honoring rotation. */
function appendSync(data: string, bytes: number): void {
  const logFile = getLogFilePath();
  ensureLogDir(logFile);
  if (!rotateIfNeededTracked(logFile)) return;
  appendFileSync(logFile, data, "utf8");
  recordWrittenBytes(bytes);
}

/**
 * Drain buffered lines synchronously. Used as a memory safety valve when a
 * synchronous burst never yields to the flush timer, and on process exit for
 * best-effort durability of buffered non-error lines.
 */
function flushPendingLogsSync(): void {
  if (pendingLogLines.length === 0) return;
  const data = pendingLogLines.join("");
  const bytes = pendingLogBytes;
  pendingLogLines = [];
  pendingLogBytes = 0;
  try {
    appendSync(data, bytes);
  } catch {
    trackedLogFile = null;
  }
}

function scheduleAsyncFlush(): void {
  if (!exitFlushRegistered) {
    exitFlushRegistered = true;
    process.once("exit", () => {
      try {
        flushPendingLogsSync();
      } catch {
        // Process is exiting — nothing more we can do.
      }
    });
  }
  if (asyncFlushScheduled) return;
  asyncFlushScheduled = true;
  setImmediate(runAsyncFlush);
}

function runAsyncFlush(): void {
  asyncFlushScheduled = false;
  if (asyncFlushInFlight) return; // the in-flight drain loops until empty
  asyncFlushInFlight = drainPendingLogs().finally(() => {
    asyncFlushInFlight = null;
    // A line buffered after the loop's last check still needs a flush.
    if (pendingLogLines.length > 0) scheduleAsyncFlush();
  });
}

async function drainPendingLogs(): Promise<void> {
  while (pendingLogLines.length > 0) {
    const data = pendingLogLines.join("");
    const bytes = pendingLogBytes;
    pendingLogLines = [];
    pendingLogBytes = 0;
    try {
      const logFile = getLogFilePath();
      ensureLogDir(logFile);
      if (!rotateIfNeededTracked(logFile)) continue;
      await fsp.appendFile(logFile, data, "utf8");
      recordWrittenBytes(bytes);
    } catch {
      // Re-ensure the directory and re-stat on the next write.
      trackedLogFile = null;
    }
  }
}

/** Test-only: resolve once all buffered log lines have been written to disk. */
export async function flushLogFileWritesForTesting(): Promise<void> {
  if (!asyncFlushInFlight && pendingLogLines.length > 0) {
    asyncFlushScheduled = false;
    asyncFlushInFlight = drainPendingLogs().finally(() => {
      asyncFlushInFlight = null;
    });
  }
  while (asyncFlushInFlight) {
    await asyncFlushInFlight;
    if (pendingLogLines.length > 0 && !asyncFlushInFlight) {
      asyncFlushInFlight = drainPendingLogs().finally(() => {
        asyncFlushInFlight = null;
      });
    }
  }
}

/**
 * `message` and `contextStr` must already be scrubbed — `emit`/`emitError`
 * scrub each field once and share the result between the file and console
 * transports. The composed prefix (timestamp, level) carries no user content.
 */
function writeToLogFile(level: string, message: string, contextStr: string): void {
  if (!ENABLE_FILE_LOGGING) return;
  if (getWritesSuppressed()) return;

  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}${contextStr ? ` ${contextStr}` : ""}\n`;
  const bytes = Buffer.byteLength(logLine, "utf8");

  if (level === "ERROR") {
    // Errors are written synchronously so they survive a crash. Flush any
    // buffered lines first so the on-disk order matches emit order. Ordering is
    // best-effort: a batch already handed to an in-flight async flush has left
    // the buffer and may interleave with this sync write — crash safety for the
    // error line takes priority over strict ordering in that rare window.
    try {
      const data = pendingLogLines.length > 0 ? pendingLogLines.join("") + logLine : logLine;
      const total = pendingLogBytes + bytes;
      pendingLogLines = [];
      pendingLogBytes = 0;
      appendSync(data, total);
    } catch {
      trackedLogFile = null;
    }
    return;
  }

  pendingLogLines.push(logLine);
  pendingLogBytes += bytes;
  // Bound memory if a synchronous burst never yields to the flush timer.
  if (pendingLogBytes >= ASYNC_FLUSH_MAX_PENDING_BYTES) {
    flushPendingLogsSync();
  } else {
    scheduleAsyncFlush();
  }
}

/**
 * Flatten an Error into a plain record before redaction walks it.
 *
 * `redactSensitiveData` enumerates own properties, and an Error's `name`,
 * `message` and `stack` are all non-enumerable — so every Error passed inside a
 * context object was written to the log as `{}`, erasing the only record of the
 * failure (#11777). Converting here rather than in a separate pre-pass means the
 * flattened fields keep flowing through the existing scrubbing, string clamping,
 * array caps and depth limits below, and the no-Error case (effectively all of
 * a hot path that runs hundreds of times a second) costs one type check.
 */
function toRedactableRecord(value: object): Record<string, unknown> {
  if (!isErrorLike(value)) return value as Record<string, unknown>;
  try {
    return serializeError(value) as unknown as Record<string, unknown>;
  } catch {
    // A hostile getter on an Error subclass must not turn a log call into the
    // throw it was reporting.
    return { name: "Error", message: "[unserializable error]" };
  }
}

function redactSensitiveData(
  obj: Record<string, unknown>,
  visited = new WeakSet<object>(),
  depth = 0
): Record<string, unknown> {
  if (depth >= MAX_REDACT_DEPTH) {
    return "[MaxDepth]" as unknown as Record<string, unknown>;
  }
  if (visited.has(obj)) {
    return "[Circular]" as unknown as Record<string, unknown>;
  }
  visited.add(obj);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      SENSITIVE_KEYS.has(lowerKey) ||
      SENSITIVE_KEY_PATTERNS.some((pattern) => lowerKey.includes(pattern))
    ) {
      result[key] = "[redacted]";
    } else if (typeof value === "string") {
      result[key] = clampLogString(value);
    } else if (Array.isArray(value)) {
      result[key] = redactArrayWithCycleDetection(value, visited, depth + 1);
    } else if (value !== null && typeof value === "object") {
      result[key] = redactSensitiveData(toRedactableRecord(value), visited, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function redactArrayWithCycleDetection(
  arr: unknown[],
  visited: WeakSet<object>,
  depth: number
): unknown[] {
  if (depth >= MAX_REDACT_DEPTH) {
    return ["[MaxDepth]"];
  }
  if (visited.has(arr)) {
    return "[Circular]" as unknown as unknown[];
  }
  visited.add(arr);

  const capped = arr.length > MAX_REDACT_ARRAY_ITEMS;
  const items = capped ? arr.slice(0, MAX_REDACT_ARRAY_ITEMS) : arr;
  const mapped = items.map((item) => {
    if (item === null) {
      return item;
    }
    if (typeof item === "string") {
      return clampLogString(item);
    }
    if (Array.isArray(item)) {
      return redactArrayWithCycleDetection(item, visited, depth + 1);
    }
    if (typeof item === "object") {
      return redactSensitiveData(toRedactableRecord(item), visited, depth + 1);
    }
    return item;
  });
  if (capped) {
    mapped.push(`[...${arr.length - MAX_REDACT_ARRAY_ITEMS} more]`);
  }
  return mapped;
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
  // Stringify and scrub once, sharing both between the file and console
  // transports — previously each transport re-scrubbed the same content.
  const contextStr = safeContext ? safeStringify(safeContext) : "";
  const scrubbedMessage = scrubSecrets(message);
  const scrubbedContext = contextStr ? scrubSecrets(contextStr) : "";
  writeToLogFile(level.toUpperCase(), scrubbedMessage, scrubbedContext);

  if (!IS_TEST) {
    const prefix = `[${level.toUpperCase()}] [${source}]`;
    const consoleFn =
      level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleFn(`${prefix} ${scrubbedMessage}`, scrubbedContext);
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
  // Stringify the merged, redacted context once and scrub each field once,
  // sharing both between the file and console transports — `safeContext`
  // already folds in `errorDetails`, so the console path no longer
  // re-serializes/re-scrubs the error and context separately (and inherits
  // key-redaction it previously skipped).
  const contextStr = safeStringify(safeContext);
  const scrubbedMessage = scrubSecrets(message);
  const scrubbedContext = scrubSecrets(contextStr);
  writeToLogFile("ERROR", scrubbedMessage, scrubbedContext);

  if (!IS_TEST) {
    console.error(`[ERROR] [${source}] ${scrubbedMessage}`, scrubbedContext);
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
