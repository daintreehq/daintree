import { getWorkspaceClientRef } from "../../window/serviceRefs.js";

/**
 * The current worktree of a project on this host, for a plugin call that
 * arrived with no window to key the lookup on (a view attached from another
 * machine). Read from the project's own workspace host, guarded by its id, so
 * it can never answer with another project's worktree. `null` on any failure:
 * a missing worktree degrades the context rather than failing the call.
 */
export async function resolveActiveWorktreeIdForProject(projectId: string): Promise<string | null> {
  const client = getWorkspaceClientRef();
  if (!client) return null;
  try {
    // Loaded on demand: the project store is heavy and most processes never
    // serve a call from another machine.
    const { projectStore } = await import("../ProjectStore.js");
    const projectPath = projectStore.getProjectById(projectId)?.path;
    if (!projectPath) return null;
    const snapshots = await client.getAllStatesForProjectAsync(projectPath, projectId);
    return snapshots.find((snapshot) => snapshot.isCurrent === true)?.id ?? null;
  } catch (error) {
    console.error("[PluginService] Failed to resolve the active worktree for a project:", error);
    return null;
  }
}
