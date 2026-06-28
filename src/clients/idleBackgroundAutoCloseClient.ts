import type { IdleBackgroundAutoCloseConfig, IdleBackgroundClosedPayload } from "@shared/types";

export const idleBackgroundAutoCloseClient = {
  getConfig: (): Promise<IdleBackgroundAutoCloseConfig> => {
    return window.electron.idleBackgroundAutoClose.getConfig();
  },

  updateConfig: (
    config: Partial<IdleBackgroundAutoCloseConfig>
  ): Promise<IdleBackgroundAutoCloseConfig> => {
    return window.electron.idleBackgroundAutoClose.updateConfig(config);
  },

  onClosed: (callback: (payload: IdleBackgroundClosedPayload) => void): (() => void) => {
    return window.electron.idleBackgroundAutoClose.onClosed(callback);
  },
} as const;
