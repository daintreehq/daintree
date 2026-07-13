import type { Project } from "../types/index.js";

/**
 * Which project the startup window's initial view is ACTUALLY displaying by the
 * time ProjectViewManager gets to bind it.
 *
 * Usually the restored project. But IPC handlers go live well before the
 * ProjectViewManager reaches them, so a `project:switch` arriving in that gap
 * takes the legacy (non-PVM) path and moves this very renderer to a different
 * project. Binding the stale restore id would then make every later switch from
 * this view persist its layout under the restored project — the corruption
 * #11101 exists to prevent, reintroduced through the back door.
 *
 * The global pointer is trustworthy here specifically because this runs during
 * the boot of the first window: one window, one renderer, so "the current
 * project" and "what this renderer shows" cannot yet have diverged.
 */
export function resolveInitialViewProject(
  restoreProject: Project,
  currentProjectId: string | null,
  getProjectById: (id: string) => Project | null | undefined
): Project {
  if (!currentProjectId || currentProjectId === restoreProject.id) return restoreProject;
  return getProjectById(currentProjectId) ?? restoreProject;
}
