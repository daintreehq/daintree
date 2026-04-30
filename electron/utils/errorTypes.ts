import { classifyGitError, extractGitErrorMessage } from "../../shared/utils/gitOperationErrors.js";
import type { GitOperationReason } from "../../shared/types/ipc/errors.js";
import type { AppErrorCode } from "../../shared/types/appError.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

export class DaintreeError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class GitError extends DaintreeError {
  constructor(message: string, context?: Record<string, unknown>, cause?: Error) {
    super(message, context, cause);
  }
}

/**
 * Classified git failure. Extends GitError (not simple-git's GitError) so
 * existing `instanceof GitError` checks keep working, while new callers can
 * `instanceof GitOperationError` to branch on the discriminated `reason`.
 */
export class GitOperationError extends GitError {
  readonly reason: GitOperationReason;
  readonly op?: string;
  readonly rawMessage: string;

  constructor(
    reason: GitOperationReason,
    message: string,
    opts: {
      cwd?: string;
      op?: string;
      cause?: Error;
      rawMessage?: string;
      context?: Record<string, unknown>;
    } = {}
  ) {
    const context: Record<string, unknown> = { ...(opts.context ?? {}) };
    if (opts.cwd !== undefined) context.cwd = opts.cwd;
    if (opts.op !== undefined) context.op = opts.op;
    context.reason = reason;
    super(message, context, opts.cause);
    this.reason = reason;
    this.op = opts.op;
    this.rawMessage = opts.rawMessage ?? message;
  }
}

/**
 * Wrap any thrown value into a GitOperationError. If the value is already a
 * GitOperationError it is returned unchanged so repeated wrapping at multiple
 * layers is a no-op.
 */
export function toGitOperationError(
  error: unknown,
  opts: { cwd?: string; op?: string } = {}
): GitOperationError {
  if (error instanceof GitOperationError) return error;
  const rawMessage = extractGitErrorMessage(error);
  const reason = classifyGitError(error);
  const cause = error instanceof Error ? error : undefined;
  return new GitOperationError(reason, rawMessage || "Git operation failed", {
    cwd: opts.cwd,
    op: opts.op,
    cause,
    rawMessage,
  });
}

/**
 * Used to signal that a worktree monitor should stop polling and clean up.
 */
export class WorktreeRemovedError extends GitError {
  constructor(path: string, cause?: Error) {
    super("Worktree directory no longer exists", { path }, cause);
  }
}

export class FileSystemError extends DaintreeError {
  constructor(message: string, context?: Record<string, unknown>, cause?: Error) {
    super(message, context, cause);
  }
}

export class ConfigError extends DaintreeError {
  constructor(message: string, context?: Record<string, unknown>, cause?: Error) {
    super(message, context, cause);
  }
}

export class ProcessError extends DaintreeError {
  constructor(message: string, context?: Record<string, unknown>, cause?: Error) {
    super(message, context, cause);
  }
}

export class WatcherError extends DaintreeError {
  constructor(message: string, context?: Record<string, unknown>, cause?: Error) {
    super(message, context, cause);
  }
}

/**
 * Generic typed error thrown by IPC handlers. The `code` discriminant survives
 * Electron's structured-clone strip in `electron/setup/security.ts` and is
 * reconstructed in the renderer as a `ClientAppError` so consumers can do
 * `if (e.code === "BINARY_FILE")` instead of substring-matching messages.
 */
export class AppError extends DaintreeError {
  readonly code: AppErrorCode;
  readonly userMessage?: string;

  constructor(opts: {
    code: AppErrorCode;
    message: string;
    userMessage?: string;
    context?: Record<string, unknown>;
    cause?: Error;
  }) {
    super(opts.message, opts.context, opts.cause);
    this.name = "AppError";
    this.code = opts.code;
    this.userMessage = opts.userMessage;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function isDaintreeError(error: unknown): error is DaintreeError {
  return error instanceof DaintreeError;
}

export function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

export function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return ["EBUSY", "EAGAIN", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND"].includes(code || "");
}

export function getUserMessage(error: unknown): string {
  if (isAppError(error) && error.userMessage) {
    return error.userMessage;
  }
  if (isDaintreeError(error)) {
    return error.message;
  }

  return formatErrorMessage(error, "An unknown error occurred");
}

/**
 * Handles circular references safely to prevent infinite recursion
 */
export function getErrorDetails(
  error: unknown,
  seen = new WeakSet<Error>()
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    message: getUserMessage(error),
  };

  if (error instanceof Error) {
    details.name = error.name;
    details.stack = error.stack;
  }

  if (isDaintreeError(error)) {
    details.context = error.context;
    if (error.cause) {
      if (error.cause instanceof Error && !seen.has(error.cause)) {
        seen.add(error.cause);
        details.cause = getErrorDetails(error.cause, seen);
      } else if (!(error.cause instanceof Error)) {
        details.cause = getErrorDetails(error.cause, seen);
      }
    }
  }

  if (error && typeof error === "object") {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code) details.code = nodeError.code;
    if (nodeError.errno) details.errno = nodeError.errno;
    if (nodeError.syscall) details.syscall = nodeError.syscall;
    if (nodeError.path) details.path = nodeError.path;
  }

  return details;
}
