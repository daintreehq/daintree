import { useEffect, useCallback, useRef } from "react";
import { useErrorStore, type AppError, type RetryAction } from "@/store";
import { isElectronAvailable } from "./useElectron";
import { errorsClient } from "@/clients";
import { logErrorWithContext } from "@/utils/errorContext";

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

  const didAttachListener = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    ipcListenerAttached = true;
    didAttachListener.current = true;

    const unsubscribe = errorsClient.onError((error: AppError) => {
      addError({
        type: error.type,
        message: error.message,
        details: error.details,
        source: error.source,
        context: error.context,
        isTransient: error.isTransient,
        retryAction: error.retryAction,
        retryArgs: error.retryArgs,
      });
    });

    return () => {
      if (didAttachListener.current) {
        unsubscribe();
        ipcListenerAttached = false;
      }
    };
  }, [addError]);

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
      }
    },
    [removeError]
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
    openLogs,
    getWorktreeErrors,
    getTerminalErrors,
  };
}

export default useErrors;
