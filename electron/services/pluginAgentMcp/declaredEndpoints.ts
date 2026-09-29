import type { LoadedPluginInfo, PluginManifest } from "../../../shared/types/plugin.js";
import {
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "../../../shared/types/plugin.js";
import type { DeclaredAgentMcpPlugin } from "./types.js";

/**
 * Whether a plugin's database tools read data every project shares. Only an
 * installed plugin's do: its declared databases are all `"local"` (an installed
 * plugin can't declare a `"project"` one), and local files live in the data
 * directory of the plugin instance, which for an installed plugin is the same
 * in every project. The host's database tools can't filter rows by the calling
 * project because they don't know the plugin's data model, so giving them to
 * one project lets agents there read what the plugin stored for all the others.
 *
 * A project plugin's instance key names its project, so its local data is its
 * own. A plugin's own `agentMcp` tools can scope by `caller.projectId`, so they
 * never count.
 *
 * Keyed by instance id, the same key the data directory is, so a plugin that is
 * no longer loaded but still has access on record is classified like a live one.
 */
export function isSharedAcrossProjects(pluginInstanceId: string, hasDatabases: boolean): boolean {
  return hasDatabases && projectIdFromPluginInstanceKey(pluginInstanceId) === null;
}

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

/**
 * Everything a manifest declares that decides what an agent credential for it
 * can reach, and under which name: its capabilities and their scopes (a tool
 * reading through `host.fs` reaches exactly the declared paths), its `agentMcp`
 * endpoints, its databases, and its `mcpName` (a grant carries the server name
 * the agent was handed, which a renamed plugin would no longer answer to). Two
 * generations of a plugin with the same surface expose the same authority, so
 * a credential issued against one may keep working against the other; any
 * difference, including a reordering, reads as a change.
 */
export function agentMcpSurfaceOf(manifest: Readonly<PluginManifest>): string {
  return JSON.stringify({
    capabilities: [...(manifest.capabilities ?? [])].sort(),
    scopes: manifest.scopes ?? null,
    agentMcp: manifest.contributes.agentMcp ?? [],
    databases: manifest.contributes.databases ?? [],
    mcpName: manifest.mcpName ?? null,
  });
}
