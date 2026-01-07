import type { WorktreeState, CreateWorktreeOptions, BranchInfo } from "@shared/types";
import type { PRServiceStatus } from "@shared/types/workspace-host";

/**
 * @example
 * ```typescript
 * import { worktreeClient } from "@/clients/worktreeClient";
 *
 * const worktrees = await worktreeClient.getAll();
 * const cleanup = worktreeClient.onUpdate((state) => console.log(state));
 * ```
 */
export const worktreeClient = {
  getAll: (): Promise<WorktreeState[]> => {
    return window.electron.worktree.getAll();
  },

  refresh: (): Promise<void> => {
    return window.electron.worktree.refresh();
  },

  refreshPullRequests: (): Promise<void> => {
    return window.electron.worktree.refreshPullRequests();
  },

  getPRStatus: (): Promise<PRServiceStatus | null> => {
    return window.electron.worktree.getPRStatus();
  },

  setActive: (worktreeId: string): Promise<void> => {
    return window.electron.worktree.setActive(worktreeId);
  },

  create: (options: CreateWorktreeOptions, rootPath: string): Promise<string> => {
    return window.electron.worktree.create(options, rootPath);
  },

  listBranches: (rootPath: string): Promise<BranchInfo[]> => {
    return window.electron.worktree.listBranches(rootPath);
  },

  getDefaultPath: (rootPath: string, branchName: string): Promise<string> => {
    return window.electron.worktree.getDefaultPath(rootPath, branchName);
  },

  getAvailableBranch: (rootPath: string, branchName: string): Promise<string> => {
    return window.electron.worktree.getAvailableBranch(rootPath, branchName);
  },

  delete: (worktreeId: string, force?: boolean): Promise<void> => {
    return window.electron.worktree.delete(worktreeId, force);
  },

  onUpdate: (callback: (state: WorktreeState) => void): (() => void) => {
    return window.electron.worktree.onUpdate(callback);
  },

  onRemove: (callback: (data: { worktreeId: string }) => void): (() => void) => {
    return window.electron.worktree.onRemove(callback);
  },
} as const;
