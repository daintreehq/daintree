import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { checkRateLimit } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type { GitStatus } from "../../../shared/types/domain.js";

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

function validateCwd(cwd: unknown): asserts cwd is string {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("Invalid working directory");
  }
}

export function registerGitWriteHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleStageFile = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { cwd: string; filePath: string }
  ): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_FILE, 30, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.filePath !== "string" || !payload.filePath) {
      throw new Error("Invalid file path");
    }

    const { simpleGit } = await import("simple-git");
    const git = simpleGit(payload.cwd);
    await git.add(["--", payload.filePath]);
  };
  ipcMain.handle(CHANNELS.GIT_STAGE_FILE, handleStageFile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_STAGE_FILE));

  const handleUnstageFile = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { cwd: string; filePath: string }
  ): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_FILE, 30, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.filePath !== "string" || !payload.filePath) {
      throw new Error("Invalid file path");
    }

    const { simpleGit } = await import("simple-git");
    const git = simpleGit(payload.cwd);

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
  ipcMain.handle(CHANNELS.GIT_UNSTAGE_FILE, handleUnstageFile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_UNSTAGE_FILE));

  const handleStageAll = async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: string
  ): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_ALL, 10, 10_000);
    validateCwd(cwd);

    const { simpleGit } = await import("simple-git");
    const git = simpleGit(cwd);
    await git.add("-A");
  };
  ipcMain.handle(CHANNELS.GIT_STAGE_ALL, handleStageAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_STAGE_ALL));

  const handleUnstageAll = async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: string
  ): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_ALL, 10, 10_000);
    validateCwd(cwd);

    const { simpleGit } = await import("simple-git");
    const git = simpleGit(cwd);

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
  ipcMain.handle(CHANNELS.GIT_UNSTAGE_ALL, handleUnstageAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_UNSTAGE_ALL));

  const handleCommit = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { cwd: string; message: string }
  ): Promise<{ hash: string; summary: string }> => {
    checkRateLimit(CHANNELS.GIT_COMMIT, 5, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.message !== "string" || !payload.message.trim()) {
      throw new Error("Commit message is required");
    }

    const { simpleGit } = await import("simple-git");
    const git = simpleGit(payload.cwd);
    const result = await git.commit(payload.message.trim());
    return {
      hash: result.commit || "",
      summary: `${result.summary.changes} changed, ${result.summary.insertions} insertions(+), ${result.summary.deletions} deletions(-)`,
    };
  };
  ipcMain.handle(CHANNELS.GIT_COMMIT, handleCommit);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_COMMIT));

  const handlePush = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { cwd: string; setUpstream?: boolean }
  ): Promise<{ success: boolean; error?: string }> => {
    checkRateLimit(CHANNELS.GIT_PUSH, 5, 10_000);
    validateCwd(payload?.cwd);

    const { simpleGit } = await import("simple-git");
    const git = simpleGit(payload.cwd);

    try {
      const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
      const branchName = branch.trim();

      if (payload.setUpstream) {
        await git.push(["--set-upstream", "origin", branchName]);
      } else {
        try {
          await git.push();
        } catch (pushErr) {
          const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
          if (msg.includes("no upstream branch") || msg.includes("has no upstream")) {
            await git.push(["--set-upstream", "origin", branchName]);
          } else {
            throw pushErr;
          }
        }
      }
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  };
  ipcMain.handle(CHANNELS.GIT_PUSH, handlePush);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_PUSH));

  const handleGetUsername = async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: string
  ): Promise<string | null> => {
    checkRateLimit(CHANNELS.GIT_GET_USERNAME, 20, 10_000);
    validateCwd(cwd);
    const { simpleGit } = await import("simple-git");
    const git = simpleGit(cwd);
    try {
      const { value } = await git.getConfig("user.name");
      return value || null;
    } catch {
      return null;
    }
  };
  ipcMain.handle(CHANNELS.GIT_GET_USERNAME, handleGetUsername);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_GET_USERNAME));

  const handleGetStagingStatus = async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: string
  ): Promise<StagingStatus> => {
    checkRateLimit(CHANNELS.GIT_GET_STAGING_STATUS, 20, 10_000);
    validateCwd(cwd);

    const { simpleGit } = await import("simple-git");
    const git = simpleGit(cwd);
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
  ipcMain.handle(CHANNELS.GIT_GET_STAGING_STATUS, handleGetStagingStatus);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_GET_STAGING_STATUS));

  const DIFF_LINE_LIMIT = 500;

  const handleGetWorkingDiff = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { cwd: string; type: "unstaged" | "staged" | "head" }
  ): Promise<string> => {
    checkRateLimit(CHANNELS.GIT_GET_WORKING_DIFF, 20, 10_000);
    validateCwd(payload?.cwd);
    const diffType = payload?.type;
    if (diffType !== "unstaged" && diffType !== "staged" && diffType !== "head") {
      throw new Error("Invalid diff type: must be 'unstaged', 'staged', or 'head'");
    }

    const { simpleGit } = await import("simple-git");
    const git = simpleGit(payload.cwd);

    let raw: string;
    switch (diffType) {
      case "unstaged":
        raw = await git.diff();
        break;
      case "staged":
        raw = await git.diff(["--cached"]);
        break;
      case "head":
        raw = await git.diff(["HEAD"]);
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
  ipcMain.handle(CHANNELS.GIT_GET_WORKING_DIFF, handleGetWorkingDiff);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_GET_WORKING_DIFF));

  return () => handlers.forEach((cleanup) => cleanup());
}
