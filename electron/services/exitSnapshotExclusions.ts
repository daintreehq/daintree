import { projectStore } from "./ProjectStore.js";

/**
 * Compute the full set of project ids opted out of exit-snapshot capture
 * (#10850). The pty-host gate is a full-set replacement, not deltas, so both the
 * startup push and the per-save diff-and-push recompute the whole set from every
 * project's persisted `exitSnapshotExcluded` flag. Best-effort per project — a
 * settings read that throws simply omits that project (treated as not excluded).
 */
export async function computeExitSnapshotExcludedProjectIds(): Promise<string[]> {
  const projects = projectStore.getAllProjects();
  const results = await Promise.all(
    projects.map(async (p) => {
      try {
        const settings = await projectStore.getProjectSettings(p.id);
        return settings.exitSnapshotExcluded === true ? p.id : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter((id): id is string => id !== null);
}
