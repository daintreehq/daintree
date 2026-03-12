import { randomUUID } from "node:crypto";
import { ipcMain, BrowserWindow, shell } from "electron";
import { CHANNELS } from "./channels.js";
import { getLogFilePath, logError as logErrorUtil } from "../utils/logger.js";
import {
  GitError,
  ProcessError,
  FileSystemError,
  ConfigError,
  getUserMessage,
  getErrorDetails,
  isTransientError,
} from "../utils/errorTypes.js";
import { store } from "../store.js";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { AppError, ErrorType, RetryAction } from "../../shared/types/ipc/errors.js";

interface RetryPayload {
  errorId: string;
  action: RetryAction;
  args?: Record<string, unknown>;
}

const MAX_PENDING_ERRORS = 50;

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

function getErrorType(error: unknown): ErrorType {
  if (error instanceof GitError) return "git";
  if (error instanceof ProcessError) return "process";
  if (error instanceof FileSystemError) return "filesystem";
  if (error instanceof ConfigError) return "config";

  if (error && typeof error === "object") {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
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

function createAppError(
  error: unknown,
  options: {
    source?: string;
    context?: AppError["context"];
    retryAction?: RetryAction;
    retryArgs?: Record<string, unknown>;
  } = {}
): AppError {
  const details = getErrorDetails(error);
  const correlationId = randomUUID();

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
  };
}

function isCriticalErrorType(type: ErrorType): boolean {
  return type === "config" || type === "filesystem";
}

class ErrorService {
  private mainWindow: BrowserWindow | null = null;
  private worktreeService: WorkspaceClient | null = null;
  private ptyClient: PtyClient | null = null;
  private pendingQueue: AppError[] = [];
  private isFlushing = false;

  initialize(
    mainWindow: BrowserWindow,
    worktreeService: WorkspaceClient | null,
    ptyClient: PtyClient | null
  ) {
    this.mainWindow = mainWindow;
    this.worktreeService = worktreeService;
    this.ptyClient = ptyClient;
  }

  private canSendToRenderer(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
    const webContents = this.mainWindow.webContents;
    if (!webContents || typeof webContents.send !== "function") return false;
    if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) return false;
    return true;
  }

  private bufferError(error: AppError): void {
    this.pendingQueue.push(error);
    if (this.pendingQueue.length > MAX_PENDING_ERRORS) {
      this.pendingQueue.shift();
    }

    if (isCriticalErrorType(error.type) && !error.isTransient) {
      this.persistError(error);
    }
  }

  private persistError(error: AppError): void {
    try {
      const existing = (store.get("pendingErrors") as AppError[] | undefined) ?? [];
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

  sendError(error: AppError) {
    if (!this.canSendToRenderer()) {
      this.bufferError(error);
      return;
    }

    this.mainWindow!.webContents.send(CHANNELS.ERROR_NOTIFY, error);
  }

  notifyError(error: unknown, options: Parameters<typeof createAppError>[1] = {}) {
    const appError = createAppError(error, options);
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
      const webContents = this.mainWindow!.webContents;
      for (const error of errors) {
        try {
          webContents.send(CHANNELS.ERROR_NOTIFY, error);
        } catch {
          // Window may have been destroyed mid-flush; re-buffer remaining
        }
      }
      this.clearPersistedErrors();
    } finally {
      this.isFlushing = false;
    }
  }

  getPendingPersistedErrors(): AppError[] {
    try {
      const persisted = (store.get("pendingErrors") as AppError[] | undefined) ?? [];
      this.clearPersistedErrors();
      return persisted.map((e) => ({ ...e, fromPreviousSession: true }));
    } catch {
      return [];
    }
  }

  async handleRetry(payload: RetryPayload): Promise<void> {
    const { action, args } = payload;

    switch (action) {
      case "terminal":
        if (this.ptyClient && typeof args?.id === "string" && typeof args?.cwd === "string") {
          this.ptyClient.spawn(args.id, {
            cwd: args.cwd,
            cols: normalizeTerminalDimension(args.cols, 80),
            rows: normalizeTerminalDimension(args.rows, 30),
          });
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

export function flushPendingErrors(): void {
  errorService.flushPendingErrors();
}

export function registerErrorHandlers(
  mainWindow: BrowserWindow,
  worktreeService: WorkspaceClient | null,
  ptyClient: PtyClient | null
): () => void {
  const handlers: Array<() => void> = [];

  errorService.initialize(mainWindow, worktreeService, ptyClient);

  const handleRetry = async (_event: Electron.IpcMainInvokeEvent, payload: unknown) => {
    let actionForError: RetryAction | undefined;
    let argsForError: Record<string, unknown> | undefined;

    try {
      const parsedPayload = parseRetryPayload(payload);
      actionForError = parsedPayload.action;
      argsForError = parsedPayload.args;
      await errorService.handleRetry(parsedPayload);
    } catch (error) {
      errorService.notifyError(error, {
        source: `retry-${actionForError ?? "unknown"}`,
        retryAction: actionForError,
        retryArgs: argsForError,
      });
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.ERROR_RETRY, handleRetry);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.ERROR_RETRY));

  const handleOpenLogs = async () => {
    await errorService.openLogs();
  };
  ipcMain.handle(CHANNELS.ERROR_OPEN_LOGS, handleOpenLogs);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.ERROR_OPEN_LOGS));

  const handleGetPending = () => {
    return errorService.getPendingPersistedErrors();
  };
  ipcMain.handle(CHANNELS.ERROR_GET_PENDING, handleGetPending);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.ERROR_GET_PENDING));

  return () => {
    handlers.forEach((cleanup) => cleanup());
  };
}
