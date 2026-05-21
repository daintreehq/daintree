/**
 * Worktree handlers - Composes all worktree-related IPC handlers.
 *
 * Extracted from the monolithic worktree.ts into focused modules:
 * - lifecycle.ts: get-all, refresh, set-active, create, delete
 * - branches.ts: list-branches, fetch-pr-branch, get-recent-branches,
 *                get-default-path, get-available-branch
 * - pull-requests.ts: pr-refresh, pr-status, attach-issue, detach-issue,
 *                     get-issue-association, get-all-issue-associations
 * - constants.ts: rate-limit key/interval shared by lifecycle handlers
 */

import type { HandlerDependencies } from "../../types.js";
import { registerWorktreeLifecycleHandlers } from "./lifecycle.js";
import { registerWorktreeBranchHandlers } from "./branches.js";
import { registerWorktreePullRequestHandlers } from "./pull-requests.js";

export function registerWorktreeHandlers(deps: HandlerDependencies): () => void {
  const cleanups = [
    registerWorktreeLifecycleHandlers(deps),
    registerWorktreeBranchHandlers(deps),
    registerWorktreePullRequestHandlers(deps),
  ];

  return () => cleanups.forEach((cleanup) => cleanup());
}
