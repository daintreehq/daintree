import type {
  WorktreeState,
  WorktreeListResult,
  CreateWorktreeOptions,
  BranchInfo,
  AttachIssuePayload,
  IssueAssociation,
} from "@shared/types";
import type { WorktreeCreateResult } from "@shared/types/worktree";
import type { PRServiceStatus } from "@shared/types/workspace-host";
import type { WorktreeChanges } from "@shared/types/git";
import type { SubmoduleDeleteRisk } from "@shared/types/submodule";

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

  /**
   * `getAll` plus the workspace host's own probe of the project root.
   *
   * Use this wherever an empty list would otherwise be read as "this workspace
   * has no worktrees": on its own, `[]` also means "the host has not registered
   * yet", and hydration races host startup by design. `gitBacked` is the host's
   * live `checkIsRepo`, not the project row's persisted column — that column is
   * NULL both for a real repository and for one never classified, so it cannot
   * gate whether foreign worktree state may be adopted (#11650).
   */
  getAllWithStatus: (): Promise<WorktreeListResult> => {
    return window.electron.worktree.getAllWithStatus();
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

  /**
   * Create a worktree, reporting the branch the host actually landed on
   * alongside the id.
   *
   * `branch` is not always the one requested: the host resolves collisions
   * atomically against the failing `git worktree add`, so it can suffix the
   * name or switch to reusing an existing local branch. Read it from here
   * rather than from the worktree store — store rows arrive over a different
   * port than this response, so there is no ordering between them.
   */
  create: (options: CreateWorktreeOptions, rootPath: string): Promise<WorktreeCreateResult> => {
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

  /**
   * Options are an object rather than positional booleans on purpose: `force`,
   * `deleteBranch` and `forceDeleteBranch` are three independent consents, and
   * a run of same-typed positional flags is how the first two came to be
   * conflated in the first place. Each one names exactly what it permits.
   */
  delete: async (
    worktreeId: string,
    options: {
      /** Remove the working tree even though it has uncommitted changes. */
      force?: boolean;
      /** Also delete the branch the worktree had checked out. */
      deleteBranch?: boolean;
      /**
       * Delete that branch even when Git refuses the safe delete (`branch -D`
       * rather than `-d`). Git's test is whether the branch is fully merged
       * into its upstream — or into HEAD when it has none — NOT whether the
       * commits exist on some other ref, so "commits nothing else holds"
       * overstates what this discards. Independent of `force`: consenting to
       * discard an uncommitted file is not consenting to discard a commit.
       */
      forceDeleteBranch?: boolean;
      mutationId?: string;
    } = {}
  ): Promise<void> => {
    const { force, deleteBranch, forceDeleteBranch, mutationId } = options;
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
      forceDeleteBranch,
      mutationId,
    });
  },

  /**
   * Inventory what deleting this worktree would destroy inside its submodules.
   *
   * The parent's `git status` reports a submodule holding any amount of
   * uncommitted work as one changed path, so `getFreshChanges` alone cannot
   * tell a delete-confirm surface what is actually at stake. Kept as its own
   * call rather than a field on `WorktreeChanges`, which rides the snapshot
   * hot path and would neither clone nor compare a nested object correctly.
   *
   * `risk.incomplete` means the inventory could not be finished — treat it as
   * risk present, never as nothing found. `null` when the worktree's monitor
   * no longer exists.
   */
  getSubmoduleDeleteRisk: async (worktreeId: string): Promise<SubmoduleDeleteRisk | null> => {
    const { risk } = await window.electron.worktreePort.request("get-submodule-delete-risk", {
      worktreeId,
    });
    return risk;
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
