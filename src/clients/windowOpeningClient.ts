import type { WindowOpeningConfig } from "@shared/types";

export const windowOpeningClient = {
  getConfig: (): Promise<WindowOpeningConfig> => {
    return window.electron.windowOpening.getConfig();
  },

  updateConfig: (config: Partial<WindowOpeningConfig>): Promise<WindowOpeningConfig> => {
    return window.electron.windowOpening.updateConfig(config);
  },
} as const;
