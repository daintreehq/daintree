export const watchdogClient = {
  restart: (): Promise<void> => {
    return window.electron.watchdog.restart();
  },

  onDisabled: (
    callback: (data: {
      attemptCount: number;
      lastExitCode: number | null;
      timestamp: number;
    }) => void
  ): (() => void) => {
    return window.electron.watchdog.onDisabled(callback);
  },
} as const;
