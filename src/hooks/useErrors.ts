import { useEffect, useCallback, useRef } from "react";
import { useErrorStore, type ErrorRecord, type RetryAction } from "@/store";
import { isElectronAvailable } from "./useElectron";
import { errorsClient } from "@/clients";
import { logErrorWithContext } from "@/utils/errorContext";
import { notify, shouldEscalateTransientError, consumeEscalation } from "@/lib/notify";
import type { NotificationAction, NotificationPriority } from "@/store/notificationStore";
import { humanizeAppError } from "@shared/utils/errorMessage";

export function getErrorPriority(
  error: Pick<ErrorRecord, "type" | "isTransient">
): NotificationPriority {
  if (error.isTransient) return "low";
  return "high";
}

function buildCopyDetailsAction(error: ErrorRecord): NotificationAction {
  return {
    label: "Copy details",
    variant: "secondary",
    onClick: () => {
      const payload = JSON.stringify(
        {
          type: error.type,
          source: error.source,
          message: error.message,
          gitReason: error.gitReason,
          recoveryHint: error.recoveryHint,
          correlationId: error.correlationId,
          context: error.context,
          details: error.details,
        },
        null,
        2
      );
      try {
        const result = navigator.clipboard?.writeText(payload);
        if (result && typeof result.catch === "function") {
          result.catch(() => {
            // Clipboard writes can reject in non-HTTPS or unfocused contexts.
            // Failure is non-fatal — the toast already showed the user the
            // friendly summary; the raw payload is recoverable from logs.
          });
        }
      } catch {
        // navigator.clipboard may be undefined in restricted contexts.
      }
    },
  };
}

function routeError(error: ErrorRecord): void {
  const escalated = shouldEscalateTransientError(error);
  const priority = escalated ? "high" : getErrorPriority(error);

  useErrorStore.getState().addError({
    type: error.type,
    message: error.message,
    details: error.details,
    source: error.source,
    context: error.context,
    isTransient: error.isTransient,
    retryAction: error.retryAction,
    retryArgs: error.retryArgs,
    fromPreviousSession: error.fromPreviousSession,
    correlationId: error.correlationId,
    recoveryHint: error.recoveryHint,
    gitReason: error.gitReason,
  });

  const { title, body } = humanizeAppError(error);

  // "Copy details" is omitted for low-priority errors: those route to the
  // history inbox without a toast, so the action would never be reachable —
  // and notify() auto-promotes action-bearing toasts to sticky.
  const action = priority === "low" ? undefined : buildCopyDetailsAction(error);

  const toastId = notify({
    type: "error",
    title,
    message: body,
    correlationId: error.correlationId,
    priority,
    action,
  });

  if (escalated && toastId) {
    consumeEscalation(error);
  }
}

let ipcListenerAttached = false;
export function useErrors() {
  const errors = useErrorStore((state) => state.errors);
  const isPanelOpen = useErrorStore((state) => state.isPanelOpen);
  const addError = useErrorStore((state) => state.addError);
  const dismissError = useErrorStore((state) => state.dismissError);
  const clearAll = useErrorStore((state) => state.clearAll);
  const removeError = useErrorStore((state) => state.removeError);
  const togglePanel = useErrorStore((state) => state.togglePanel);
  const setPanelOpen = useErrorStore((state) => state.setPanelOpen);
  const getActiveErrors = useErrorStore((state) => state.getActiveErrors);
  const getWorktreeErrors = useErrorStore((state) => state.getWorktreeErrors);
  const getTerminalErrors = useErrorStore((state) => state.getTerminalErrors);
  const updateRetryProgress = useErrorStore((state) => state.updateRetryProgress);
  const clearRetryProgress = useErrorStore((state) => state.clearRetryProgress);

  const didAttachListener = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    ipcListenerAttached = true;
    didAttachListener.current = true;

    const unsubscribeError = errorsClient.onError((error: ErrorRecord) => {
      routeError(error);
    });

    const unsubscribeProgress = errorsClient.onRetryProgress((payload) => {
      updateRetryProgress(payload.id, payload.attempt, payload.maxAttempts);
    });

    errorsClient
      .getPending()
      .then((pending) => {
        for (const error of pending) {
          routeError(error);
        }
      })
      .catch(() => {
        // Ignore failures fetching pending errors
      });

    return () => {
      if (didAttachListener.current) {
        unsubscribeError();
        unsubscribeProgress();
        ipcListenerAttached = false;
      }
    };
  }, [addError, updateRetryProgress]);

  const retry = useCallback(
    async (errorId: string, action: RetryAction, args?: Record<string, unknown>) => {
      if (!isElectronAvailable()) return;

      try {
        await errorsClient.retry(errorId, action, args);
        removeError(errorId);
      } catch (error) {
        logErrorWithContext(error, {
          operation: "retry_error_action",
          component: "useErrors",
          details: { errorId, action, args },
        });
      } finally {
        clearRetryProgress(errorId);
      }
    },
    [removeError, clearRetryProgress]
  );

  const cancelRetry = useCallback(
    (errorId: string) => {
      if (!isElectronAvailable()) return;
      errorsClient.cancelRetry(errorId);
      clearRetryProgress(errorId);
    },
    [clearRetryProgress]
  );

  const openLogs = useCallback(async () => {
    if (!isElectronAvailable()) return;
    await errorsClient.openLogs();
  }, []);

  return {
    errors,
    activeErrors: getActiveErrors(),
    isPanelOpen,
    addError,
    dismissError,
    clearAll,
    removeError,
    togglePanel,
    setPanelOpen,
    retry,
    cancelRetry,
    openLogs,
    getWorktreeErrors,
    getTerminalErrors,
  };
}
