import type { SessionRestoreConfig } from "@shared/types";

export const sessionRestoreClient = {
  getConfig: (): Promise<SessionRestoreConfig> => {
    return window.electron.sessionRestore.getConfig();
  },

  updateConfig: (config: Partial<SessionRestoreConfig>): Promise<SessionRestoreConfig> => {
    return window.electron.sessionRestore.updateConfig(config);
  },

  /** Renderer-side readiness signal; see the handler for why it exists. */
  notifyViewHydrated: (): Promise<void> => {
    return window.electron.sessionRestore.notifyViewHydrated();
  },
} as const;
