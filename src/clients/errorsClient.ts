import type { AppError, RetryAction, RetryProgressPayload } from "@shared/types";

export const errorsClient = {
  onError: (callback: (error: AppError) => void): (() => void) => {
    return window.electron.errors.onError(callback);
  },

  retry: (errorId: string, action: RetryAction, args?: Record<string, unknown>): Promise<void> => {
    return window.electron.errors.retry(errorId, action, args);
  },

  cancelRetry: (errorId: string): void => {
    window.electron.errors.cancelRetry(errorId);
  },

  onRetryProgress: (callback: (payload: RetryProgressPayload) => void): (() => void) => {
    return window.electron.errors.onRetryProgress(callback);
  },

  openLogs: (): Promise<void> => {
    return window.electron.errors.openLogs();
  },

  getPending: (): Promise<AppError[]> => {
    return window.electron.errors.getPending();
  },
} as const;
