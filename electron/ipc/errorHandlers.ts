// eager-import-allow: reads error-reporting config via store.get synchronously while handling IPC errors
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ipcMain, BrowserWindow, shell } from "electron";
import { CHANNELS } from "./channels.js";
import { getLogFilePath, logError as logErrorUtil } from "../utils/logger.js";
import { broadcastToRenderer, typedHandle } from "./utils.js";
import { getErrorDetails, getRetryability, getUserMessage } from "../utils/errorTypes.js";
import { classifyError } from "../utils/errorClassification.js";
import { store } from "../store.js";
import { appendPendingError, MAX_PENDING_ERRORS } from "./pendingErrorsStore.js";
import { FAULT_MODE_ENABLED } from "./faultRegistry.js";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type {
  ErrorRecord,
  ErrorRetryability,
  ErrorType,
  RetryAction,
} from "../../shared/types/ipc/errors.js";
import type { SpawnResult } from "../../shared/types/pty-host.js";

const MAX_FINGERPRINT_ENTRIES = 200;

function buildFingerprintKey(type: ErrorType, source: string | undefined, message: string): string {
  return `${type}|${source ?? ""}|${message}`;
}

function recordErrorFingerprint(
  type: ErrorType,
  source: string | undefined,
  message: string
): number {
  const key = buildFingerprintKey(type, source, message);
  const raw = store.get("errorFingerprints");
  const fingerprints: Record<string, { count: number; firstSeen: number; lastSeen: number }> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, { count: number; firstSeen: number; lastSeen: number }>)
      : {};
  const now = Date.now();
  const existing = fingerprints[key];
  const count = (existing?.count ?? 0) + 1;
  fingerprints[key] = { count, firstSeen: existing?.firstSeen ?? now, lastSeen: now };

  const entries = Object.entries(fingerprints);
  if (entries.length > MAX_FINGERPRINT_ENTRIES) {
    entries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [k] of entries.slice(0, entries.length - MAX_FINGERPRINT_ENTRIES)) {
      delete fingerprints[k];
    }
    store.set("errorFingerprints", fingerprints);
  } else {
    store.set("errorFingerprints", fingerprints);
  }

  return count;
}

interface RetryPayload {
  errorId: string;
  action: RetryAction;
  args?: Record<string, unknown>;
}

const MAX_RETRY_ATTEMPTS: Record<RetryAction, number> = {
  terminal: 3,
  git: 3,
  worktree: 5,
};

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;
const BACKOFF_FLOOR_MS = 100;
const TERMINAL_RETRY_SPAWN_TIMEOUT_MS = 30_000;

function computeRetryDelay(attempt: number): number {
  const exponentialCeil = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  return Math.floor(Math.random() * (exponentialCeil - BACKOFF_FLOOR_MS + 1) + BACKOFF_FLOOR_MS);
}

function isRetryAction(value: unknown): value is RetryAction {
  return value === "terminal" || value === "git" || value === "worktree";
}

function normalizeTerminalDimension(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
    return fallback;
  }

  return value > 0 ? value : fallback;
}

function parseRetryPayload(payload: unknown): RetryPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid retry payload");
  }

  const candidate = payload as {
    errorId?: unknown;
    action?: unknown;
    args?: unknown;
  };

  if (!isRetryAction(candidate.action)) {
    throw new Error("Invalid retry payload");
  }

  return {
    errorId: typeof candidate.errorId === "string" ? candidate.errorId : "unknown",
    action: candidate.action,
    args:
      candidate.args && typeof candidate.args === "object" && !Array.isArray(candidate.args)
        ? (candidate.args as Record<string, unknown>)
        : undefined,
  };
}

function generateErrorId(): string {
  return `error-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createErrorRecord(
  error: unknown,
  options: {
    source?: string;
    context?: ErrorRecord["context"];
    retryAction?: RetryAction;
    retryArgs?: Record<string, unknown>;
    /**
     * Explicit override for the retryability classification. Callers use this
     * to mark a record as `"exhausted"` from the retry loop's final catch —
     * exhaustion is loop state, not an intrinsic of the error itself.
     */
    retryability?: ErrorRetryability;
    /**
     * Companion flag set when the retry loop exhausted its budget. The
     * `"exhausted"` retryability above already encodes this for retryability-
     * aware consumers; this boolean keeps backwards-compatible gating in the
     * banner / toast / problems-content paths and is what the recurrence
     * tracking persists to detect runaway retry loops across sessions.
     */
    retryExhausted?: boolean;
  } = {}
): ErrorRecord {
  const details = getErrorDetails(error);
  const correlationId = randomUUID();
  const classification = classifyError(error);

  return {
    id: generateErrorId(),
    timestamp: Date.now(),
    type: classification.errorType,
    message: getUserMessage(error),
    details: details.stack as string | undefined,
    source: options.source,
    context: options.context,
    retryability: options.retryability ?? classification.retryability,
    dismissed: false,
    retryAction: options.retryAction,
    retryArgs: options.retryArgs,
    correlationId,
    recoveryHint: classification.recoveryHint,
    gitReason: classification.gitReason,
    recoveryAction: classification.recoveryAction,
    isCritical: classification.isCritical,
    retryExhausted: options.retryExhausted ?? false,
    occurrenceCount: 0,
  };
}

const VALID_RETRYABILITY: ReadonlySet<ErrorRetryability> = new Set([
  "auto",
  "user-gated",
  "exhausted",
  "none",
]);

/**
 * Read-time migration for records persisted by older builds that wrote the
 * legacy `isTransient: boolean` field. Maps `true → "auto"` and `false → "none"`
 * and strips the legacy key so subsequent writes use the new shape. An invalid
 * retryability string (corrupted store, dev-time write) is rejected and falls
 * back to the same `isTransient`-based default so we never surface an
 * unrecognised discriminant to the renderer.
 */
function migrateLegacyPersistedError(entry: unknown): ErrorRecord {
  const record = (entry ?? {}) as Partial<ErrorRecord> & { isTransient?: boolean };
  let { retryability } = record;
  if (!retryability || !VALID_RETRYABILITY.has(retryability)) {
    retryability = record.isTransient === true ? "auto" : "none";
  }
  const { isTransient: _legacy, ...rest } = record;
  void _legacy;
  return { ...(rest as ErrorRecord), retryability, fromPreviousSession: true };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

class ErrorService {
  private worktreeService: WorkspaceClient | null = null;
  private ptyClient: PtyClient | null = null;
  private pendingQueue: ErrorRecord[] = [];
  private isFlushing = false;
  private activeRetries = new Map<string, AbortController>();

  initialize(worktreeService: WorkspaceClient | null, ptyClient: PtyClient | null) {
    this.worktreeService = worktreeService;
    this.ptyClient = ptyClient;
  }

  private canSendToRenderer(): boolean {
    return BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()
    );
  }

  private bufferError(error: ErrorRecord): void {
    this.pendingQueue.push(error);
    if (this.pendingQueue.length > MAX_PENDING_ERRORS) {
      this.pendingQueue.shift();
    }

    if (error.isCritical && error.retryability !== "auto") {
      this.persistError(error);
    }
  }

  private persistError(error: ErrorRecord): void {
    try {
      appendPendingError(error);
    } catch {
      // Don't let persistence failure block error handling
    }
  }

  private clearPersistedErrors(): void {
    try {
      store.set("pendingErrors", []);
    } catch {
      // Ignore persistence errors
    }
  }

  sendError(error: ErrorRecord) {
    if (!this.canSendToRenderer()) {
      this.bufferError(error);
      return;
    }

    broadcastToRenderer(CHANNELS.ERROR_NOTIFY, error);
  }

  notifyError(error: unknown, options: Parameters<typeof createErrorRecord>[1] = {}) {
    const appError = createErrorRecord(error, options);

    appError.occurrenceCount = recordErrorFingerprint(
      appError.type,
      appError.source,
      appError.message
    );
    if (options.retryExhausted) {
      appError.retryExhausted = true;
    }

    logErrorUtil(`[${appError.correlationId}] ${appError.message}`, error, {
      correlationId: appError.correlationId,
      type: appError.type,
      source: appError.source,
      context: appError.context,
    });
    this.sendError(appError);
    return appError;
  }

  flushPendingErrors(): void {
    if (this.isFlushing || this.pendingQueue.length === 0) return;
    if (!this.canSendToRenderer()) return;

    this.isFlushing = true;
    try {
      const errors = this.pendingQueue.splice(0);
      for (const error of errors) {
        try {
          broadcastToRenderer(CHANNELS.ERROR_NOTIFY, error);
        } catch {
          // Window may have been destroyed mid-flush; re-buffer remaining
        }
      }
      this.clearPersistedErrors();
    } finally {
      this.isFlushing = false;
    }
  }

  getPendingPersistedErrors(): ErrorRecord[] {
    try {
      const persisted = (store.get("pendingErrors") as unknown[] | undefined) ?? [];
      this.clearPersistedErrors();
      return persisted.map((entry) => migrateLegacyPersistedError(entry));
    } catch {
      return [];
    }
  }

  private sendRetryProgress(errorId: string, attempt: number, maxAttempts: number): void {
    if (!this.canSendToRenderer()) return;
    broadcastToRenderer(CHANNELS.ERROR_RETRY_PROGRESS, {
      id: errorId,
      attempt,
      maxAttempts,
    });
  }

  cancelRetry(errorId: string): void {
    const controller = this.activeRetries.get(errorId);
    if (controller) {
      controller.abort();
    }
  }

  private async executeAction(
    action: RetryAction,
    args?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<void> {
    switch (action) {
      case "terminal":
        if (this.ptyClient && typeof args?.id === "string" && typeof args?.cwd === "string") {
          await this.spawnTerminalAndAwaitResult(
            this.ptyClient,
            args.id,
            {
              cwd: args.cwd,
              cols: normalizeTerminalDimension(args.cols, 80),
              rows: normalizeTerminalDimension(args.rows, 30),
              // Carry the original workspace owner through the retry. Dropping it
              // makes PtyClient.spawn fall back to its global active-workspace id,
              // which can hand the respawned terminal to whichever workspace another
              // window switched to last — and let that workspace's delete kill it.
              ...(typeof args.projectId === "string" && args.projectId
                ? { projectId: args.projectId }
                : {}),
            },
            signal
          );
        }
        break;

      case "worktree":
        if (this.worktreeService) {
          await this.worktreeService.refresh();
        }
        break;

      case "git":
        if (this.worktreeService) {
          await this.worktreeService.refresh();
        }
        break;
    }
  }

  private spawnTerminalAndAwaitResult(
    ptyClient: PtyClient,
    id: string,
    options: { cwd: string; cols: number; rows: number },
    signal?: AbortSignal
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        ptyClient.off("spawn-result", onSpawnResult);
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onSpawnResult = (eventId: string, result: SpawnResult) => {
        if (eventId !== id) return;
        if (result.success) {
          settle(() => resolve());
          return;
        }
        const error = new Error(
          result.error?.message ?? `Terminal spawn failed for ${id}`
        ) as NodeJS.ErrnoException;
        if (result.error?.code) {
          error.code = result.error.code;
        }
        settle(() => reject(error));
      };

      const onAbort = () => {
        settle(() =>
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException("The operation was aborted", "AbortError")
          )
        );
      };

      // Listener MUST be attached before spawn() — PENDING_SPAWNS_CAPPED emits synchronously.
      ptyClient.on("spawn-result", onSpawnResult);

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      timer = setTimeout(() => {
        // Non-transient: retry storm from a wedged host won't help; each attempt
        // would wait another TERMINAL_RETRY_SPAWN_TIMEOUT_MS.
        const error = new Error(
          `Terminal spawn for ${id} did not complete within ${TERMINAL_RETRY_SPAWN_TIMEOUT_MS}ms`
        );
        settle(() => reject(error));
      }, TERMINAL_RETRY_SPAWN_TIMEOUT_MS);

      try {
        ptyClient.spawn(id, options);
      } catch (err) {
        settle(() => reject(err));
      }
    });
  }

  async handleRetry(payload: RetryPayload): Promise<void> {
    const { errorId, action, args } = payload;
    const maxAttempts = MAX_RETRY_ATTEMPTS[action];
    const existing = this.activeRetries.get(errorId);
    if (existing) {
      existing.abort();
    }

    const controller = new AbortController();
    const { signal } = controller;

    this.activeRetries.set(errorId, controller);

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        signal.throwIfAborted();

        this.sendRetryProgress(errorId, attempt, maxAttempts);

        try {
          await this.executeAction(action, args, signal);
          return;
        } catch (error) {
          if (isAbortError(error)) throw error;
          signal.throwIfAborted();

          // classifyError called here on the caught retry failure, and again
          // in notifyError→createErrorRecord when the error is re-thrown below.
          // This is a residual double-classify — acceptable because Node.js
          // errno exceptions use plain data properties that don't mutate between
          // reads, so the two classifications are always identical.
          if (classifyError(error).retryability !== "auto" || attempt === maxAttempts) {
            throw error;
          }

          const delay = computeRetryDelay(attempt);
          await sleep(delay, undefined, { signal });
        }
      }
    } finally {
      this.activeRetries.delete(errorId);
    }
  }

  async openLogs(): Promise<void> {
    const logPath = getLogFilePath();
    const { dirname } = await import("path");
    const logDir = dirname(logPath);

    try {
      const fs = await import("fs");
      await fs.promises.mkdir(logDir, { recursive: true });
    } catch {
      // Ignore mkdir errors
    }

    const openResult = await shell.openPath(logPath);
    if (openResult) {
      await shell.openPath(logDir);
    }
  }
}

const errorService = new ErrorService();

if (FAULT_MODE_ENABLED) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- E2E fault injection
  (globalThis as any).__daintreeErrorService = errorService;
}

export function flushPendingErrors(): void {
  errorService.flushPendingErrors();
}

export function notifyError(
  error: unknown,
  options: Parameters<typeof createErrorRecord>[1] = {}
): ErrorRecord {
  return errorService.notifyError(error, options);
}

export function registerErrorHandlers(
  worktreeService: WorkspaceClient | null,
  ptyClient: PtyClient | null
): () => void {
  const handlers: Array<() => void> = [];

  errorService.initialize(worktreeService, ptyClient);

  const handleRetry = async (payload: unknown) => {
    let actionForError: RetryAction | undefined;
    let argsForError: Record<string, unknown> | undefined;

    try {
      const parsedPayload = parseRetryPayload(payload);
      actionForError = parsedPayload.action;
      argsForError = parsedPayload.args;
      await errorService.handleRetry(parsedPayload);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // Only label as "exhausted" when the loop actually used up its retry
      // budget — that requires the error to have been intrinsically auto-
      // retryable in the first place. A first-attempt throw of a non-
      // transient error (e.g. GitOperationError("auth-failed")) needs to
      // keep its intrinsic classification so the renderer can still surface
      // the recovery CTA.
      const intrinsic = getRetryability(error);
      errorService.notifyError(error, {
        source: `retry-${actionForError ?? "unknown"}`,
        retryAction: actionForError,
        retryArgs: argsForError,
        retryability: intrinsic === "auto" ? "exhausted" : intrinsic,
        retryExhausted: true,
      });
      throw error;
    }
  };
  handlers.push(typedHandle(CHANNELS.ERROR_RETRY, handleRetry));

  const handleRetryCancelListener = (_event: Electron.IpcMainEvent, errorId: unknown) => {
    if (typeof errorId === "string") {
      errorService.cancelRetry(errorId);
    }
  };
  ipcMain.on(CHANNELS.ERROR_RETRY_CANCEL, handleRetryCancelListener);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.ERROR_RETRY_CANCEL, handleRetryCancelListener)
  );

  const handleOpenLogs = async () => {
    await errorService.openLogs();
  };
  handlers.push(typedHandle(CHANNELS.ERROR_OPEN_LOGS, handleOpenLogs));

  const handleGetPending = () => {
    return errorService.getPendingPersistedErrors();
  };
  handlers.push(typedHandle(CHANNELS.ERROR_GET_PENDING, handleGetPending));

  return () => {
    handlers.forEach((cleanup) => cleanup());
  };
}
