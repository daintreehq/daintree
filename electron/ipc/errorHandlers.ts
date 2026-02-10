import { ipcMain, BrowserWindow, shell } from "electron";
import { CHANNELS } from "./channels.js";
import { getLogFilePath } from "../utils/logger.js";
import {
  GitError,
  ProcessError,
  FileSystemError,
  ConfigError,
  getUserMessage,
  getErrorDetails,
  isTransientError,
} from "../utils/errorTypes.js";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";

type ErrorType = "git" | "process" | "filesystem" | "network" | "config" | "unknown";

type RetryAction = "terminal" | "git" | "worktree";

interface AppError {
  id: string;
  timestamp: number;
  type: ErrorType;
  message: string;
  details?: string;
  source?: string;
  context?: {
    worktreeId?: string;
    terminalId?: string;
    filePath?: string;
    command?: string;
  };
  isTransient: boolean;
  dismissed: boolean;
  retryAction?: RetryAction;
  retryArgs?: Record<string, unknown>;
}

interface RetryPayload {
  errorId: string;
  action: RetryAction;
  args?: Record<string, unknown>;
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
  };
}

class ErrorService {
  private mainWindow: BrowserWindow | null = null;
  private worktreeService: WorkspaceClient | null = null;
  private ptyClient: PtyClient | null = null;

  initialize(
    mainWindow: BrowserWindow,
    worktreeService: WorkspaceClient | null,
    ptyClient: PtyClient | null
  ) {
    this.mainWindow = mainWindow;
    this.worktreeService = worktreeService;
    this.ptyClient = ptyClient;
  }

  sendError(error: AppError) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    const webContents = this.mainWindow.webContents;
    if (!webContents || typeof webContents.send !== "function") {
      return;
    }
    if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) {
      return;
    }

    webContents.send(CHANNELS.ERROR_NOTIFY, error);
  }

  notifyError(error: unknown, options: Parameters<typeof createAppError>[1] = {}) {
    const appError = createAppError(error, options);
    this.sendError(appError);
    return appError;
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

  return () => {
    handlers.forEach((cleanup) => cleanup());
  };
}
