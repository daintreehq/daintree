import type { LoadedPluginInfo } from "../../../shared/types/plugin.js";
import { pluginManifestIdFromInstanceKey } from "../../../shared/types/plugin.js";
import {
  DATABASE_ENDPOINT_DESCRIPTION,
  DATABASE_ENDPOINT_ID,
  DATABASE_ENDPOINT_NAME,
  type DeclaredAgentMcpEndpoint,
} from "./types.js";

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
 * A plugin that declares `contributes.databases` also offers the host's
 * read-only database endpoint. The host serves it, not the plugin, so it needs
 * no `mcp:expose`; like any other endpoint it stays off until the user turns
 * it on for the project.
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
    const identity = {
      pluginInstanceId: plugin.instanceId,
      pluginManifestId: pluginManifestIdFromInstanceKey(plugin.instanceId),
      pluginDisplayName: manifest.displayName ?? manifest.name,
    };
    if (manifest.capabilities?.includes("mcp:expose")) {
      for (const endpoint of manifest.contributes.agentMcp ?? []) {
        declared.push({
          ...identity,
          endpointId: endpoint.id,
          name: endpoint.name,
          ...(endpoint.description !== undefined ? { description: endpoint.description } : {}),
        });
      }
    }
    if ((manifest.contributes.databases ?? []).length > 0) {
      declared.push({
        ...identity,
        endpointId: DATABASE_ENDPOINT_ID,
        name: DATABASE_ENDPOINT_NAME,
        description: DATABASE_ENDPOINT_DESCRIPTION,
      });
    }
  }
  return declared;
}
