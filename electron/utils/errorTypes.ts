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
  if (isDaintreeError(error)) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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
