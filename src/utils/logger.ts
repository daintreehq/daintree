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
 * The renderer gate mirrors main's `resolveEffectiveLevel` for an unmatched
 * logger: a global `"*"` override if one is set, otherwise main's process
 * default (`"debug"` under debug-boot, else `"info"`). The renderer logger has
 * no named loggers — every call funnels through the bare
 * `logDebug`/`logInfo`/`logWarn`/`logError` exports — so per-name and
 * process-wildcard keys never apply, only `"*"`.
 *
 * Both inputs start at the conservative `info` default and are refreshed
 * asynchronously (a one-time default fetch + the override fetch/subscription).
 * Until they resolve, a stale floor only ever lets a below-threshold call cross
 * the wire (main then drops it) — it never drops a log main would deliver. The
 * one window where the renderer could under-send is debug-boot before the
 * default fetch lands; those few early `debug` calls are gated, which is
 * acceptable for a startup-only race.
 */
const FALLBACK_FLOOR = LEVELS.info;
let defaultFloor: number = FALLBACK_FLOOR;
let wildcardFloor: number | null = null;
let mirrorInitialized = false;
// Once an override push lands, the initial (possibly slower) override fetch is
// stale and must not overwrite it.
let overridePushReceived = false;

let batchQueue: BatchEntry[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

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

function setDefaultFloor(level: string | undefined): void {
  defaultFloor = isValidFloorLevel(level) ? LEVELS[level] : FALLBACK_FLOOR;
}

function applyOverrides(overrides: Record<string, string> | undefined): void {
  const wildcard = overrides?.["*"];
  wildcardFloor = isValidFloorLevel(wildcard) ? LEVELS[wildcard] : null;
}

function initLevelMirror(): void {
  if (mirrorInitialized) return;
  if (typeof window === "undefined" || !window.electron?.logs) return;
  mirrorInitialized = true;
  const logs = window.electron.logs;
  // The default is static per process (set at boot), so a one-time fetch is
  // enough — no push channel needed for it.
  logs
    .getDefaultLevel?.()
    ?.then(setDefaultFloor)
    .catch(() => {});
  logs
    .getLevelOverrides?.()
    ?.then((overrides) => {
      // A push that arrived first reflects newer state than this fetch.
      if (!overridePushReceived) applyOverrides(overrides);
    })
    .catch(() => {});
  logs.onLevelOverridesChanged?.((overrides) => {
    overridePushReceived = true;
    applyOverrides(overrides);
  });
}

function shouldRendererLog(level: LogLevel): boolean {
  const floor = wildcardFloor ?? defaultFloor;
  return LEVELS[level] >= floor;
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
  defaultFloor = FALLBACK_FLOOR;
  wildcardFloor = null;
  mirrorInitialized = false;
  overridePushReceived = false;
}
