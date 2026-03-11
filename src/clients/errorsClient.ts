import type { AppError, RetryAction } from "@shared/types";

export const errorsClient = {
  onError: (callback: (error: AppError) => void): (() => void) => {
    return window.electron.errors.onError(callback);
  },

  retry: (errorId: string, action: RetryAction, args?: Record<string, unknown>): Promise<void> => {
    return window.electron.errors.retry(errorId, action, args);
  },

  openLogs: (): Promise<void> => {
    return window.electron.errors.openLogs();
  },

  getPending: (): Promise<AppError[]> => {
    return window.electron.errors.getPending();
  },
} as const;
