import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import type { BranchInfo } from "../../../../shared/types/git.js";
import { generateWorktreePath, validatePathPattern } from "../../../../shared/utils/pathPattern.js";
import { resolveWorktreePattern } from "../../../utils/worktreePattern.js";
import { gitServiceCache } from "../../../services/GitServiceCache.js";
import { resolveForgeRemoteNameForCwd, resolvePRHeadRefspecForCwd } from "../forgeResolution.js";
import { defineIpcNamespace, op } from "../../define.js";

export function registerWorktreeBranchHandlers(deps: HandlerDependencies): () => void {
  const handleWorktreeListBranches = async (payload: {
    rootPath: string;
  }): Promise<BranchInfo[]> => {
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }
    return await deps.worktreeService.listBranches(payload.rootPath);
  };

  const handleWorktreeFetchPRBranch = async (payload: {
    rootPath: string;
    prNumber: number;
    headRefName: string;
  }): Promise<void> => {
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }
    if (!payload.rootPath || typeof payload.rootPath !== "string") {
      throw new Error("rootPath is required");
    }
    if (!payload.prNumber || typeof payload.prNumber !== "number" || payload.prNumber <= 0) {
      throw new Error("prNumber must be a positive number");
    }
    if (!payload.headRefName || typeof payload.headRefName !== "string") {
      throw new Error("headRefName is required");
    }
    // The PR ref only exists on the repository the PR was opened against, so
    // fetching from `origin` fails outright when the forge is configured as
    // `upstream`/`github` (#11747). Resolved here rather than in the renderer
    // (which has no remote table) or the workspace-host (which must not gain a
    // forge-provider dependency). A StaleForgeRemoteError propagates rather
    // than falling back: PR numbers are per-repository, so guessing a remote
    // could fetch an unrelated PR that happens to share the number.
    const remoteName = await resolveForgeRemoteNameForCwd(payload.rootPath);
    // Strictly after the remote name: that call fails closed on a stale or
    // unverifiable remote, and the refspec resolver swallows everything into a
    // GitHub-shaped fallback, so resolving it first would bury that failure.
    //
    // The ref shape is the forge's, not the host's (#12324) — GitHub serves
    // `pull/<n>/head`, GitLab `refs/merge-requests/<n>/head`. `undefined` means
    // we could not determine it and the host's GitHub-shaped default applies.
    const refspec = await resolvePRHeadRefspecForCwd(
      payload.rootPath,
      payload.prNumber,
      payload.headRefName
    );
    if (refspec === null) {
      // The provider positively told us this forge has no fetchable PR-head
      // ref, so the default would fail with a confusing "couldn't find remote
      // ref" instead of saying what is actually wrong.
      throw new Error(
        `This forge doesn't publish a fetchable ref for pull request #${payload.prNumber}. Fetch the "${payload.headRefName}" branch yourself, then create the worktree from that existing branch.`
      );
    }
    await deps.worktreeService.fetchPRBranch(
      payload.rootPath,
      payload.prNumber,
      payload.headRefName,
      remoteName ?? undefined,
      refspec
    );
  };

  const handleWorktreeGetRecentBranches = async (payload: {
    rootPath: string;
  }): Promise<string[]> => {
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }
    return await deps.worktreeService.getRecentBranches(payload.rootPath);
  };

  const handleWorktreeGetDefaultPath = async (payload: {
    rootPath: string;
    branchName: string;
  }): Promise<string> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload for worktree:get-default-path");
    }

    const { rootPath, branchName } = payload;

    if (typeof rootPath !== "string" || !rootPath.trim()) {
      throw new Error("Invalid rootPath: must be a non-empty string");
    }

    if (typeof branchName !== "string" || !branchName.trim()) {
      throw new Error("Invalid branchName: must be a non-empty string");
    }

    const pattern = await resolveWorktreePattern(rootPath);

    const validation = validatePathPattern(pattern);
    if (!validation.valid) {
      throw new Error(`Invalid stored pattern: ${validation.error}`);
    }

    const initialPath = generateWorktreePath(rootPath, branchName, pattern);

    const gitService = gitServiceCache.getGitService(rootPath);
    return gitService.findAvailablePath(initialPath);
  };

  const handleWorktreeGetAvailableBranch = async (payload: {
    rootPath: string;
    branchName: string;
  }): Promise<string> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload for worktree:get-available-branch");
    }

    const { rootPath, branchName } = payload;

    if (typeof rootPath !== "string" || !rootPath.trim()) {
      throw new Error("Invalid rootPath: must be a non-empty string");
    }

    if (typeof branchName !== "string" || !branchName.trim()) {
      throw new Error("Invalid branchName: must be a non-empty string");
    }

    const gitService = gitServiceCache.getGitService(rootPath);
    return gitService.findAvailableBranchName(branchName);
  };

  const namespace = defineIpcNamespace({
    name: "worktreeBranches",
    ops: {
      listBranches: op(CHANNELS.WORKTREE_LIST_BRANCHES, handleWorktreeListBranches),
      fetchPRBranch: op(CHANNELS.WORKTREE_FETCH_PR_BRANCH, handleWorktreeFetchPRBranch),
      getRecentBranches: op(CHANNELS.WORKTREE_GET_RECENT_BRANCHES, handleWorktreeGetRecentBranches),
      getDefaultPath: op(CHANNELS.WORKTREE_GET_DEFAULT_PATH, handleWorktreeGetDefaultPath),
      getAvailableBranch: op(
        CHANNELS.WORKTREE_GET_AVAILABLE_BRANCH,
        handleWorktreeGetAvailableBranch
      ),
    },
  });

  return namespace.register();
}
