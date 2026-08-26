/**
 * Which workspace a restored window binds to, resolved from the opaque id the
 * open-window manifest stored for it (#11958).
 *
 * A window can be restored onto a project or onto a scratch, and the boot needs
 * to tell them apart exactly once. Everything a *view* needs is identical for
 * both: the PTY's active workspace, and the ProjectViewManager registration
 * that makes `ctx.projectId` resolve for every IPC call that view ever sends.
 * Everything that needs a git repository is project-only — scratches are
 * non-git directories that deliberately never reach `WorktreeService`, so the
 * startup worktree load and the workspace-host prewarm must stay keyed on
 * {@link RestoreWorkspaceBinding.project} rather than the workspace.
 *
 * Split out of windowServices.ts, which a unit test cannot import (Electron
 * dependencies, module side effects). Keeping the decision here is what lets
 * the test exercise the real one rather than a copy that goes stale in silence.
 */

export interface RestoreWorkspace {
  id: string;
  path: string;
  kind: "project" | "scratch";
}

/** Just enough of each store to answer "does this id name a live workspace?". */
export interface RestoreWorkspaceLookups {
  getProjectById: (id: string) => { id: string; path: string } | null | undefined;
  /**
   * Answers null for anything that is not a live scratch — a tombstoned one, a
   * deleted one, and any id whose shape is not a scratch UUID.
   */
  getScratchById: (id: string) => { id: string; path: string } | null | undefined;
}

export interface RestoreWorkspaceBinding {
  /**
   * Set only when the id named a project row. The sole permitted input to the
   * startup worktree load and the workspace-host prewarm.
   */
  project: RestoreWorkspace | undefined;
  /** The project or the scratch — whichever this window's view binds to. */
  workspace: RestoreWorkspace | undefined;
}

const NOTHING_TO_RESTORE: RestoreWorkspaceBinding = { project: undefined, workspace: undefined };

export function resolveRestoreWorkspace(
  initialProjectId: string | undefined,
  lookups: RestoreWorkspaceLookups
): RestoreWorkspaceBinding {
  if (!initialProjectId) return NOTHING_TO_RESTORE;

  // Projects first: a project row is the only result that may unlock the
  // worktree path, so it has to be the answer whenever one exists.
  const project = lookups.getProjectById(initialProjectId);
  if (project) {
    const resolved: RestoreWorkspace = { id: project.id, path: project.path, kind: "project" };
    return { project: resolved, workspace: resolved };
  }

  // "No project row" is not the same claim as "deleted project": a scratch
  // never has one. Asking the scratch store second is what separates the two —
  // it validates the id shape itself, so a deleted project's 64-hex id still
  // resolves to nothing and its window is still dropped.
  const scratch = lookups.getScratchById(initialProjectId);
  if (scratch) {
    return {
      project: undefined,
      workspace: { id: scratch.id, path: scratch.path, kind: "scratch" },
    };
  }

  return NOTHING_TO_RESTORE;
}
