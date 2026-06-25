type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

interface BatchEntry {
  level: LogLevel;
  message: string;
  context?: LogContext;
}

/**
 * Numeric level ordering mirrored from the main-process logger
 * (`electron/utils/logger.ts`). A message at level X is suppressed when
 * `LEVELS[X] < floor`. `"off"` is highest — anything below `Infinity` passes
 * only when the floor is a real level. The renderer cannot import from
 * `electron/`, so this is an intentional local copy of a shared concept.
 */
const LEVELS: Record<LogLevel | "off", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: Number.POSITIVE_INFINITY,
};

/**
 * Renderer log writes are coalesced into a single batched IPC invoke per
 * ~tick instead of one round-trip per call. 16ms mirrors the main-process
 * outbound `LOG_THROTTLE_MS`; the 60-entry cap mirrors `MAX_LOGS_PER_FLUSH`
 * and bounds a single `writeBatch` payload.
 */
const LOG_BATCH_MS = 16;
const MAX_BATCH_ENTRIES = 60;

/**
 * Effective floor the renderer gates against before touching IPC. The renderer
 * logger has no named loggers — every call funnels through the bare
 * `logDebug`/`logInfo`/`logWarn`/`logError` exports — so only the global `"*"`
 * wildcard override is relevant (no per-name or process-wildcard resolution).
 * Defaults to `info` synchronously; refreshed once the async override fetch and
 * the push subscription land. The main-process `shouldLog` remains the
 * authoritative gate, so a stale floor only ever lets a below-threshold call
 * cross the wire (it is then dropped in main) — it never drops a log that
 * should be delivered.
 */
const DEFAULT_FLOOR = LEVELS.info;
let rendererFloor: number = DEFAULT_FLOOR;

let batchQueue: BatchEntry[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorInitialized = false;

function isElectronAvailable(): boolean {
  return typeof window !== "undefined" && !!window.electron?.logs?.writeBatch;
}

function consoleFallback(level: LogLevel, message: string, context?: LogContext): void {
  const consoleFn =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[${level.toUpperCase()}] ${message}`, context ?? "");
}

function isValidFloorLevel(value: unknown): value is LogLevel | "off" {
  return typeof value === "string" && value in LEVELS;
}

function applyOverrides(overrides: Record<string, string> | undefined): void {
  const wildcard = overrides?.["*"];
  rendererFloor = isValidFloorLevel(wildcard) ? LEVELS[wildcard] : DEFAULT_FLOOR;
}

function initLevelMirror(): void {
  if (mirrorInitialized) return;
  if (typeof window === "undefined" || !window.electron?.logs) return;
  mirrorInitialized = true;
  // First few calls may fire before this resolves; they default to the `info`
  // floor, and main re-gates anyway, so no log that should appear is lost.
  window.electron.logs
    .getLevelOverrides()
    .then(applyOverrides)
    .catch(() => {});
  window.electron.logs.onLevelOverridesChanged(applyOverrides);
}

function shouldRendererLog(level: LogLevel): boolean {
  return LEVELS[level] >= rendererFloor;
}

function flushBatch(): void {
  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (batchQueue.length === 0) return;
  // Snapshot-and-clear before the send so any re-entrant enqueue lands in the
  // next batch instead of being dropped or double-sent.
  const snapshot = batchQueue;
  batchQueue = [];

  if (!isElectronAvailable()) {
    // Window torn down between enqueue and flush — don't lose the entries.
    for (const entry of snapshot) consoleFallback(entry.level, entry.message, entry.context);
    return;
  }

  for (let i = 0; i < snapshot.length; i += MAX_BATCH_ENTRIES) {
    const chunk = snapshot.slice(i, i + MAX_BATCH_ENTRIES);
    window.electron.logs.writeBatch(chunk).catch(() => {
      for (const entry of chunk) consoleFallback(entry.level, entry.message, entry.context);
    });
  }
}

function writeLog(level: LogLevel, message: string, context?: LogContext): void {
  if (!isElectronAvailable()) {
    // No electron API (tests / non-electron context) — there's no IPC cost to
    // save, so log everything to console without gating.
    consoleFallback(level, message, context);
    return;
  }

  initLevelMirror();

  if (!shouldRendererLog(level)) return;

  const entry: BatchEntry = { level, message, context };
  batchQueue.push(entry);

  // warn/error must never be deferred beyond the current tick: flush the queue
  // (including any debug/info enqueued before them, preserving order) right
  // now instead of waiting for the batch timer.
  if (level === "warn" || level === "error") {
    flushBatch();
    return;
  }

  // debug/info: coalesce into the next batch window.
  if (batchTimer === null) {
    batchTimer = setTimeout(flushBatch, LOG_BATCH_MS);
  }
}

export function logDebug(message: string, context?: LogContext): void {
  writeLog("debug", message, context);
}

export function logInfo(message: string, context?: LogContext): void {
  writeLog("info", message, context);
}

export function logWarn(message: string, context?: LogContext): void {
  writeLog("warn", message, context);
}

export function logError(message: string, error?: unknown, context?: LogContext): void {
  const errorContext: LogContext = { ...context };
  if (error !== undefined) {
    if (error instanceof Error) {
      errorContext.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    } else {
      errorContext.error = error;
    }
  }
  writeLog("error", message, errorContext);
}

/**
 * Test-only reset of module-level state (queue, timer, floor, init flag),
 * mirroring `resetLoggerStateForTesting` in the main-process logger so suites
 * can isolate batching/gating behavior.
 */
export function _resetRendererLoggerForTesting(): void {
  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  batchQueue = [];
  rendererFloor = DEFAULT_FLOOR;
  mirrorInitialized = false;
}
