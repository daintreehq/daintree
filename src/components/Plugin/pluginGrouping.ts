import { resolvePluginCategory } from "@shared/config/pluginCategoryRegistry";
import type { LoadedPluginInfo, PluginCategoryId } from "@shared/types/plugin";

/**
 * Bucket plugins by effective category, preserving the incoming (alphabetical)
 * order within each bucket. Disabled plugins stay in their category — state is
 * conveyed in place (dimmed row, badge, toggle), never by relocation, so a
 * toggle doesn't teleport the row and break spatial memory.
 */
export function groupPluginsByCategory(
  plugins: readonly LoadedPluginInfo[]
): Map<PluginCategoryId, LoadedPluginInfo[]> {
  const buckets = new Map<PluginCategoryId, LoadedPluginInfo[]>();
  for (const plugin of plugins) {
    const category = resolvePluginCategory(plugin.manifest);
    const bucket = buckets.get(category);
    if (bucket) bucket.push(plugin);
    else buckets.set(category, [plugin]);
  }
  return buckets;
}
