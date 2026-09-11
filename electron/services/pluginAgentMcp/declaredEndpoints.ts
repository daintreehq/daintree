import type { LoadedPluginInfo } from "../../../shared/types/plugin.js";
import { pluginManifestIdFromInstanceKey } from "../../../shared/types/plugin.js";
import type { DeclaredAgentMcpEndpoint } from "./types.js";

/**
 * The `agentMcp` endpoints the given plugins could serve to one project: those
 * of running installed plugins, and of project plugins loaded for that project.
 * A project plugin loaded for another project never qualifies — its instance is
 * bound to that other project's root.
 *
 * `listPlugins()` also reports skipped and blocklisted plugins, so whether an
 * instance is actually running comes from `isLoaded` (`PluginService.hasPlugin`)
 * rather than from any field on the row.
 *
 * Pure over `PluginService.listPlugins()` output so the launch path, the route
 * and the settings UI all answer "what can this project expose" identically.
 */
export function listDeclaredAgentMcpEndpoints(
  plugins: readonly LoadedPluginInfo[],
  projectId: string,
  isLoaded: (pluginInstanceId: string) => boolean
): DeclaredAgentMcpEndpoint[] {
  const declared: DeclaredAgentMcpEndpoint[] = [];
  for (const plugin of plugins) {
    if (plugin.disabled || plugin.blocklisted) continue;
    if (plugin.origin === "project" && plugin.projectId !== projectId) continue;
    if (!isLoaded(plugin.instanceId)) continue;
    const { manifest } = plugin;
    if (!manifest.capabilities?.includes("mcp:expose")) continue;
    const endpoints = manifest.contributes.agentMcp ?? [];
    for (const endpoint of endpoints) {
      declared.push({
        pluginInstanceId: plugin.instanceId,
        pluginManifestId: pluginManifestIdFromInstanceKey(plugin.instanceId),
        pluginDisplayName: manifest.displayName ?? manifest.name,
        endpointId: endpoint.id,
        name: endpoint.name,
        ...(endpoint.description !== undefined ? { description: endpoint.description } : {}),
      });
    }
  }
  return declared;
}
