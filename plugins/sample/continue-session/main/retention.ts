import type { ConversionRecord } from "./catalog.js";
import { currentProjectId, type PluginContext } from "./context.js";

export async function deleteConversions(
  ctx: PluginContext,
  records: readonly ConversionRecord[]
): Promise<void> {
  // The record goes first, so a search racing the delete finds nothing to open.
  await ctx.catalog.remove(records.map((record) => record.id));
  await Promise.all(records.map((record) => ctx.store.delete(record.id)));
}

/**
 * Converted sessions are deleted with their project. The plugin can't watch
 * a project being removed (presence reports a removal as a close), so it
 * compares against the registered projects when it next looks. A listing
 * that fails, comes back empty or doesn't include the project in front is
 * not trusted to mean anything was removed.
 */
export async function pruneRemovedProjects(ctx: PluginContext): Promise<void> {
  const { host } = ctx;
  const [listed, front] = await Promise.all([
    host.dispatch("project.getAll"),
    currentProjectId(host),
  ]);
  if (!listed.ok || !front) return;
  const projects = (listed.result as { projects?: unknown }).projects;
  if (!Array.isArray(projects) || projects.length === 0) return;
  const ids = new Set<string>();
  for (const project of projects) {
    const id = (project as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return;
    ids.add(id);
  }
  if (!ids.has(front)) return;
  const orphans = (await ctx.catalog.list()).filter((record) => !ids.has(record.projectId));
  if (orphans.length > 0) await deleteConversions(ctx, orphans);
}
