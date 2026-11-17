import { lstat } from "node:fs/promises";
import { webContents } from "electron";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { resolveForCwd } from "../../ipc/handlers/forgeResolution.js";
import { store } from "../../store.js";
import { logInfo, logWarn } from "../../utils/logger.js";
import { readWorktreeCreationStamp } from "../../utils/worktreeCreationStamp.js";
import { getPtyClient, getWorkspaceClientRef } from "../../window/serviceRefs.js";
import { gitServiceCache } from "../GitServiceCache.js";
import { projectStore } from "../ProjectStore.js";
import { runGitForBytes } from "../git/reviewPoint/runGit.js";
import {
  readWorktreeStatusObservation,
  WORKTREE_STATUS_READ_TIMEOUT_MS,
} from "../git/worktreeStatusObservation.js";
import {
  HOST_MATCH_OPTIONS,
  readPtyTerminalProcesses,
  terminalsInWorktree,
} from "../mcp-server/worktreeProcessGuard.js";
import type { HostRefusal, MergedWorktreeReads } from "./evaluateMergedWorktrees.js";
import {
  MergedWorktreeCleanupService,
  type MergedWorktreeProject,
} from "./MergedWorktreeCleanupService.js";

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    // A parent replaced by a file is as definite an absence as a missing one.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * The same refusals the host makes for an unattended removal, read from the
 * delete preview it already serves, for a host that is running: teardown it
 * would refuse to run, and submodules that need `--force` or hold work the
 * removal would discard. A submodule inventory that couldn't finish is a read
 * that failed, not a refusal.
 */
async function readHostRefusal(
  project: MergedWorktreeProject,
  worktreePath: string
): Promise<HostRefusal | null> {
  const preview = await getWorkspaceClientRef()?.getDeletePreview(
    project.path,
    project.id,
    worktreePath
  );
  if (!preview) return null;
  if (preview.teardown === "unreadable" || preview.risk === "unreadable") {
    throw new Error("The workspace host couldn't read what deleting it would do");
  }
  if (preview.teardown && preview.teardown.phases.length > 0) return "teardown";
  const risk = preview.risk;
  if (risk?.incomplete) throw new Error("The submodule inventory couldn't finish");
  if (
    risk &&
    (risk.requiresMechanicalForce ||
      risk.dirtyFiles.length > 0 ||
      risk.untrackedFiles.length > 0 ||
      risk.atRiskCommits.length > 0)
  ) {
    return "submodules";
  }
  return null;
}

/** The reads one evaluation pass makes for `project`. Exported for tests. */
export function createMergedWorktreeReads(
  project: MergedWorktreeProject,
  signal: AbortSignal,
  purpose: "sweep" | "preview"
): MergedWorktreeReads {
  // One census per pass, not one per worktree.
  let census: ReturnType<typeof readPtyTerminalProcesses> | null = null;
  return {
    pathExists,
    readGitDir: async (worktreePath) => {
      const { stdout } = await runGitForBytes(worktreePath, ["rev-parse", "--absolute-git-dir"], {
        signal,
        timeoutMs: WORKTREE_STATUS_READ_TIMEOUT_MS,
        maxStdoutBytes: 64 * 1024,
      });
      const gitDir = stdout.toString("utf8").replace(/\r?\n$/, "");
      if (!gitDir) throw new Error("git reported no git directory");
      return gitDir;
    },
    readStamp: readWorktreeCreationStamp,
    readStatus: (worktreePath) => readWorktreeStatusObservation(worktreePath, signal),
    countTerminals: async (worktreePath) => {
      census ??= readPtyTerminalProcesses(getPtyClient());
      const placed = await terminalsInWorktree(await census, worktreePath, HOST_MATCH_OPTIONS);
      return { count: placed.terminals.length, complete: placed.complete };
    },
    readSavedLayout: async () => {
      const state = await projectStore.getProjectState(project.id);
      // Checked after the read: a read that failed this session returns null,
      // which must not pass for a project with no panels.
      if (projectStore.wasStateUnreadableThisSession(project.id)) {
        throw new Error("The project's saved layout couldn't be read");
      }
      if (!state) return null;
      return {
        panels: Array.isArray(state.terminals) ? state.terminals : [],
        ...(state.activeWorktreeId ? { activeWorktreeId: state.activeWorktreeId } : {}),
      };
    },
    resolveForge: async () => {
      const { impl, repoRef } = await resolveForCwd(project.path);
      return {
        findPRByBranch: (branch) => impl.findPRByBranch(repoRef, branch),
        getPR: (prNumber) => impl.getPR(repoRef, prNumber, { fresh: purpose === "sweep" }),
      };
    },
    readHostRefusal: (worktreePath) => readHostRefusal(project, worktreePath),
    now: Date.now,
  };
}

let service: MergedWorktreeCleanupService | null = null;

export function getMergedWorktreeCleanupService(): MergedWorktreeCleanupService {
  service ??= new MergedWorktreeCleanupService({
    listProjects: () => projectStore.getAllProjectIdentities(),
    readSettings: (projectId) => projectStore.getProjectSettings(projectId),
    writeEnabled: (projectId, enabled) => projectStore.setRemoveMergedWorktrees(projectId, enabled),
    listWorktrees: async (projectPath) => {
      const git = gitServiceCache.getGitService(projectPath);
      if (!git) throw new Error("Not a git repository");
      return git.listWorktrees();
    },
    readsFor: createMergedWorktreeReads,
    removeWorktree: async (project, worktreeId, guard, confirm) => {
      const client = getWorkspaceClientRef();
      if (!client) throw new Error("The workspace client isn't running");
      return client.removeMergedWorktree(project.path, project.id, worktreeId, guard, confirm);
    },
    pathExists,
    loadReceipts: () => {
      const stored = store.get("mergedWorktreeRemovalReceipts");
      return Array.isArray(stored) ? stored : [];
    },
    saveReceipts: (receipts) => store.set("mergedWorktreeRemovalReceipts", receipts),
    announceReceipts: () => broadcastToRenderer(CHANNELS.MERGED_WORKTREE_CLEANUP_RECEIPTS_READY),
    isLiveView: (id) => {
      const contents = webContents.fromId(id);
      return contents !== undefined && !contents.isDestroyed();
    },
    logInfo: (message, context) => logInfo(message, context),
    logWarn: (message, context) => logWarn(message, context),
  });
  return service;
}

/** Shutdown only: stops the sweep if one was ever made, without making one. */
export async function disposeMergedWorktreeCleanupService(): Promise<void> {
  await service?.dispose();
}
