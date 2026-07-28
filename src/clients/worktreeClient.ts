import type {
  WorktreeState,
  CreateWorktreeOptions,
  BranchInfo,
  AttachIssuePayload,
  IssueAssociation,
} from "@shared/types";
import type { PRServiceStatus } from "@shared/types/workspace-host";
import type { WorktreeChanges } from "@shared/types/git";

/**
 * @example
 * ```typescript
 * import { worktreeClient } from "@/clients/worktreeClient";
 *
 * const worktrees = await worktreeClient.getAll();
 * ```
 */
export const worktreeClient = {
  getAll: (): Promise<WorktreeState[]> => {
    return window.electron.worktree.getAll();
  },

  refresh: (worktreeId?: string): Promise<void> => {
    return window.electron.worktree.refresh(worktreeId);
  },

  /**
   * Force a fresh `git status` for one worktree and return the change set
   * directly (#11343). Unlike `refresh` (which resolves `void` and relies on
   * the follow-up broadcast to update the store), this returns the live
   * changes in the reply, so a destructive-confirm surface can gate on them
   * race-free. `null` when the worktree's monitor no longer exists.
   */
  getFreshChanges: async (worktreeId: string): Promise<WorktreeChanges | null> => {
    const { changes } = await window.electron.worktreePort.request("get-worktree-changes", {
      worktreeId,
    });
    return changes;
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

  fetchPRBranch: (rootPath: string, prNumber: number, headRefName: string): Promise<void> => {
    return window.electron.worktree.fetchPRBranch(rootPath, prNumber, headRefName);
  },

  getRecentBranches: (rootPath: string): Promise<string[]> => {
    return window.electron.worktree.getRecentBranches(rootPath);
  },

  getDefaultPath: (rootPath: string, branchName: string): Promise<string> => {
    return window.electron.worktree.getDefaultPath(rootPath, branchName);
  },

  getAvailableBranch: (rootPath: string, branchName: string): Promise<string> => {
    return window.electron.worktree.getAvailableBranch(rootPath, branchName);
  },

  delete: async (
    worktreeId: string,
    force?: boolean,
    deleteBranch?: boolean,
    mutationId?: string
  ): Promise<void> => {
    // Route through the dedicated worktree port (#8405) so the host's ack map
    // can dedupe outbox replays by `mutationId`, and so a host crash mid-call
    // rejects the request immediately (HOST_EXITED) instead of leaving the
    // legacy IPC promise pending. The legacy `window.electron.worktree.delete`
    // path stays in the preload bridge for backward compat with non-outbox
    // callers (none today in the renderer), but the renderer's user-driven
    // deletes always go through this port-backed wrapper.
    await window.electron.worktreePort.request("delete-worktree", {
      worktreeId,
      force,
      deleteBranch,
      mutationId,
    });
  },

  attachIssue: (payload: AttachIssuePayload): Promise<void> => {
    return window.electron.worktree.attachIssue(payload);
  },

  detachIssue: (worktreeId: string): Promise<void> => {
    return window.electron.worktree.detachIssue(worktreeId);
  },

  getAllIssueAssociations: (): Promise<Record<string, IssueAssociation>> => {
    return window.electron.worktree.getAllIssueAssociations();
  },

  restartService: (): Promise<void> => {
    return window.electron.worktree.restartService();
  },

  retryProjectLoad: (): Promise<void> => {
    return window.electron.worktree.retryProjectLoad();
  },

  onRemove: (callback: (data: { worktreeId: string }) => void): (() => void) => {
    return window.electron.worktree.onRemove(callback);
  },

  onActivated: (callback: (data: { worktreeId: string }) => void): (() => void) => {
    return window.electron.worktree.onActivated(callback);
  },

  resourceAction: async (
    worktreeId: string,
    action: "provision" | "teardown" | "resume" | "pause" | "status"
  ): Promise<void> => {
    await window.electron.worktreePort.request("resource-action", { worktreeId, action });
  },

  retrySetup: async (worktreeId: string): Promise<void> => {
    await window.electron.worktreePort.request("run-lifecycle-setup", { worktreeId });
  },

  switchEnvironment: async (worktreeId: string, envKey: string): Promise<void> => {
    await window.electron.worktreePort.request("switch-worktree-environment", {
      worktreeId,
      envKey,
    });
  },

  hasResourceConfig: (rootPath: string): Promise<{ hasConfig: boolean }> => {
    return window.electron.worktreePort.request("has-resource-config", { rootPath });
  },
} as const;
