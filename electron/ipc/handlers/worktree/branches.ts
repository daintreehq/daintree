import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import type { BranchInfo } from "../../../../shared/types/git.js";
import { generateWorktreePath, validatePathPattern } from "../../../../shared/utils/pathPattern.js";
import { resolveWorktreePattern } from "../../../utils/worktreePattern.js";
import { gitServiceCache } from "../../../services/GitServiceCache.js";
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
    await deps.worktreeService.fetchPRBranch(
      payload.rootPath,
      payload.prNumber,
      payload.headRefName
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
