import { logError } from "@/utils/logger";

export type ErrorCategory = "network" | "filesystem" | "validation" | "git" | "process" | "unknown";

export interface ErrorContext {
  operation: string;
  component: string;
  errorType?: ErrorCategory;
  details?: Record<string, unknown>;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

const NAME_TO_CATEGORY: Record<string, ErrorCategory> = {
  GitError: "git",
  WorktreeRemovedError: "git",
  FileSystemError: "filesystem",
  ProcessError: "process",
  WatcherError: "process",
  ConfigError: "validation",
};

const FILESYSTEM_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EBUSY",
  "EEXIST",
  "EISDIR",
  "ENOTDIR",
  "ENOTEMPTY",
  "EROFS",
  "EMFILE",
  "ENFILE",
]);

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRINUSE",
]);

function getStructuredProps(error: unknown) {
  const err = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  return {
    name: typeof err.name === "string" ? err.name : "",
    code: typeof err.code === "string" ? err.code : "",
    syscall: typeof err.syscall === "string" ? err.syscall : "",
  };
}

export function classifyError(error: unknown): ErrorCategory {
  const { name, code, syscall } = getStructuredProps(error);

  // Tier 1: known Canopy error class names (preserved through IPC deserialization)
  if (name && name !== "Error") {
    const category = NAME_TO_CATEGORY[name];
    if (category) return category;
  }

  // Tier 2: POSIX error codes
  if (code) {
    if (NETWORK_CODES.has(code)) return "network";
    if (FILESYSTEM_CODES.has(code)) return "filesystem";
  }

  // Tier 3: syscall-based detection
  if (syscall.startsWith("spawn")) return "process";

  // Tier 4: message substring fallback (for third-party errors without structured properties)
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

  logError(`${context.component}: ${context.operation} failed`, error, {
    operation: context.operation,
    component: context.component,
    errorType,
    details: context.details,
  });
}

const TRANSIENT_CODES = new Set(["EBUSY", "EAGAIN", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND"]);

export function isTransientError(error: unknown): boolean {
  const { code } = getStructuredProps(error);

  if (code && TRANSIENT_CODES.has(code)) return true;

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
