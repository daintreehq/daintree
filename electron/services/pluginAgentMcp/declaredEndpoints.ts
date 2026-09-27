import type { LoadedPluginInfo } from "../../../shared/types/plugin.js";
import { pluginManifestIdFromInstanceKey } from "../../../shared/types/plugin.js";
import type { DeclaredAgentMcpPlugin } from "./types.js";

/**
 * The plugins that could serve agent tools to one project: running installed
 * plugins, and project plugins loaded for that project. A project plugin loaded
 * for another project never qualifies — its instance is bound to that other
 * project's root.
 *
 * `listPlugins()` also reports skipped and blocklisted plugins, so whether an
 * instance is actually running comes from `isLoaded` (`PluginService.hasPlugin`)
 * rather than from any field on the row.
 *
 * A plugin that declares `contributes.databases` offers the host's read-only
 * database tools. The host serves those, not the plugin, so they need no
 * `mcp:expose`; the plugin's own `agentMcp` endpoint does. Either way nothing
 * reaches an agent until the user gives the plugin access in the project.
 *
 * Pure over `PluginService.listPlugins()` output so the launch path, the route
 * and the settings UI all answer "what can this project expose" identically.
 */
export function listDeclaredAgentMcpPlugins(
  plugins: readonly LoadedPluginInfo[],
  projectId: string,
  isLoaded: (pluginInstanceId: string) => boolean
): DeclaredAgentMcpPlugin[] {
  const declared: DeclaredAgentMcpPlugin[] = [];
  for (const plugin of plugins) {
    if (plugin.disabled || plugin.blocklisted) continue;
    if (plugin.origin === "project" && plugin.projectId !== projectId) continue;
    if (!isLoaded(plugin.instanceId)) continue;
    const { manifest } = plugin;
    const endpoint = manifest.capabilities?.includes("mcp:expose")
      ? manifest.contributes.agentMcp?.[0]
      : undefined;
    const hasDatabases = (manifest.contributes.databases ?? []).length > 0;
    if (!endpoint && !hasDatabases) continue;
    declared.push({
      pluginInstanceId: plugin.instanceId,
      pluginManifestId: pluginManifestIdFromInstanceKey(plugin.instanceId),
      pluginDisplayName: manifest.displayName ?? manifest.name,
      origin: plugin.origin,
      ...(manifest.mcpName !== undefined ? { mcpName: manifest.mcpName } : {}),
      hasDatabases,
      ...(endpoint
        ? {
            pluginEndpoint: {
              id: endpoint.id,
              name: endpoint.name,
              ...(endpoint.description !== undefined ? { description: endpoint.description } : {}),
            },
          }
        : {}),
    });
  }
  return declared;
}
