import type { ConversionRecord } from "./catalog.js";
import { currentProjectId, type PluginContext } from "./context.js";

/**
 * Deletes each session's index files, then forgets the sessions whose files
 * are gone. A session whose files couldn't be removed stays listed, so it can
 * be deleted again rather than lingering on disk unseen. A search racing the
 * delete answers that session as missing rather than failing.
 */
export async function deleteConversions(
  ctx: PluginContext,
  records: readonly ConversionRecord[]
): Promise<{ failed: number }> {
  const results = await Promise.allSettled(records.map((record) => ctx.store.delete(record.id)));
  const deleted = records.filter((_, index) => results[index]?.status === "fulfilled");
  if (deleted.length > 0) await ctx.catalog.remove(deleted.map((record) => record.id));
  return { failed: records.length - deleted.length };
}

/**
 * Converted sessions are deleted with their project. The plugin isn't told
 * when a project is removed (presence reports a removal as a close), so it
 * compares the catalog against the registered projects when it next looks.
 *
 * The listing comes from whatever host the project in front lives on, so it
 * is only trusted when it describes this machine: `anchorProjectId` must be a
 * project this plugin converted a session of (only a local pane's session
 * file can be located), it must still be the one in front, and the listing
 * must name it. A listing that fails, comes back empty or is missing the
 * anchor deletes nothing.
 */
export async function pruneRemovedProjects(
  ctx: PluginContext,
  anchorProjectId: string
): Promise<void> {
  const records = await ctx.catalog.list();
  if (!records.some((record) => record.projectId === anchorProjectId)) return;
  const listed = await ctx.host.dispatch("project.getAll");
  if (!listed.ok) return;
  const projects = (listed.result as { projects?: unknown }).projects;
  if (!Array.isArray(projects) || projects.length === 0) return;
  const ids = new Set<string>();
  for (const project of projects) {
    const id = (project as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return;
    ids.add(id);
  }
  if (!ids.has(anchorProjectId)) return;
  if ((await currentProjectId(ctx.host)) !== anchorProjectId) return;
  const orphans = records.filter((record) => !ids.has(record.projectId));
  if (orphans.length > 0) await deleteConversions(ctx, orphans);
}
