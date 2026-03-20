import type { HibernationConfig, HibernationProjectHibernatedPayload } from "@shared/types";

export const hibernationClient = {
  getConfig: (): Promise<HibernationConfig> => {
    return window.electron.hibernation.getConfig();
  },

  updateConfig: (config: Partial<HibernationConfig>): Promise<HibernationConfig> => {
    return window.electron.hibernation.updateConfig(config);
  },

  onProjectHibernated: (
    callback: (payload: HibernationProjectHibernatedPayload) => void
  ): (() => void) => {
    return window.electron.hibernation.onProjectHibernated(callback);
  },
} as const;
