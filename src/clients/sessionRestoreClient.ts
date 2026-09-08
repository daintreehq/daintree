import type { SessionRestoreConfig } from "@shared/types";

export const sessionRestoreClient = {
  getConfig: (): Promise<SessionRestoreConfig> => {
    return window.electron.sessionRestore.getConfig();
  },

  updateConfig: (config: Partial<SessionRestoreConfig>): Promise<SessionRestoreConfig> => {
    return window.electron.sessionRestore.updateConfig(config);
  },
} as const;
