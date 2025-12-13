import { ipcMain, BrowserWindow, shell } from "electron";
import { homedir } from "os";
import { join } from "path";
import { CHANNELS } from "./channels.js";
import {
  GitError,
  ProcessError,
  FileSystemError,
  ConfigError,
  getUserMessage,
  getErrorDetails,
  isTransientError,
} from "../utils/errorTypes.js";
import type { DevServerManager } from "../services/DevServerManager.js";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";

type ErrorType = "git" | "process" | "filesystem" | "network" | "config" | "unknown";

type RetryAction = "devserver" | "terminal" | "git" | "worktree";

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
  private devServerManager: DevServerManager | null = null;
  private worktreeService: WorkspaceClient | null = null;
  private ptyClient: PtyClient | null = null;

  initialize(
    mainWindow: BrowserWindow,
    devServerManager: DevServerManager | null,
    worktreeService: WorkspaceClient | null,
    ptyClient: PtyClient | null
  ) {
    this.mainWindow = mainWindow;
    this.devServerManager = devServerManager;
    this.worktreeService = worktreeService;
    this.ptyClient = ptyClient;
  }

  sendError(error: AppError) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(CHANNELS.ERROR_NOTIFY, error);
    }
  }

  notifyError(error: unknown, options: Parameters<typeof createAppError>[1] = {}) {
    const appError = createAppError(error, options);
    this.sendError(appError);
    return appError;
  }

  async handleRetry(payload: RetryPayload): Promise<void> {
    const { action, args } = payload;

    switch (action) {
      case "devserver":
        if (this.devServerManager && args?.worktreeId && args?.worktreePath) {
          await this.devServerManager.start(
            args.worktreeId as string,
            args.worktreePath as string,
            args.command as string | undefined
          );
        }
        break;

      case "terminal":
        if (this.ptyClient && args?.id && args?.cwd) {
          this.ptyClient.spawn(args.id as string, {
            cwd: args.cwd as string,
            cols: (args.cols as number) || 80,
            rows: (args.rows as number) || 30,
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
    const logPath = join(homedir(), ".config", "canopy", "worktree-debug.log");
    try {
      await shell.openPath(logPath);
    } catch (_error) {
      const configDir = join(homedir(), ".config", "canopy");
      await shell.openPath(configDir);
    }
  }
}

const errorService = new ErrorService();

export function registerErrorHandlers(
  mainWindow: BrowserWindow,
  devServerManager: DevServerManager | null,
  worktreeService: WorkspaceClient | null,
  ptyClient: PtyClient | null
): () => void {
  const handlers: Array<() => void> = [];

  errorService.initialize(mainWindow, devServerManager, worktreeService, ptyClient);

  const handleRetry = async (_event: Electron.IpcMainInvokeEvent, payload: RetryPayload) => {
    try {
      await errorService.handleRetry(payload);
    } catch (error) {
      errorService.notifyError(error, {
        source: `retry-${payload.action}`,
        retryAction: payload.action,
        retryArgs: payload.args,
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
