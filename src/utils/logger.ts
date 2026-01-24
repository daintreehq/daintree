type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

function isElectronAvailable(): boolean {
  return typeof window !== "undefined" && !!window.electron?.logs?.write;
}

function writeLog(level: LogLevel, message: string, context?: LogContext): void {
  if (isElectronAvailable()) {
    window.electron.logs.write(level, message, context).catch(() => {
      // Fallback to console if IPC fails
      const consoleFn =
        level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      consoleFn(`[${level.toUpperCase()}] ${message}`, context ?? "");
    });
  } else {
    // No electron API (e.g., in tests or non-electron context)
    const consoleFn =
      level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleFn(`[${level.toUpperCase()}] ${message}`, context ?? "");
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
