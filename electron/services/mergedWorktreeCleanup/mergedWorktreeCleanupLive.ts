import { lstat } from "node:fs/promises";
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
import type { MergedWorktreeReads } from "./evaluateMergedWorktrees.js";
import {
  MergedWorktreeCleanupService,
  type MergedWorktreeProject,
} from "./MergedWorktreeCleanupService.js";

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readsFor(project: MergedWorktreeProject, signal: AbortSignal): MergedWorktreeReads {
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
      const records = await readPtyTerminalProcesses(getPtyClient());
      const census = await terminalsInWorktree(records, worktreePath, HOST_MATCH_OPTIONS);
      return { count: census.terminals.length, complete: census.complete };
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
        getFreshPR: (prNumber) => impl.getPR(repoRef, prNumber, { fresh: true }),
      };
    },
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
    readsFor,
    removeWorktree: async (project, worktreeId, guard) => {
      const client = getWorkspaceClientRef();
      if (!client) throw new Error("The workspace client isn't running");
      await client.removeMergedWorktree(project.path, project.id, worktreeId, guard);
    },
    loadReceipts: () => {
      const stored = store.get("mergedWorktreeRemovalReceipts");
      return Array.isArray(stored) ? stored : [];
    },
    saveReceipts: (receipts) => store.set("mergedWorktreeRemovalReceipts", receipts),
    announceReceipts: () => broadcastToRenderer(CHANNELS.MERGED_WORKTREE_CLEANUP_RECEIPTS_READY),
    logInfo: (message, context) => logInfo(message, context),
    logWarn: (message, context) => logWarn(message, context),
  });
  return service;
}

/** Shutdown only: stops the sweep if one was ever made, without making one. */
export async function disposeMergedWorktreeCleanupService(): Promise<void> {
  await service?.dispose();
}
