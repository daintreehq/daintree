import { execFile } from "node:child_process";
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SimpleGit } from "simple-git";
import { CHANNELS } from "../channels.js";
import { checkRateLimit, typedHandle } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type {
  ConflictedFileEntry,
  GitStatus,
  RepoState,
  StagingStatus,
} from "../../../shared/types/git.js";
import { validateCwd, createHardenedGit, createAuthenticatedGit } from "../../utils/hardenedGit.js";
import { store } from "../../store.js";
import { getSoundService } from "../../services/getSoundService.js";
import type * as SoundServiceModule from "../../services/SoundService.js";

type SoundId = keyof typeof SoundServiceModule.SOUND_FILES;

function playSoundFireAndForget(id: SoundId): void {
  void getSoundService()
    .then((svc) => svc.play(id))
    .catch((err) => console.error("[git-write] sound play failed:", err));
}
import { preAgentSnapshotService } from "../../services/PreAgentSnapshotService.js";
import type { SnapshotInfo, SnapshotRevertResult } from "../../../shared/types/ipc/git.js";
import { classifyGitError } from "../../../shared/utils/gitOperationErrors.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { GitOperationError } from "../../utils/errorTypes.js";

const execFileAsync = promisify(execFile);

interface StagingFileEntry {
  path: string;
  status: GitStatus;
  insertions: number | null;
  deletions: number | null;
}

const CONFLICT_LABELS: Record<string, string> = {
  UU: "both modified",
  AA: "both added",
  DD: "both deleted",
  AU: "added by us",
  UA: "added by them",
  DU: "deleted by us",
  UD: "deleted by them",
};

// Cap text scans at 1 MB per staged file — above this, assume the file is
// effectively machine-generated and skip. Matches the cap already used in
// projectInRepoSettings.ts:81 for in-process file reads.
const STAGED_FILE_SIZE_CAP = 1_000_000;

// Line-anchored 7-char conflict markers (standard + diff3 ancestor). The
// `<<<<<<<` and `>>>>>>>` anchors are definitive; `=======` and `|||||||` are
// flagged as well to match VS Code's own marker detection. No `g` flag so
// `.test()` stays stateless across sequential calls on different blobs.
const CONFLICT_MARKER_RE = /^(?:<{7}|\|{7}|={7}|>{7})[ \t\r]?/m;

async function pathExists(p: string): Promise<boolean> {
  return fs.promises
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function readTextOrNull(p: string): Promise<string | null> {
  return fs.promises.readFile(p, "utf8").catch(() => null);
}

async function resolveGitDir(git: SimpleGit, cwd: string): Promise<string> {
  const raw = (await git.revparse(["--git-dir"])).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

interface RepoOperationState {
  state: RepoState;
  rebaseStep: number | null;
  rebaseTotalSteps: number | null;
}

async function detectRepoOperationState(
  gitDir: string,
  hasUnmerged: boolean
): Promise<RepoOperationState> {
  const [hasMergeHead, hasRebaseMerge, hasRebaseApply, hasCherryPickHead, hasRevertHead] =
    await Promise.all([
      pathExists(path.join(gitDir, "MERGE_HEAD")),
      pathExists(path.join(gitDir, "rebase-merge")),
      pathExists(path.join(gitDir, "rebase-apply")),
      pathExists(path.join(gitDir, "CHERRY_PICK_HEAD")),
      pathExists(path.join(gitDir, "REVERT_HEAD")),
    ]);

  // REBASING takes precedence: during rebase conflict, MERGE_HEAD may also appear.
  if (hasRebaseMerge || hasRebaseApply) {
    const { step, total } = await readRebaseProgress(gitDir, hasRebaseMerge ? "merge" : "apply");
    return { state: "REBASING", rebaseStep: step, rebaseTotalSteps: total };
  }
  if (hasCherryPickHead) {
    return { state: "CHERRY_PICKING", rebaseStep: null, rebaseTotalSteps: null };
  }
  if (hasRevertHead) {
    return { state: "REVERTING", rebaseStep: null, rebaseTotalSteps: null };
  }
  if (hasMergeHead) {
    return { state: "MERGING", rebaseStep: null, rebaseTotalSteps: null };
  }
  return {
    state: hasUnmerged ? "DIRTY" : "CLEAN",
    rebaseStep: null,
    rebaseTotalSteps: null,
  };
}

async function readRebaseProgress(
  gitDir: string,
  backend: "merge" | "apply"
): Promise<{ step: number | null; total: number | null }> {
  const dir = path.join(gitDir, backend === "merge" ? "rebase-merge" : "rebase-apply");
  const [stepRaw, totalRaw] = await Promise.all([
    readTextOrNull(path.join(dir, backend === "merge" ? "msgnum" : "next")),
    readTextOrNull(path.join(dir, backend === "merge" ? "end" : "last")),
  ]);
  const toInt = (raw: string | null): number | null => {
    if (raw == null) return null;
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  };
  return { step: toInt(stepRaw), total: toInt(totalRaw) };
}

/**
 * Parse `u` lines from `git status --porcelain=v2` (no `-z`) into conflict
 * entries. Each u-line has the form:
 *   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
 */
export function parsePorcelainV2Conflicts(raw: string): ConflictedFileEntry[] {
  const entries: ConflictedFileEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("u ")) continue;
    // Ten whitespace-separated fields before the path; the path itself may
    // contain spaces, so split with a small limit and rejoin the tail.
    const parts = line.split(" ");
    if (parts.length < 11) continue;
    const xy = parts[1] ?? "";
    const filePath = parts.slice(10).join(" ");
    if (!filePath) continue;
    entries.push({
      path: filePath,
      xy,
      label: CONFLICT_LABELS[xy] ?? xy,
    });
  }
  return entries;
}

/**
 * Parse `git diff --cached --numstat` output into the set of staged paths that
 * git reports as binary (added/deleted counts rendered as `-`). Binary blobs
 * are skipped by the conflict-marker scan because regex matching on non-text
 * bytes is meaningless and may produce false positives.
 */
function parseBinaryPathsFromNumstat(raw: string): Set<string> {
  const binary = new Set<string>();
  for (const line of raw.split("\n")) {
    // Numstat format: "<added>\t<deleted>\t<path>". Binary → "-\t-\t<path>".
    // Rename diffs may emit "{old => new}" in the path column; we key the set
    // on whatever text appears after the second tab and compare using `has`
    // on the post-rename path reported by status(), so renamed binary files
    // may miss this set. That's tolerated: a binary will still fail the
    // marker regex harmlessly on the subsequent `git.show`.
    const tabIdx1 = line.indexOf("\t");
    if (tabIdx1 === -1) continue;
    const tabIdx2 = line.indexOf("\t", tabIdx1 + 1);
    if (tabIdx2 === -1) continue;
    if (line.slice(0, tabIdx2) !== "-\t-") continue;
    const filePath = line.slice(tabIdx2 + 1);
    if (filePath) binary.add(filePath);
  }
  return binary;
}

/**
 * Block commits that would include unresolved merge conflict markers. Reads
 * the staged (index) blob for each non-binary, non-deleted file via
 * `git show :<path>`, which works on both normal and unborn branches. Throws
 * a descriptive `Error` naming the first offending file; the IPC layer
 * surfaces `.message` directly to the UI.
 */
export async function scanStagedFilesForConflictMarkers(git: SimpleGit): Promise<void> {
  const status = await git.status();
  const candidates: string[] = [];
  for (const file of status.files) {
    const indexStatus = file.index;
    if (!indexStatus || indexStatus === " " || indexStatus === "?" || indexStatus === "D") {
      continue;
    }
    candidates.push(file.path);
  }
  if (candidates.length === 0) return;

  // `--no-ext-diff` is mandatory: without it, a user-configured `diff.external`
  // tool can break the numstat call (lesson #4221). Matches the pattern in
  // handleGetWorkingDiff and utils/git.ts.
  const numstatRaw = await git.diff(["--no-ext-diff", "--cached", "--numstat"]);
  const binaryPaths = parseBinaryPathsFromNumstat(numstatRaw);

  for (const filePath of candidates) {
    if (binaryPaths.has(filePath)) continue;
    const content = await git.show([`:${filePath}`]);
    if (typeof content !== "string") continue;
    // Compare against the UTF-8 byte length so a multibyte file isn't
    // misclassified against a character-count cap.
    if (Buffer.byteLength(content, "utf8") > STAGED_FILE_SIZE_CAP) continue;
    // A leading UTF-8 BOM pushes a first-line `<<<<<<<` past the `^` anchor;
    // strip it before testing so marker-on-line-1 files still block.
    const probe = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    if (CONFLICT_MARKER_RE.test(probe)) {
      throw new Error(
        `Unresolved conflict markers found in ${filePath}. Resolve all conflicts before committing.`
      );
    }
  }
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

  const handlePush = async (payload: { cwd: string; setUpstream?: boolean }): Promise<void> => {
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
          const msg = formatErrorMessage(pushErr, "git push failed");
          if (msg.includes("no upstream branch") || msg.includes("has no upstream")) {
            await git.push(["--set-upstream", "origin", branchName]);
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
      const gitReason = classifyGitError(error);
      throw new GitOperationError(gitReason, errorMessage, {
        cwd: payload.cwd,
        op: "push",
        cause: error instanceof Error ? error : undefined,
      });
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

    let conflictedFiles: ConflictedFileEntry[] = [];
    if (conflicted.length > 0) {
      try {
        const porcelain = await git.raw(["status", "--porcelain=v2"]);
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
    try {
      const gitDir = await resolveGitDir(git, cwd);
      const detected = await detectRepoOperationState(gitDir, conflicted.length > 0);
      repoState = detected.state;
      rebaseStep = detected.rebaseStep;
      rebaseTotalSteps = detected.rebaseTotalSteps;
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
    };
  };
  handlers.push(typedHandle(CHANNELS.GIT_GET_STAGING_STATUS, handleGetStagingStatus));

  const withNonInteractiveEnv = (git: SimpleGit): SimpleGit =>
    git.env({
      ...process.env,
      LC_MESSAGES: "C",
      LANGUAGE: "",
      GIT_EDITOR: "true",
      GIT_MERGE_AUTOEDIT: "no",
      GIT_TERMINAL_PROMPT: "0",
    });

  const handleAbortRepositoryOperation = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION, 5, 10_000);
    validateCwd(cwd);

    const git = createHardenedGit(cwd);
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

    const git = withNonInteractiveEnv(createHardenedGit(cwd));
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
    // Git compares safe.directory against the canonical repo path. If the
    // user opened a symlinked repo, writing the link path would leave the
    // error unresolved. realpath() reconciles the two; if it fails (e.g., the
    // path no longer exists), fall back to the resolved path so the user
    // still gets a deterministic write.
    const resolved = path.resolve(repoPath);
    let canonical: string;
    try {
      canonical = await realpath(resolved);
    } catch {
      canonical = resolved;
    }
    // Git for Windows (MSYS2) expects forward-slash Win32 paths like
    // `C:/Users/foo/repo`. Backslashes or POSIX-prefixed `/c/...` paths can be
    // misinterpreted relative to the Git installation root.
    const normalized = canonical.replace(/\\/g, "/");
    await execFileAsync("git", ["config", "--global", "--add", "safe.directory", normalized], {
      env: { ...process.env, LC_ALL: "C" },
    });
  };
  handlers.push(typedHandle(CHANNELS.GIT_MARK_SAFE_DIRECTORY, handleMarkSafeDirectory));

  return () => handlers.forEach((cleanup) => cleanup());
}
