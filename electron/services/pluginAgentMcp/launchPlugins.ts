import {
  pluginManifestIdFromInstanceKey,
  type LoadedPluginInfo,
} from "../../../shared/types/plugin.js";
import type {
  RequiredPluginToolStatus,
  RequiredPluginToolsState,
} from "../../../shared/types/ipc/pluginAgentMcp.js";
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
 * What a launch's plugin resolution saw, for a launch that requires some of
 * them: every plugin declaring agent tools here with the scope this launch may
 * have (null when access is off), and whether the waits for plugins to load
 * finished before the launch stopped waiting.
 */
export interface LaunchPluginsReport {
  readonly plugins: LaunchPlugin[];
  readonly declared: ReadonlyArray<{
    readonly plugin: DeclaredAgentMcpPlugin;
    readonly scope: AgentMcpToolScope | null;
  }>;
  /** The plugin service or this project's plugins hadn't settled when the waits ran out. */
  readonly pending: boolean;
  /** No plugin has agent access in this project, so none was looked up. */
  readonly noAccess?: true;
}

const EMPTY_REPORT: LaunchPluginsReport = { plugins: [], declared: [], pending: false };
const NO_ACCESS_REPORT: LaunchPluginsReport = { ...EMPTY_REPORT, noAccess: true };

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
  return (await resolveLaunchPluginsReport(projectId, projectRoot, consumer, getPluginService))
    .plugins;
}

/** {@link resolveLaunchPlugins}, with what a launch that requires plugin tools needs to explain a refusal. */
export async function resolveLaunchPluginsReport(
  projectId: string,
  projectRoot: string,
  consumer?: "assistant",
  getPluginService: () => Promise<PluginServiceSingleton> = loadPluginService
): Promise<LaunchPluginsReport> {
  if (!isProjectWorkspaceId(projectId)) return EMPTY_REPORT;
  if (consumer === "assistant" && !hasAnyAssistantAgentMcpAccess(projectId)) {
    return NO_ACCESS_REPORT;
  }
  await refreshProjectAgentMcpDefaults(projectId, projectRoot);
  if (!hasAnyAgentMcpEnablement(projectId)) return NO_ACCESS_REPORT;
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
    return { plugins: [], declared: [], pending: true };
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
  const scoped: Array<{ plugin: DeclaredAgentMcpPlugin; scope: AgentMcpToolScope | null }> = [];
  for (const plugin of declared) {
    const scope = scopeFor(projectId, plugin);
    scoped.push({ plugin, scope });
    const serverKey = keys.get(plugin.pluginInstanceId);
    const record = recordsById.get(plugin.pluginInstanceId);
    if (scope !== null && serverKey !== undefined && record !== undefined) {
      plugins.push({ plugin, record, scope, serverKey });
    }
  }
  return { plugins, declared: scoped, pending: !projectPluginsReady };
}

/**
 * Where each plugin a launch requires stands before anything is prepared: one
 * this launch would hand over reads `ready` here and is confirmed against its
 * live grant afterwards. Anything else names why it is missing — off here,
 * still loading, or loaded and not offering tools. A required plugin still
 * loading is `pending-load` even when other plugins have settled, since it may
 * be the one that hasn't.
 */
export function classifyRequiredPluginTools(
  report: LaunchPluginsReport,
  required: readonly string[]
): RequiredPluginToolStatus[] {
  const handed = new Set(report.plugins.map(({ plugin }) => plugin.pluginInstanceId));
  const declared = new Map(report.declared.map((entry) => [entry.plugin.pluginInstanceId, entry]));
  return [...new Set(required)].map((pluginInstanceId) => {
    const entry = declared.get(pluginInstanceId);
    const pluginDisplayName =
      entry?.plugin.pluginDisplayName.trim() || pluginManifestIdFromInstanceKey(pluginInstanceId);
    const state: RequiredPluginToolsState = handed.has(pluginInstanceId)
      ? "ready"
      : report.noAccess === true || entry?.scope === null
        ? "disabled-access"
        : report.pending
          ? "pending-load"
          : "unavailable";
    return { pluginInstanceId, pluginDisplayName, state };
  });
}
