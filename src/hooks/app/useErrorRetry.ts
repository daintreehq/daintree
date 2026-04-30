import { useCallback } from "react";
import { useErrorStore, type RetryAction } from "@/store";
import { logError } from "@/utils/logger";
import { errorsClient } from "@/clients";

export function useErrorRetry() {
  const removeError = useErrorStore((s) => s.removeError);
  const clearRetryProgress = useErrorStore((s) => s.clearRetryProgress);

  const handleErrorRetry = useCallback(
    async (errorId: string, action: RetryAction, args?: Record<string, unknown>) => {
      try {
        await errorsClient.retry(errorId, action, args);
        removeError(errorId);
      } catch (error) {
        logError("Error retry failed", error);
      } finally {
        clearRetryProgress(errorId);
      }
    },
    [removeError, clearRetryProgress]
  );

  const handleCancelRetry = useCallback(
    (errorId: string) => {
      errorsClient.cancelRetry(errorId);
      clearRetryProgress(errorId);
    },
    [clearRetryProgress]
  );

  return { handleErrorRetry, handleCancelRetry };
}
