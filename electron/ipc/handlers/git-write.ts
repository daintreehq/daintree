import { CHANNELS } from "../channels.js";
import { checkRateLimit, typedHandle } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type { GitStatus } from "../../../shared/types/git.js";
import { validateCwd, createHardenedGit, createAuthenticatedGit } from "../../utils/hardenedGit.js";
import { store } from "../../store.js";
import { soundService } from "../../services/SoundService.js";
import { preAgentSnapshotService } from "../../services/PreAgentSnapshotService.js";
import type { SnapshotInfo, SnapshotRevertResult } from "../../../shared/types/ipc/git.js";
import type { GitOperationReason, RecoveryAction } from "../../../shared/types/ipc/errors.js";
import {
  classifyGitError,
  getGitRecoveryAction,
} from "../../../shared/utils/gitOperationErrors.js";

interface StagingFileEntry {
  path: string;
  status: GitStatus;
  insertions: number | null;
  deletions: number | null;
}

export interface StagingStatus {
  staged: StagingFileEntry[];
  unstaged: StagingFileEntry[];
  conflicted: string[];
  isDetachedHead: boolean;
  currentBranch: string | null;
  hasRemote: boolean;
}

export function registerGitWriteHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleStageFile = async (payload: { cwd: string; filePath: string }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_FILE, 30, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.filePath !== "string" || !payload.filePath) {
      throw new Error("Invalid file path");
    }

    const git = createHardenedGit(payload.cwd);
    await git.add(["--", payload.filePath]);
  };
  handlers.push(typedHandle(CHANNELS.GIT_STAGE_FILE, handleStageFile));

  const handleUnstageFile = async (payload: { cwd: string; filePath: string }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_FILE, 30, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.filePath !== "string" || !payload.filePath) {
      throw new Error("Invalid file path");
    }

    const git = createHardenedGit(payload.cwd);

    let hasHead = true;
    try {
      await git.revparse(["HEAD"]);
    } catch {
      hasHead = false;
    }

    if (hasHead) {
      await git.reset(["HEAD", "--", payload.filePath]);
    } else {
      await git.raw(["rm", "--cached", "--", payload.filePath]);
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_UNSTAGE_FILE, handleUnstageFile));

  const handleStageAll = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_ALL, 10, 10_000);
    validateCwd(cwd);

    const git = createHardenedGit(cwd);
    await git.add("-A");
  };
  handlers.push(typedHandle(CHANNELS.GIT_STAGE_ALL, handleStageAll));

  const handleUnstageAll = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_ALL, 10, 10_000);
    validateCwd(cwd);

    const git = createHardenedGit(cwd);

    let hasHead = true;
    try {
      await git.revparse(["HEAD"]);
    } catch {
      hasHead = false;
    }

    if (hasHead) {
      await git.reset(["HEAD"]);
    } else {
      await git.raw(["rm", "--cached", "-r", "."]);
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_UNSTAGE_ALL, handleUnstageAll));

  const handleCommit = async (payload: {
    cwd: string;
    message: string;
  }): Promise<{ hash: string; summary: string }> => {
    checkRateLimit(CHANNELS.GIT_COMMIT, 5, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.message !== "string" || !payload.message.trim()) {
      throw new Error("Commit message is required");
    }

    const git = createHardenedGit(payload.cwd);
    const result = await git.commit(payload.message.trim());
    if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
      soundService.play("git-commit");
    }
    return {
      hash: result.commit || "",
      summary: `${result.summary.changes} changed, ${result.summary.insertions} insertions(+), ${result.summary.deletions} deletions(-)`,
    };
  };
  handlers.push(typedHandle(CHANNELS.GIT_COMMIT, handleCommit));

  const handlePush = async (payload: {
    cwd: string;
    setUpstream?: boolean;
  }): Promise<{
    success: boolean;
    error?: string;
    gitReason?: GitOperationReason;
    recoveryAction?: RecoveryAction;
  }> => {
    checkRateLimit(CHANNELS.GIT_PUSH, 5, 10_000);
    validateCwd(payload?.cwd);

    const git = createAuthenticatedGit(payload.cwd);

    try {
      const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
      const branchName = branch.trim();

      if (payload.setUpstream) {
        await git.push(["--set-upstream", "origin", branchName]);
      } else {
        try {
          await git.push();
        } catch (pushErr) {
          // Keep the narrow upstream-missing auto-retry via substring match —
          // classifier's `config-missing` also covers unrelated config errors.
          const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
          if (msg.includes("no upstream branch") || msg.includes("has no upstream")) {
            await git.push(["--set-upstream", "origin", branchName]);
          } else {
            throw pushErr;
          }
        }
      }
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        soundService.play("git-push");
      }
      return { success: true };
    } catch (error) {
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        soundService.play("git-push-error");
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      const gitReason = classifyGitError(error);
      return {
        success: false,
        error: errorMessage,
        gitReason,
        recoveryAction: getGitRecoveryAction(gitReason),
      };
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_PUSH, handlePush));

  const handleGetUsername = async (cwd: string): Promise<string | null> => {
    checkRateLimit(CHANNELS.GIT_GET_USERNAME, 20, 10_000);
    validateCwd(cwd);
    const git = createHardenedGit(cwd);
    try {
      const { value } = await git.getConfig("user.name");
      return value || null;
    } catch {
      return null;
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_GET_USERNAME, handleGetUsername));

  const handleGetStagingStatus = async (cwd: string): Promise<StagingStatus> => {
    checkRateLimit(CHANNELS.GIT_GET_STAGING_STATUS, 20, 10_000);
    validateCwd(cwd);

    const git = createHardenedGit(cwd);
    const status = await git.status();

    const mapStatus = (s: string): GitStatus => {
      switch (s) {
        case "M":
          return "modified";
        case "A":
          return "added";
        case "D":
          return "deleted";
        case "R":
          return "renamed";
        case "C":
          return "copied";
        case "U":
          return "conflicted";
        case "?":
          return "untracked";
        case "!":
          return "ignored";
        default:
          return "modified";
      }
    };

    const staged: StagingFileEntry[] = [];
    const unstaged: StagingFileEntry[] = [];
    const conflicted: string[] = status.conflicted ?? [];

    const conflictedSet = new Set(conflicted);

    for (const file of status.files) {
      const indexStatus = file.index;
      const workingStatus = file.working_dir;

      if (conflictedSet.has(file.path)) {
        continue;
      }

      if (indexStatus && indexStatus !== " " && indexStatus !== "?") {
        staged.push({
          path: file.path,
          status: mapStatus(indexStatus),
          insertions: null,
          deletions: null,
        });
      }

      if (workingStatus && workingStatus !== " ") {
        unstaged.push({
          path: file.path,
          status: workingStatus === "?" ? "untracked" : mapStatus(workingStatus),
          insertions: null,
          deletions: null,
        });
      }
    }

    let isDetachedHead = false;
    let currentBranch: string | null = status.current;
    if (status.current === "HEAD" || status.detached) {
      isDetachedHead = true;
      currentBranch = null;
    }

    let hasRemote = false;
    try {
      const remotes = await git.getRemotes();
      hasRemote = remotes.length > 0;
    } catch {
      // no remotes
    }

    return { staged, unstaged, conflicted, isDetachedHead, currentBranch, hasRemote };
  };
  handlers.push(typedHandle(CHANNELS.GIT_GET_STAGING_STATUS, handleGetStagingStatus));

  const DIFF_LINE_LIMIT = 500;

  const handleGetWorkingDiff = async (payload: {
    cwd: string;
    type: "unstaged" | "staged" | "head";
  }): Promise<string> => {
    checkRateLimit(CHANNELS.GIT_GET_WORKING_DIFF, 20, 10_000);
    validateCwd(payload?.cwd);
    const diffType = payload?.type;
    if (diffType !== "unstaged" && diffType !== "staged" && diffType !== "head") {
      throw new Error("Invalid diff type: must be 'unstaged', 'staged', or 'head'");
    }

    const git = createHardenedGit(payload.cwd);

    let raw: string;
    switch (diffType) {
      case "unstaged":
        raw = await git.diff(["--no-ext-diff"]);
        break;
      case "staged":
        raw = await git.diff(["--no-ext-diff", "--cached"]);
        break;
      case "head":
        raw = await git.diff(["--no-ext-diff", "HEAD"]);
        break;
    }

    if (!raw) return "";

    const lines = raw.split("\n");
    if (lines.length > DIFF_LINE_LIMIT) {
      return (
        lines.slice(0, DIFF_LINE_LIMIT).join("\n") +
        `\n[Diff truncated — showing first ${DIFF_LINE_LIMIT} of ${lines.length} lines]`
      );
    }

    return raw;
  };
  handlers.push(typedHandle(CHANNELS.GIT_GET_WORKING_DIFF, handleGetWorkingDiff));

  // Snapshot handlers
  const handleSnapshotGet = async (worktreeId: string): Promise<SnapshotInfo | null> => {
    if (typeof worktreeId !== "string" || !worktreeId) return null;
    return preAgentSnapshotService.getSnapshot(worktreeId);
  };
  handlers.push(typedHandle(CHANNELS.GIT_SNAPSHOT_GET, handleSnapshotGet));

  const handleSnapshotList = async (): Promise<SnapshotInfo[]> => {
    return preAgentSnapshotService.listSnapshots();
  };
  handlers.push(typedHandle(CHANNELS.GIT_SNAPSHOT_LIST, handleSnapshotList));

  const handleSnapshotRevert = async (worktreeId: string): Promise<SnapshotRevertResult> => {
    validateCwd(worktreeId);
    checkRateLimit(CHANNELS.GIT_SNAPSHOT_REVERT, 3, 10_000);
    return preAgentSnapshotService.revertToSnapshot(worktreeId);
  };
  handlers.push(typedHandle(CHANNELS.GIT_SNAPSHOT_REVERT, handleSnapshotRevert));

  const handleSnapshotDelete = async (worktreeId: string): Promise<void> => {
    validateCwd(worktreeId);
    await preAgentSnapshotService.deleteSnapshot(worktreeId);
  };
  handlers.push(typedHandle(CHANNELS.GIT_SNAPSHOT_DELETE, handleSnapshotDelete));

  return () => handlers.forEach((cleanup) => cleanup());
}
