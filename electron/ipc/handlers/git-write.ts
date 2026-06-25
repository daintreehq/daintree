// eager-import-allow: reads git config via store.get synchronously while servicing git-write IPC
import { execFile } from "node:child_process";
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CHANNELS } from "../channels.js";
import { checkRateLimit, typedHandle, typedHandleWithContext, sendToRenderer } from "../utils.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type { PushProgressEvent } from "../../../shared/types/ipc/gitPush.js";
import type {
  ConflictedFileEntry,
  GitStatus,
  RebaseSequence,
  RepoState,
  StagingStatus,
} from "../../../shared/types/git.js";
import {
  validateCwd,
  createHardenedGit,
  createAuthenticatedGit,
  buildContinueEnv,
} from "../../utils/hardenedGit.js";
import { getPerFileDiffStats, invalidateStagingDiffStatCache } from "../../utils/git.js";
import { store } from "../../store.js";
import { getSoundService } from "../../services/getSoundService.js";
import type * as SoundServiceModule from "../../services/SoundService.js";
import { detectRepoOperationState, resolveGitDir } from "../../services/git/repoOperationState.js";
import { parsePorcelainV2Conflicts } from "../../services/git/porcelainConflicts.js";
import {
  STAGED_FILE_SIZE_CAP,
  scanStagedFilesForConflictMarkers,
} from "../../services/git/conflictMarkerScan.js";

type SoundId = keyof typeof SoundServiceModule.SOUND_FILES;

function playSoundFireAndForget(id: SoundId): void {
  void getSoundService()
    .then((svc) => svc.play(id))
    .catch((err) => console.error("[git-write] sound play failed:", err));
}
import { preAgentSnapshotService } from "../../services/PreAgentSnapshotService.js";
import type {
  SnapshotInfo,
  SnapshotRevertResult,
  ConflictMarkerScanEntry,
  GitScanConflictMarkersPayload,
  GitCheckoutOursTheirsPayload,
} from "../../../shared/types/ipc/git.js";
import { classifyGitError } from "../../../shared/utils/gitOperationErrors.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { GitOperationError } from "../../utils/errorTypes.js";

const execFileAsync = promisify(execFile);

function classifyGitFailure(error: unknown, formattedMessage: string) {
  const reason = classifyGitError(error);
  return reason === "unknown" ? classifyGitError(formattedMessage) : reason;
}

function encodeGitOperationErrorMessage(
  reason: ReturnType<typeof classifyGitFailure>,
  message: string,
  fields: { leaseSha?: string; branchName?: string } = {}
): string {
  const leaseSha = fields.leaseSha ? encodeURIComponent(fields.leaseSha) : "";
  const branchName = fields.branchName ? encodeURIComponent(fields.branchName) : "";
  return `[GitError|${reason}|${leaseSha}|${branchName}] ${message}`;
}

interface StagingFileEntry {
  path: string;
  status: GitStatus;
  insertions: number | null;
  deletions: number | null;
}

export function registerGitWriteHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleStageFile = async (payload: { cwd: string; filePath: string }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_FILE, 30, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.filePath !== "string" || !payload.filePath) {
      throw new Error("Invalid file path");
    }

    const git = await createHardenedGit(payload.cwd);
    await git.add(["--", payload.filePath]);
    invalidateStagingDiffStatCache(payload.cwd);
  };
  handlers.push(typedHandle(CHANNELS.GIT_STAGE_FILE, handleStageFile));

  const handleUnstageFile = async (payload: { cwd: string; filePath: string }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_FILE, 30, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.filePath !== "string" || !payload.filePath) {
      throw new Error("Invalid file path");
    }

    const git = await createHardenedGit(payload.cwd);

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
    invalidateStagingDiffStatCache(payload.cwd);
  };
  handlers.push(typedHandle(CHANNELS.GIT_UNSTAGE_FILE, handleUnstageFile));

  const validateFilePaths = (filePaths: unknown): string[] => {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error("filePaths must be a non-empty array");
    }
    for (const p of filePaths) {
      if (typeof p !== "string" || !p) {
        throw new Error("Invalid file path in filePaths");
      }
    }
    return filePaths as string[];
  };

  const handleStageFiles = async (payload: { cwd: string; filePaths: string[] }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_FILES, 10, 10_000);
    validateCwd(payload?.cwd);
    const paths = validateFilePaths(payload?.filePaths);

    const git = await createHardenedGit(payload.cwd);
    await git.add(["--", ...paths]);
    invalidateStagingDiffStatCache(payload.cwd);
  };
  handlers.push(typedHandle(CHANNELS.GIT_STAGE_FILES, handleStageFiles));

  const handleUnstageFiles = async (payload: {
    cwd: string;
    filePaths: string[];
  }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_FILES, 10, 10_000);
    validateCwd(payload?.cwd);
    const paths = validateFilePaths(payload?.filePaths);

    const git = await createHardenedGit(payload.cwd);

    let hasHead = true;
    try {
      await git.revparse(["HEAD"]);
    } catch {
      hasHead = false;
    }

    if (hasHead) {
      await git.reset(["HEAD", "--", ...paths]);
    } else {
      await git.raw(["rm", "--cached", "--", ...paths]);
    }
    invalidateStagingDiffStatCache(payload.cwd);
  };
  handlers.push(typedHandle(CHANNELS.GIT_UNSTAGE_FILES, handleUnstageFiles));

  const handleStageAll = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_ALL, 10, 10_000);
    validateCwd(cwd);

    const git = await createHardenedGit(cwd);
    await git.add("-A");
    invalidateStagingDiffStatCache(cwd);
  };
  handlers.push(typedHandle(CHANNELS.GIT_STAGE_ALL, handleStageAll));

  const handleUnstageAll = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_ALL, 10, 10_000);
    validateCwd(cwd);

    const git = await createHardenedGit(cwd);

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
    invalidateStagingDiffStatCache(cwd);
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

    const git = await createHardenedGit(payload.cwd);
    await scanStagedFilesForConflictMarkers(git);
    const result = await git.commit(payload.message.trim());
    if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
      playSoundFireAndForget("git-commit");
    }
    return {
      hash: result.commit || "",
      summary: `${result.summary.changes} changed, ${result.summary.insertions} insertions(+), ${result.summary.deletions} deletions(-)`,
    };
  };
  handlers.push(typedHandle(CHANNELS.GIT_COMMIT, handleCommit));

  const pushingCwds = new Set<string>();

  const handlePush = async (
    ctx: IpcContext,
    payload: { cwd: string; setUpstream?: boolean }
  ): Promise<void> => {
    if (pushingCwds.has(payload.cwd)) return;

    checkRateLimit(CHANNELS.GIT_PUSH, 5, 10_000);
    validateCwd(payload?.cwd);

    pushingCwds.add(payload.cwd);
    const git = await createAuthenticatedGit(payload.cwd);
    let branchName: string | undefined;
    const senderWindow = ctx.senderWindow;

    const sendProgress = (event: PushProgressEvent) => {
      if (senderWindow && !senderWindow.isDestroyed()) {
        sendToRenderer(senderWindow, CHANNELS.GIT_PUSH_PROGRESS, event);
      }
    };

    try {
      const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
      branchName = branch.trim();

      let targetBranch: string | null = null;
      try {
        targetBranch = (await git.revparse(["--abbrev-ref", "@{upstream}"])).trim();
      } catch {
        targetBranch = payload.setUpstream ? `origin/${branchName}` : null;
      }

      sendProgress({
        cwd: payload.cwd,
        stage: "target",
        progress: null,
        processed: null,
        total: null,
        targetBranch: targetBranch ?? undefined,
      });

      const authGit = await createAuthenticatedGit(payload.cwd, {
        progress: (data) => {
          sendProgress({
            cwd: payload.cwd,
            stage: data.stage,
            progress: data.progress,
            processed: data.processed,
            total: data.total,
          });
        },
      });

      if (payload.setUpstream) {
        await authGit.push(["--set-upstream", "origin", branchName]);
      } else {
        try {
          await authGit.push();
        } catch (pushErr) {
          const msg = formatErrorMessage(pushErr, "git push failed");
          if (msg.includes("no upstream branch") || msg.includes("has no upstream")) {
            await authGit.push(["--set-upstream", "origin", branchName]);
            sendProgress({
              cwd: payload.cwd,
              stage: "target",
              progress: null,
              processed: null,
              total: null,
              targetBranch: `origin/${branchName}`,
            });
          } else {
            throw pushErr;
          }
        }
      }
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push");
      }
    } catch (error) {
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push-error");
      }
      const errorMessage = formatErrorMessage(error, "git push failed");
      const gitReason = classifyGitFailure(error, errorMessage);
      // Capture the lease SHA at rejection time, not at click time. A
      // background fetch advancing `refs/remotes/origin/<branch>` between
      // here and the user's force-push click would silently degrade
      // `--force-with-lease` to plain `--force`. revparse may itself fail
      // (no upstream tracking); on failure we omit leaseSha and the renderer
      // suppresses the force-push CTA.
      let leaseSha: string | undefined;
      if (gitReason === "push-rejected-outdated" && branchName) {
        try {
          const sha = await git.revparse([`refs/remotes/origin/${branchName}`]);
          leaseSha = sha.trim() || undefined;
        } catch {
          leaseSha = undefined;
        }
      }
      throw new GitOperationError(
        gitReason,
        encodeGitOperationErrorMessage(gitReason, errorMessage, { leaseSha, branchName }),
        {
          cwd: payload.cwd,
          op: "push",
          cause: error instanceof Error ? error : undefined,
          rawMessage: errorMessage,
          leaseSha,
          branchName,
        }
      );
    } finally {
      pushingCwds.delete(payload.cwd);
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.GIT_PUSH, handlePush));

  const handlePullRebase = async (payload: { cwd: string }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_PULL_REBASE, 3, 10_000);
    validateCwd(payload?.cwd);

    const git = await createAuthenticatedGit(payload.cwd);

    try {
      const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
      const branchName = branch.trim();
      await git.pull("origin", branchName, ["--rebase"]);
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push");
      }
    } catch (error) {
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push-error");
      }
      const errorMessage = formatErrorMessage(error, "git pull --rebase failed");
      const gitReason = classifyGitFailure(error, errorMessage);
      throw new GitOperationError(
        gitReason,
        encodeGitOperationErrorMessage(gitReason, errorMessage),
        {
          cwd: payload.cwd,
          op: "pull-rebase",
          cause: error instanceof Error ? error : undefined,
          rawMessage: errorMessage,
        }
      );
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_PULL_REBASE, handlePullRebase));

  const handleForcePushWithLease = async (payload: {
    cwd: string;
    branchName: string;
    leaseSha: string;
  }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_FORCE_PUSH_WITH_LEASE, 3, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.branchName !== "string" || !payload.branchName.trim()) {
      throw new Error("Invalid branch name");
    }
    if (typeof payload.leaseSha !== "string" || !/^[0-9a-f]{4,64}$/i.test(payload.leaseSha)) {
      // Reject anything that isn't a hex SHA — the lease ref:sha form must
      // never receive arbitrary user input that could include `--` flags.
      throw new Error("Invalid lease SHA");
    }

    const git = await createAuthenticatedGit(payload.cwd);
    const branchName = payload.branchName.trim();

    try {
      await git.push("origin", branchName, [
        `--force-with-lease=${branchName}:${payload.leaseSha}`,
        "--force-if-includes",
      ]);
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push");
      }
    } catch (error) {
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push-error");
      }
      const errorMessage = formatErrorMessage(error, "git push --force-with-lease failed");
      const gitReason = classifyGitFailure(error, errorMessage);
      throw new GitOperationError(
        gitReason,
        encodeGitOperationErrorMessage(gitReason, errorMessage, {
          leaseSha: payload.leaseSha,
          branchName,
        }),
        {
          cwd: payload.cwd,
          op: "force-push-with-lease",
          cause: error instanceof Error ? error : undefined,
          rawMessage: errorMessage,
          leaseSha: payload.leaseSha,
          branchName,
        }
      );
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_FORCE_PUSH_WITH_LEASE, handleForcePushWithLease));

  const handleListRemoteCommits = async (payload: {
    cwd: string;
    branchName: string;
    limit?: number;
  }): Promise<Array<{ hash: string; date: string; message: string; author: string }>> => {
    checkRateLimit(CHANNELS.GIT_LIST_REMOTE_COMMITS, 10, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.branchName !== "string" || !payload.branchName.trim()) {
      throw new Error("Invalid branch name");
    }
    const branchName = payload.branchName.trim();
    const limit = Math.max(1, Math.min(100, payload.limit ?? 20));

    const git = await createHardenedGit(payload.cwd);
    try {
      // No `--no-merges` — `behindCount` from `git status -b` includes merge
      // commits, and the dialog's "N more" tail relies on the listed rows
      // matching what `--force-with-lease` would actually discard. Filtering
      // merges here would understate the discard preview against `behindCount`.
      const log = await git.log([
        `--max-count=${limit}`,
        `HEAD..refs/remotes/origin/${branchName}`,
      ]);
      return log.all.map((commit) => ({
        hash: commit.hash,
        date: commit.date,
        message: commit.message,
        author: commit.author_name,
      }));
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "git log failed");
      const gitReason = classifyGitFailure(error, errorMessage);
      throw new GitOperationError(
        gitReason,
        encodeGitOperationErrorMessage(gitReason, errorMessage, { branchName }),
        {
          cwd: payload.cwd,
          op: "list-remote-commits",
          cause: error instanceof Error ? error : undefined,
          rawMessage: errorMessage,
          branchName,
        }
      );
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_LIST_REMOTE_COMMITS, handleListRemoteCommits));

  const handleGetUsername = async (cwd: string): Promise<string | null> => {
    checkRateLimit(CHANNELS.GIT_GET_USERNAME, 20, 10_000);
    validateCwd(cwd);
    const git = await createHardenedGit(cwd);
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

    const git = await createHardenedGit(cwd);
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

    // Populate per-file churn from `git diff --numstat`. The handler is
    // rate-limited to 20/10s and getPerFileDiffStats caches per (cwd, headOid,
    // mode), so this adds at most two batched git invocations per refresh.
    // Untracked entries don't appear in numstat output and keep insertions/
    // deletions = null (renderer omits the churn span in that case).
    let headOid = "";
    try {
      headOid = (await git.revparse(["HEAD"])).trim();
    } catch {
      // No HEAD (unborn branch / empty repo) — staged numstat would also throw;
      // skip churn entirely below.
    }

    const stagedPaths = staged.map((entry) => entry.path);
    const unstagedTrackedPaths = unstaged
      .filter((entry) => entry.status !== "untracked")
      .map((entry) => entry.path);

    const [stagedStats, unstagedStats] = await Promise.all([
      getPerFileDiffStats(git, cwd, headOid, stagedPaths, "staged"),
      getPerFileDiffStats(git, cwd, headOid, unstagedTrackedPaths, "unstaged"),
    ]);

    for (const entry of staged) {
      const stats = stagedStats.get(entry.path);
      if (stats) {
        entry.insertions = stats.insertions;
        entry.deletions = stats.deletions;
      }
    }
    for (const entry of unstaged) {
      const stats = unstagedStats.get(entry.path);
      if (stats) {
        entry.insertions = stats.insertions;
        entry.deletions = stats.deletions;
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

    let conflictedFiles: ConflictedFileEntry[] = [];
    if (conflicted.length > 0) {
      try {
        const porcelain = await git.raw(["-c", "core.quotepath=false", "status", "--porcelain=v2"]);
        conflictedFiles = parsePorcelainV2Conflicts(porcelain);
      } catch {
        // Fall back to the simple-git path list without XY labels.
      }
      if (conflictedFiles.length === 0) {
        conflictedFiles = conflicted.map((p) => ({ path: p, xy: "UU", label: "conflicted" }));
      }
    }

    let repoState: RepoState = conflicted.length > 0 ? "DIRTY" : "CLEAN";
    let rebaseStep: number | null = null;
    let rebaseTotalSteps: number | null = null;
    let rebaseSequence: RebaseSequence | null = null;
    try {
      const gitDir = await resolveGitDir(git, cwd);
      const detected = await detectRepoOperationState(gitDir, conflicted.length > 0);
      repoState = detected.state;
      rebaseStep = detected.rebaseStep;
      rebaseTotalSteps = detected.rebaseTotalSteps;
      rebaseSequence = detected.rebaseSequence;
    } catch {
      // If git-dir resolution fails, fall back to CLEAN/DIRTY from index alone.
    }

    return {
      staged,
      unstaged,
      conflicted,
      conflictedFiles,
      isDetachedHead,
      currentBranch,
      hasRemote,
      repoState,
      rebaseStep,
      rebaseTotalSteps,
      rebaseSequence,
    };
  };
  handlers.push(typedHandle(CHANNELS.GIT_GET_STAGING_STATUS, handleGetStagingStatus));

  const handleAbortRepositoryOperation = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION, 5, 10_000);
    validateCwd(cwd);

    const git = await createHardenedGit(cwd);
    const gitDir = await resolveGitDir(git, cwd);
    const { state } = await detectRepoOperationState(gitDir, false);

    switch (state) {
      case "MERGING":
        await git.merge(["--abort"]);
        return;
      case "REBASING":
        await git.rebase(["--abort"]);
        return;
      case "CHERRY_PICKING":
        await git.raw(["cherry-pick", "--abort"]);
        return;
      case "REVERTING":
        await git.raw(["revert", "--abort"]);
        return;
      default:
        throw new Error("No merge, rebase, cherry-pick, or revert operation is in progress");
    }
  };
  handlers.push(
    typedHandle(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION, handleAbortRepositoryOperation)
  );

  const handleContinueRepositoryOperation = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION, 5, 10_000);
    validateCwd(cwd);

    // One .env() call only: simple-git's .env() replaces the spawn env
    // wholesale, so re-stating the full hardened env (plus editor suppression)
    // via buildContinueEnv is the only way to keep createHardenedGit's
    // hardening intact on the continue path (#7058, #10786).
    const git = (await createHardenedGit(cwd)).env(buildContinueEnv());
    const gitDir = await resolveGitDir(git, cwd);
    const { state } = await detectRepoOperationState(gitDir, false);

    switch (state) {
      case "MERGING":
        await git.merge(["--continue", "--no-edit"]);
        return;
      case "REBASING":
        // `git rebase --continue` has no `--no-edit`; the env overlay covers it.
        await git.rebase(["--continue"]);
        return;
      case "CHERRY_PICKING":
        await git.raw(["cherry-pick", "--continue", "--no-edit"]);
        return;
      case "REVERTING":
        await git.raw(["revert", "--continue", "--no-edit"]);
        return;
      default:
        throw new Error("No merge, rebase, cherry-pick, or revert operation is in progress");
    }
  };
  handlers.push(
    typedHandle(CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION, handleContinueRepositoryOperation)
  );

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

    const git = await createHardenedGit(payload.cwd);

    let raw: string;
    switch (diffType) {
      case "unstaged":
        raw = await git.diff(["--no-ext-diff", "--no-textconv"]);
        break;
      case "staged":
        raw = await git.diff(["--no-ext-diff", "--no-textconv", "--cached"]);
        break;
      case "head":
        raw = await git.diff(["--no-ext-diff", "--no-textconv", "HEAD"]);
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

  // Rejects path traversal, absolute paths, and the worktree root itself
  // (`.`, `./`). Resolves the file under `cwd` and confirms the resolved path
  // stays strictly inside the worktree boundary — the `cwd + path.sep` guard
  // also blocks sibling-directory matches (e.g. `/foo` matching `/foobar/...`).
  const validateFilePathUnderCwd = (cwd: string, filePath: string): void => {
    if (typeof filePath !== "string" || !filePath) {
      throw new Error("Invalid file path");
    }
    if (path.isAbsolute(filePath)) {
      throw new Error("Invalid file path: must be relative to the worktree");
    }
    const resolvedCwd = path.resolve(cwd);
    const resolved = path.resolve(resolvedCwd, filePath);
    const boundary = resolvedCwd.endsWith(path.sep) ? resolvedCwd : resolvedCwd + path.sep;
    // Strict prefix match — `resolved === resolvedCwd` (i.e. `.`/`./`) is
    // rejected so the renderer can't accidentally invoke a worktree-wide
    // `git checkout --ours -- .` resolving every conflict at once.
    if (!resolved.startsWith(boundary)) {
      throw new Error("Invalid file path: must point at a file inside the worktree");
    }
  };

  const handleScanConflictMarkers = async (
    payload: GitScanConflictMarkersPayload
  ): Promise<ConflictMarkerScanEntry[]> => {
    checkRateLimit(CHANNELS.GIT_SCAN_CONFLICT_MARKERS, 30, 10_000);
    validateCwd(payload?.cwd);
    if (!Array.isArray(payload?.filePaths)) {
      throw new Error("Invalid file paths: must be an array");
    }
    if (payload.filePaths.length === 0) return [];

    // `g` flag is required for `matchAll`/`exec` iteration; the regex is local
    // to this call so the shared `CONFLICT_MARKER_RE` (single-match, `/m`) is
    // untouched. Counts only opening `<<<<<<<` markers — one per hunk.
    const HUNK_OPEN_RE = /^<{7}/gm;

    const scanOne = async (filePath: string): Promise<ConflictMarkerScanEntry> => {
      try {
        validateFilePathUnderCwd(payload.cwd, filePath);
        const absolute = path.resolve(payload.cwd, filePath);
        const stat = await fs.promises.stat(absolute);
        if (!stat.isFile() || stat.size > STAGED_FILE_SIZE_CAP) {
          return { path: filePath, hunkCount: null, firstMarkerLine: null };
        }
        const content = await fs.promises.readFile(absolute, "utf8");
        // BOM-strip so a marker on line 1 isn't shifted past the `^` anchor.
        const probe = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
        let hunkCount = 0;
        let firstMarkerLine: number | null = null;
        let match: RegExpExecArray | null;
        HUNK_OPEN_RE.lastIndex = 0;
        while ((match = HUNK_OPEN_RE.exec(probe)) !== null) {
          hunkCount++;
          if (firstMarkerLine === null) {
            // Compute 1-based line number from byte offset within the probed string.
            let line = 1;
            for (let i = 0; i < match.index; i++) {
              if (probe.charCodeAt(i) === 0x0a) line++;
            }
            firstMarkerLine = line;
          }
        }
        return { path: filePath, hunkCount, firstMarkerLine };
      } catch {
        // Treat any per-file error as a degraded scan result — the UI hides
        // the badge rather than blocking the worklist on a single bad path.
        return { path: filePath, hunkCount: null, firstMarkerLine: null };
      }
    };

    return Promise.all(payload.filePaths.map(scanOne));
  };
  handlers.push(typedHandle(CHANNELS.GIT_SCAN_CONFLICT_MARKERS, handleScanConflictMarkers));

  const handleCheckoutOursTheirs = async (payload: GitCheckoutOursTheirsPayload): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_CHECKOUT_OURS_THEIRS, 30, 10_000);
    validateCwd(payload?.cwd);
    validateFilePathUnderCwd(payload.cwd, payload?.filePath);
    if (payload.side !== "ours" && payload.side !== "theirs") {
      throw new Error("Invalid side: must be 'ours' or 'theirs'");
    }

    const git = await createHardenedGit(payload.cwd);
    const flag = payload.side === "ours" ? "--ours" : "--theirs";
    // `checkout --ours/--theirs` leaves the file unstaged — the conflict markers
    // are still in the index. Follow with `git add` so the resolution lands in
    // the staged tree and the file falls off the conflicted list.
    await git.raw(["checkout", flag, "--", payload.filePath]);
    await git.add(["--", payload.filePath]);
  };
  handlers.push(typedHandle(CHANNELS.GIT_CHECKOUT_OURS_THEIRS, handleCheckoutOursTheirs));

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
  handlers.push(
    // @ts-expect-error: SnapshotRevertResult contains {success} — pending migration to throw AppError. See #6020.
    typedHandle(CHANNELS.GIT_SNAPSHOT_REVERT, handleSnapshotRevert)
  );

  const handleSnapshotDelete = async (worktreeId: string): Promise<void> => {
    validateCwd(worktreeId);
    await preAgentSnapshotService.deleteSnapshot(worktreeId);
  };
  handlers.push(typedHandle(CHANNELS.GIT_SNAPSHOT_DELETE, handleSnapshotDelete));

  // Normalizes a path for comparison against git config safe.directory entries:
  // resolve → realpath (fall back to resolved) → forward slashes.
  const canonicalizeSafeDirectoryPath = async (p: string): Promise<string> => {
    const resolved = path.resolve(p);
    let canonical: string;
    try {
      canonical = await realpath(resolved);
    } catch {
      canonical = resolved;
    }
    return canonical.replace(/\\/g, "/");
  };

  // Resolves the "fatal: detected dubious ownership" error (CVE-2022-24765) by
  // adding the repo path to the user's global safe.directory list. The caller
  // is expected to retry the original operation after this succeeds.
  // Detection lives in the renderer (see src/store/projectStore.ts) — this
  // handler only writes the config. Inline because #5369 (unified git error
  // taxonomy) has no PR yet.
  const handleMarkSafeDirectory = async (repoPath: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_MARK_SAFE_DIRECTORY, 5, 10_000);
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Invalid path: must be a non-empty string");
    }
    if (!path.isAbsolute(repoPath)) {
      throw new Error("Invalid path: must be absolute");
    }
    const normalized = await canonicalizeSafeDirectoryPath(repoPath);

    // Check whether the path is already configured to avoid unbounded
    // duplicate entries in ~/.gitconfig. Exit code 1 (no entries set) is
    // expected for first-time users and must not propagate as an error.
    let alreadyConfigured = false;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["config", "--global", "--get-all", "safe.directory"],
        { env: { ...process.env, LC_ALL: "C" } }
      );
      const entries = stdout
        .split("\n")
        .map((e) => e.trim())
        .filter(Boolean);
      for (const entry of entries) {
        const canonicalized = await canonicalizeSafeDirectoryPath(entry);
        if (canonicalized === normalized) {
          alreadyConfigured = true;
          break;
        }
      }
    } catch (err) {
      if ((err as { code?: number }).code !== 1) {
        throw err;
      }
      // Exit code 1: no safe.directory entries exist — not configured.
    }

    if (!alreadyConfigured) {
      await execFileAsync("git", ["config", "--global", "--add", "safe.directory", normalized], {
        env: { ...process.env, LC_ALL: "C" },
      });
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_MARK_SAFE_DIRECTORY, handleMarkSafeDirectory));

  return () => handlers.forEach((cleanup) => cleanup());
}
