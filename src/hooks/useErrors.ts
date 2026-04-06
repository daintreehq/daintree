import { useEffect, useCallback, useRef } from "react";
import { useErrorStore, type AppError, type RetryAction } from "@/store";
import { isElectronAvailable } from "./useElectron";
import { errorsClient } from "@/clients";
import { logErrorWithContext } from "@/utils/errorContext";
import { notify } from "@/lib/notify";
import type { NotificationPriority } from "@/store/notificationStore";

export function getErrorPriority(
  error: Pick<AppError, "type" | "isTransient">
): NotificationPriority {
  if (error.isTransient) return "low";
  return "high";
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

    const unsubscribeError = errorsClient.onError((error: AppError) => {
      addError({
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
      });

      notify({
        type: "error",
        title: error.source,
        message: error.message,
        correlationId: error.correlationId,
        priority: getErrorPriority(error),
      });
    });

    const unsubscribeProgress = errorsClient.onRetryProgress((payload) => {
      updateRetryProgress(payload.id, payload.attempt, payload.maxAttempts);
    });

    errorsClient
      .getPending()
      .then((pending) => {
        for (const error of pending) {
          addError({
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
          });

          notify({
            type: "error",
            title: error.source,
            message: error.message,
            correlationId: error.correlationId,
            priority: getErrorPriority(error),
          });
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

export default useErrors;
