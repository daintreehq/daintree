import { captureRendererException } from "@/utils/rendererSentry";
import { logDebug, logWarn, logError } from "@/utils/logger";
import { useErrorStore } from "@/store/errorStore";
import { getErrorMessage } from "@/utils/errorContext";

export function onCaughtError(error: unknown, errorInfo: { componentStack?: string }): void {
  try {
    logWarn("[React] Caught render error", {
      error: getErrorMessage(error),
      componentStack: errorInfo.componentStack,
    });
  } catch {
    // Last-resort sink: the logger itself failed.
    // eslint-disable-next-line no-console
    console.error("[React] Failed to log caught error:", error);
  }
}

export function onUncaughtError(error: unknown, errorInfo: { componentStack?: string }): void {
  try {
    captureRendererException(error, {
      tags: { source: "react-uncaught" },
      contexts: errorInfo.componentStack
        ? { react: { componentStack: errorInfo.componentStack } }
        : undefined,
    });

    try {
      useErrorStore.getState().addError({
        type: "unknown",
        message: getErrorMessage(error),
        details: errorInfo.componentStack,
        source: "React Uncaught Render Error",
        retryability: "none",
      });
    } catch (storeError) {
      // Last-resort sink: the error store has already failed.
      // eslint-disable-next-line no-console
      console.error("[React] Failed to add uncaught error to store:", storeError);
    }

    try {
      logError("[React] Uncaught render error", error, {
        componentStack: errorInfo.componentStack,
      });
    } catch {
      // Last-resort sink: the logger itself failed.
      // eslint-disable-next-line no-console
      console.error("[React] Failed to log uncaught error:", error);
    }
  } catch {
    // Last-resort sink: the outer try block itself threw; nothing else can run.
    // eslint-disable-next-line no-console
    console.error("[React] Critical failure in onUncaughtError:", error);
  }
}

export function onRecoverableError(error: unknown, errorInfo: { componentStack?: string }): void {
  try {
    logDebug("[React] Recoverable render error", {
      error: getErrorMessage(error),
      componentStack: errorInfo.componentStack,
    });
  } catch {
    // Last-resort sink: the logger itself failed.
    // eslint-disable-next-line no-console
    console.error("[React] Failed to log recoverable error:", error);
  }
}
