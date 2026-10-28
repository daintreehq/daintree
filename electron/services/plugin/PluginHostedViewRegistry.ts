import type { PluginHostedViewDescriptor } from "../../../shared/types/plugin.js";

/**
 * Main-process registry of plugin views that mount outside the panel grid
 * (#13770): every `contributes.views` entry whose location is not `"panel"`.
 *
 * Deliberately not the panel kind registry. A kind there is something the
 * launcher, palette and dock can spawn, and hiding one behind flags is a
 * read-side filter every write path has to remember; a view that is never
 * registered as a kind cannot be spawned by any of them. Renderers learn these
 * through their own scoped snapshot (`plugin:hosted-views-changed`), filtered
 * by the same project visibility rule as every other contribution.
 *
 * Replaced wholesale per plugin instance, so a reload's new module URLs can't
 * sit beside the old ones.
 */

const viewsByPlugin = new Map<string, PluginHostedViewDescriptor[]>();

/** Register a plugin's hosted views, replacing any it registered before. */
export function registerPluginHostedViews(
  pluginId: string,
  views: readonly PluginHostedViewDescriptor[]
): void {
  // Dropped first so a reload re-enters in load order, as a fresh load does.
  viewsByPlugin.delete(pluginId);
  if (views.length === 0) return;
  viewsByPlugin.set(
    pluginId,
    views.map((view) => ({ ...view }))
  );
}

/** Drop every hosted view registered by `pluginId`. Returns whether it had any. */
export function unregisterPluginHostedViews(pluginId: string): boolean {
  return viewsByPlugin.delete(pluginId);
}

/** Reset the registry (test isolation / full plugin-system teardown). */
export function clearPluginHostedViewRegistry(): void {
  viewsByPlugin.clear();
}

/** Every registered hosted view, in plugin load order. Fresh copies: the array crosses IPC. */
export function getPluginHostedViews(): PluginHostedViewDescriptor[] {
  return [...viewsByPlugin.values()].flat().map((view) => ({ ...view }));
}
