import type { WorktreeConfig } from "@shared/types";

export const worktreeConfigClient = {
  get: (): Promise<WorktreeConfig> => {
    return window.electron.worktreeConfig.get();
  },

  setPattern: (pattern: string): Promise<WorktreeConfig> => {
    return window.electron.worktreeConfig.setPattern(pattern);
  },

  setWslGit: (worktreeId: string, enabled: boolean): Promise<void> => {
    return window.electron.worktreeConfig.setWslGit(worktreeId, enabled);
  },

  dismissWslBanner: (worktreeId: string): Promise<void> => {
    return window.electron.worktreeConfig.dismissWslBanner(worktreeId);
  },
} as const;
