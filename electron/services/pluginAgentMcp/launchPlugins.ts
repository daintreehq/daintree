import type { LoadedPluginInfo } from "../../../shared/types/plugin.js";
import type * as PluginServiceModule from "../PluginService.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import { withTimeout } from "../../utils/withTimeout.js";
import { listDeclaredAgentMcpPlugins } from "./declaredEndpoints.js";
import {
  agentMcpScopeFor,
  assistantAgentMcpScopeFor,
  hasAnyAgentMcpEnablement,
  hasAnyAssistantAgentMcpAccess,
  refreshProjectAgentMcpDefaults,
} from "./projectEnablement.js";
import { pluginServerKeysFor } from "./serverKeys.js";
import type { AgentMcpToolScope, DeclaredAgentMcpPlugin } from "./types.js";

/** A running plugin an agent launch in the project may be handed, with what it may reach there. */
export interface LaunchPlugin {
  readonly plugin: DeclaredAgentMcpPlugin;
  readonly record: LoadedPluginInfo;
  readonly scope: AgentMcpToolScope;
  /** The MCP server name the agent sees the plugin's tools under. */
  readonly serverKey: string;
}

const PLUGIN_INIT_WAIT_MS = 5000;
const PROJECT_PLUGINS_WAIT_MS = 5000;

type PluginServiceSingleton = typeof PluginServiceModule.pluginService;

// PluginService pulls in the whole plugin host, so it is imported only once a
// launch turns out to need a plugin.
let pluginServiceModule: Promise<typeof PluginServiceModule> | null = null;
async function loadPluginService(): Promise<PluginServiceSingleton> {
  pluginServiceModule ??= import("../PluginService.js");
  return (await pluginServiceModule).pluginService;
}

/**
 * The plugins an agent launch in this project should be handed: one per plugin
 * instance that is running, may serve this project, and has agent access here
 * (the user's answer, else their answer for every project or the repository's
 * own `.daintree/mcp.json`). A Daintree Assistant launch gets those its own
 * answer allows as well, and nothing more. Access is read first because it is
 * a store read and one small file, and an empty answer — every project with no
 * plugin tools on — keeps the launch off the lazy PluginService load entirely.
 *
 * Shared by the terminal launch, which hands the tools over, and the Assistant
 * provision, which only describes plugins this would hand over.
 */
export async function resolveLaunchPlugins(
  projectId: string,
  projectRoot: string,
  consumer?: "assistant",
  getPluginService: () => Promise<PluginServiceSingleton> = loadPluginService
): Promise<LaunchPlugin[]> {
  if (!isProjectWorkspaceId(projectId)) return [];
  if (consumer === "assistant" && !hasAnyAssistantAgentMcpAccess(projectId)) return [];
  await refreshProjectAgentMcpDefaults(projectId, projectRoot);
  if (!hasAnyAgentMcpEnablement(projectId)) return [];
  const pluginService = await getPluginService();
  // PluginService initialises as a deferred task after first-interactive, so
  // panes restored at startup would otherwise see no loaded plugins. Bounded so
  // a slow init (blocklist fetch, activation) degrades to a launch without
  // plugin tools instead of a hung pane.
  try {
    await withTimeout(
      pluginService.waitForInit(),
      PLUGIN_INIT_WAIT_MS,
      "PluginService init did not settle"
    );
  } catch {
    console.warn(
      `[TerminalSpawn] Plugin service not ready after ${PLUGIN_INIT_WAIT_MS}ms; launching without plugin MCP servers`
    );
    return [];
  }
  // Project plugins load on their own fire-and-forget path from the project
  // switch, so a pane restored at startup can get here while its project's
  // plugins are still loading, or before they have started. A timeout still
  // launches, with whatever has loaded by then.
  let projectPluginsReady = false;
  try {
    projectPluginsReady = await pluginService.waitForProjectPlugins(
      projectId,
      PROJECT_PLUGINS_WAIT_MS
    );
  } catch (err) {
    console.warn("[TerminalSpawn] Waiting for project plugins failed:", err);
  }
  if (!projectPluginsReady) {
    console.warn(
      `[TerminalSpawn] Project plugins not settled after ${PROJECT_PLUGINS_WAIT_MS}ms; launching with the plugin MCP servers loaded so far`
    );
  }
  const records = pluginService.listPlugins();
  const recordsById = new Map(records.map((record) => [record.instanceId, record]));
  const declared = listDeclaredAgentMcpPlugins(records, projectId, (id) =>
    pluginService.hasPlugin(id)
  );
  // Named over every plugin that could serve here, not only those on, so a
  // plugin's name does not change when another is switched on or off.
  const keys = pluginServerKeysFor(declared);
  const scopeFor = consumer === "assistant" ? assistantAgentMcpScopeFor : agentMcpScopeFor;
  const plugins: LaunchPlugin[] = [];
  for (const plugin of declared) {
    const scope = scopeFor(projectId, plugin);
    const serverKey = keys.get(plugin.pluginInstanceId);
    const record = recordsById.get(plugin.pluginInstanceId);
    if (scope !== null && serverKey !== undefined && record !== undefined) {
      plugins.push({ plugin, record, scope, serverKey });
    }
  }
  return plugins;
}
