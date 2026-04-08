import { logDebug, logWarn, logError } from "@/utils/logger";
import { useErrorStore } from "@/store/errorStore";
import { getErrorMessage } from "@/utils/errorContext";

export function onCaughtError(error: unknown, errorInfo: { componentStack?: string }): void {
  try {
    logWarn("[React] Caught render error", {
      error: error instanceof Error ? error.message : String(error),
      componentStack: errorInfo.componentStack,
    });
  } catch {
    console.error("[React] Failed to log caught error:", error);
  }
}

export function onUncaughtError(error: unknown, errorInfo: { componentStack?: string }): void {
  try {
    try {
      useErrorStore.getState().addError({
        type: "unknown",
        message: getErrorMessage(error),
        details: errorInfo.componentStack,
        source: "React Uncaught Render Error",
        isTransient: false,
      });
    } catch (storeError) {
      console.error("[React] Failed to add uncaught error to store:", storeError);
    }

    try {
      logError("[React] Uncaught render error", error, {
        componentStack: errorInfo.componentStack,
      });
    } catch {
      console.error("[React] Failed to log uncaught error:", error);
    }
  } catch {
    console.error("[React] Critical failure in onUncaughtError:", error);
  }
}

export function onRecoverableError(error: unknown, errorInfo: { componentStack?: string }): void {
  try {
    logDebug("[React] Recoverable render error", {
      error: error instanceof Error ? error.message : String(error),
      componentStack: errorInfo.componentStack,
    });
  } catch {
    console.error("[React] Failed to log recoverable error:", error);
  }
}
