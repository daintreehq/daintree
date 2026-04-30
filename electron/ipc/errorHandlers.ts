import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ipcMain, BrowserWindow, shell } from "electron";
import { CHANNELS } from "./channels.js";
import { getLogFilePath, logError as logErrorUtil } from "../utils/logger.js";
import { broadcastToRenderer, typedHandle } from "./utils.js";
import { ValidationError } from "./validationError.js";
import {
  GitError,
  GitOperationError,
  ProcessError,
  FileSystemError,
  ConfigError,
  getUserMessage,
  getErrorDetails,
  isTransientError,
} from "../utils/errorTypes.js";
import { getGitRecoveryAction, getGitRecoveryHint } from "../../shared/utils/gitOperationErrors.js";
import { store } from "../store.js";
import { FAULT_MODE_ENABLED } from "./faultRegistry.js";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { ErrorRecord, ErrorType, RetryAction } from "../../shared/types/ipc/errors.js";
import type { SpawnResult } from "../../shared/types/pty-host.js";

interface RetryPayload {
  errorId: string;
  action: RetryAction;
  args?: Record<string, unknown>;
}

const MAX_PENDING_ERRORS = 50;

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

// TLS error codes emitted by Node when an upstream cert chain doesn't validate.
// In corporate environments these almost always mean a TLS-inspection proxy is
// re-signing traffic with a private CA that isn't in Node's bundled root store
// — surface a recovery hint that points at NODE_EXTRA_CA_CERTS / NODE_USE_SYSTEM_CA
// rather than a generic "check your network" message.
const TLS_PROXY_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isTlsProxyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TLS_PROXY_CODES.has(code)) {
    return true;
  }
  // Fallback for cases where libraries strip `error.code` but preserve the
  // OpenSSL message verbatim. Kept narrow to the canonical OpenSSL phrasings
  // so unrelated "unable to verify ..." or "certificate ..." errors don't
  // get pushed to the NODE_EXTRA_CA_CERTS recovery path. Case-insensitive in
  // case a wrapper transforms the message.
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (!message) return false;
  return (
    message.includes("unable to verify the first certificate") ||
    message.includes("self signed certificate") ||
    message.includes("self-signed certificate") ||
    message.includes("unable to get local issuer certificate")
  );
}

function getErrorType(error: unknown): ErrorType {
  if (error instanceof ValidationError) return "validation";
  if (error instanceof GitError) return "git";
  if (error instanceof ProcessError) return "process";
  if (error instanceof FileSystemError) return "filesystem";
  if (error instanceof ConfigError) return "config";

  if (error && typeof error === "object") {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
      return "network";
    }
    if (isTlsProxyError(error)) {
      return "network";
    }
  }

  return "unknown";
}

function isSpawnSyscall(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const syscall = (error as NodeJS.ErrnoException).syscall;
  if (syscall?.startsWith("spawn")) return true;
  if (error instanceof Error && error.message.includes("posix_spawnp")) return true;
  return false;
}

function getRecoveryHint(error: unknown): string | undefined {
  if (error instanceof ProcessError) {
    return "The terminal process could not start.";
  }

  if (error instanceof GitOperationError) {
    return getGitRecoveryHint(error.reason);
  }

  if (error instanceof GitError) {
    const msg = error.message + (error.cause ? ` ${error.cause.message}` : "");
    if (msg.includes("not a git repository")) {
      return "Run 'git init' or open a folder containing a git repo.";
    }
    if (msg.includes("Authentication failed") || msg.includes("authentication")) {
      return "Check your Git credentials or SSH key configuration.";
    }
    return undefined;
  }

  if (error instanceof ConfigError) {
    return "The configuration file may be corrupted — check the logs.";
  }

  if (!error || typeof error !== "object") return undefined;

  if (isTlsProxyError(error)) {
    return "TLS inspection proxy detected. Set NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem (or NODE_USE_SYSTEM_CA=1 to use the OS keychain), then restart Daintree.";
  }

  const code = (error as NodeJS.ErrnoException).code;
  const spawn = isSpawnSyscall(error);

  if (!code && spawn) {
    return "Install the tool or add it to your PATH.";
  }

  switch (code) {
    case "EACCES":
    case "EPERM":
      return spawn
        ? "The file exists but is not executable — check permissions."
        : "Check file permissions or run with elevated privileges.";
    case "ENOENT":
      return spawn
        ? "Install the tool or add it to your PATH."
        : "Verify the file path is correct and the file exists.";
    case "ENOTFOUND":
      return "Check your internet connection and DNS settings.";
    case "ECONNREFUSED":
      return "Ensure the target server or service is running.";
    case "ETIMEDOUT":
      return "Check your network connection and try again.";
    case "ECONNRESET":
      return "The connection was reset — try again in a moment.";
    case "EBUSY":
      return "Close other applications using this file and retry.";
    case "EAGAIN":
      return "System is temporarily busy — wait a moment and retry.";
  }

  return undefined;
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
  } = {}
): ErrorRecord {
  const details = getErrorDetails(error);
  const correlationId = randomUUID();

  const gitReason = error instanceof GitOperationError ? error.reason : undefined;
  const recoveryAction = gitReason ? getGitRecoveryAction(gitReason) : undefined;

  return {
    id: generateErrorId(),
    timestamp: Date.now(),
    type: getErrorType(error),
    message: getUserMessage(error),
    details: details.stack as string | undefined,
    source: options.source,
    context: options.context,
    isTransient: isTransientError(error),
    dismissed: false,
    retryAction: options.retryAction,
    retryArgs: options.retryArgs,
    correlationId,
    recoveryHint: getRecoveryHint(error),
    gitReason,
    recoveryAction,
  };
}

function isCriticalErrorType(type: ErrorType): boolean {
  return type === "config" || type === "filesystem";
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

    if (isCriticalErrorType(error.type) && !error.isTransient) {
      this.persistError(error);
    }
  }

  private persistError(error: ErrorRecord): void {
    try {
      const existing = (store.get("pendingErrors") as ErrorRecord[] | undefined) ?? [];
      const updated = [...existing, error].slice(-MAX_PENDING_ERRORS);
      store.set("pendingErrors", updated);
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
      const persisted = (store.get("pendingErrors") as ErrorRecord[] | undefined) ?? [];
      this.clearPersistedErrors();
      return persisted.map((e) => ({ ...e, fromPreviousSession: true }));
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

          if (!isTransientError(error) || attempt === maxAttempts) {
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
      errorService.notifyError(error, {
        source: `retry-${actionForError ?? "unknown"}`,
        retryAction: actionForError,
        retryArgs: argsForError,
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
