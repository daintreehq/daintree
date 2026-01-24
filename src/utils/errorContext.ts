export type ErrorCategory = "network" | "filesystem" | "validation" | "git" | "process" | "unknown";

export interface ErrorContext {
  operation: string;
  component: string;
  errorType?: ErrorCategory;
  details?: Record<string, unknown>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack;
  if (typeof error === "object" && error !== null && "stack" in error) {
    return String(error.stack);
  }
  return undefined;
}

function classifyError(error: unknown): ErrorCategory {
  const message = getErrorMessage(error).toLowerCase();

  if (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("enotfound")
  ) {
    return "network";
  }

  if (message.includes("git") || message.includes("worktree") || message.includes("branch")) {
    return "git";
  }

  if (
    message.includes("enoent") ||
    message.includes("eacces") ||
    message.includes("eperm") ||
    message.includes("file") ||
    message.includes("directory")
  ) {
    return "filesystem";
  }

  if (
    message.includes("spawn") ||
    message.includes("process") ||
    message.includes("pty") ||
    message.includes("terminal")
  ) {
    return "process";
  }

  if (
    message.includes("invalid") ||
    message.includes("required") ||
    message.includes("must be") ||
    message.includes("validation")
  ) {
    return "validation";
  }

  return "unknown";
}

export function logErrorWithContext(error: unknown, context: ErrorContext): void {
  const errorType = context.errorType ?? classifyError(error);
  const message = getErrorMessage(error);
  const stack = getErrorStack(error);

  const structuredLog = {
    timestamp: new Date().toISOString(),
    level: "error",
    operation: context.operation,
    component: context.component,
    errorType,
    message,
    ...(context.details && { details: context.details }),
    ...(stack && { stack }),
  };

  console.error(`[${context.component}] ${context.operation} failed:`, structuredLog);
}

export function isTransientError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("timeout") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("econnaborted") ||
    message.includes("enetunreach") ||
    message.includes("temporary") ||
    message.includes("busy") ||
    message.includes("retry") ||
    message.includes("429") ||
    message.includes("503")
  );
}
