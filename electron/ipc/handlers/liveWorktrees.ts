import { projectStore } from "../../services/ProjectStore.js";
import { getWorkspaceClientRef } from "../../window/serviceRefs.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";

/**
 * Past the workspace client's 150 ms reuse of a finished read, so a second read
 * is taken after the prune was asked for and sees any worktree made before it.
 */
export const GONE_RECHECK_DELAY_MS = 200;

/**
 * The project's worktrees as its workspace host has them right now, or `null`
 * when it can't say (project closed, host not ready, a scratch with no project).
 */
export async function readLiveWorktrees(
  projectId: string,
  scope: string
): Promise<WorktreeSnapshot[] | null> {
  const project = projectStore.getProjectById(projectId);
  const client = getWorkspaceClientRef();
  if (!project || !client) return null;
  try {
    const result = await client.getAllStatesForProjectResultAsync(project.path, projectId);
    return result.status === "ok" ? result.states : null;
  } catch (error) {
    console.error(`[${scope}] Failed to list worktrees for project ${projectId}:`, error);
    return null;
  }
}

/**
 * The candidates the workspace host confirms are gone, by two reads: the first
 * may be one the client reused from just before a sibling made the worktree,
 * and what's dropped on the strength of this is gone for good, so only an id
 * both reads miss counts. None when the host can't answer or `signal` aborts.
 */
export async function confirmGoneWorktrees(
  projectId: string,
  candidates: readonly string[],
  scope: string,
  signal?: AbortSignal
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const first = await readLiveWorktrees(projectId, scope);
  if (first === null || signal?.aborted) return [];
  const firstIds = new Set(first.map((state) => state.id));
  const gone = candidates.filter((id) => !firstIds.has(id));
  if (gone.length === 0) return [];
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, GONE_RECHECK_DELAY_MS);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
  if (signal?.aborted) return [];
  const second = await readLiveWorktrees(projectId, scope);
  if (second === null || signal?.aborted) return [];
  const secondIds = new Set(second.map((state) => state.id));
  return gone.filter((id) => !secondIds.has(id));
}
