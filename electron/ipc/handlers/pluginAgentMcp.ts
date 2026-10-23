import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { PLUGIN_AGENT_MCP_METHOD_CHANNELS } from "./pluginAgentMcp.preload.js";
import {
  declaresDatabaseWrites,
  isSharedAcrossProjects,
  listDeclaredAgentMcpPlugins,
} from "../../services/pluginAgentMcp/declaredEndpoints.js";
import {
  listRelaunchNeeded,
  type EligiblePluginTools,
} from "../../services/pluginAgentMcp/agentLaunchRecords.js";
import {
  agentMcpScopeFor,
  allProjectsAgentMcpAccess,
  assistantAgentMcpAccess,
  hasLegacyAgentMcpAnswer,
  isAgentMcpEndpointEnabled,
  isAgentMcpEndpointEnabledByDefault,
  listAgentMcpAccessInstances,
  listAssistantAgentMcpAccessInstances,
  listLegacyAgentMcpEndpointIds,
  projectAgentMcpAccessAnswer,
  refreshProjectAgentMcpDefaults,
  setAllProjectsAgentMcpAccess,
  setProjectAgentMcpAccess,
  setProjectAssistantAgentMcpAccess,
} from "../../services/pluginAgentMcp/projectEnablement.js";
import { projectDefaultForEndpoint } from "../../services/pluginAgentMcp/projectDefaults.js";
import { projectStore } from "../../services/ProjectStore.js";
import type * as PluginServiceModule from "../../services/PluginService.js";
import type * as McpServerServiceModule from "../../services/McpServerService.js";
import {
  DATABASE_ENDPOINT_ID,
  DATABASE_WRITES_ACCESS_ID,
  type DeclaredAgentMcpPlugin,
} from "../../services/pluginAgentMcp/types.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import {
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
  type LoadedPluginInfo,
} from "../../../shared/types/plugin.js";
import {
  AGENT_MCP_ACCESS_LEVELS,
  type AgentMcpAccess,
  type AgentMcpAccessSource,
  type ProjectAgentToolPlugin,
  type ProjectAgentToolsSnapshot,
} from "../../../shared/types/ipc/pluginAgentMcp.js";

type PluginServiceSingleton = typeof PluginServiceModule.pluginService;
type McpServerSingleton = typeof McpServerServiceModule.mcpServerService;

// Lazy, like plugin.ts and mcpServer.ts: both services are heavy and deferred
// off the eager startup path.
let cachedPluginService: PluginServiceSingleton | null = null;
async function getPluginService(): Promise<PluginServiceSingleton> {
  if (!cachedPluginService) {
    cachedPluginService = (await import("../../services/PluginService.js")).pluginService;
  }
  return cachedPluginService;
}

let cachedMcpServerService: McpServerSingleton | null = null;
async function getMcpServerService(): Promise<McpServerSingleton> {
  if (!cachedMcpServerService) {
    cachedMcpServerService = (await import("../../services/McpServerService.js")).mcpServerService;
  }
  return cachedMcpServerService;
}

const SetPluginAccessSchema = z.union([
  z.object({
    pluginInstanceId: z.string().min(1).max(512),
    access: z.enum(AGENT_MCP_ACCESS_LEVELS).nullable(),
    scope: z.enum(["project", "all-projects"]),
  }),
  z.object({
    pluginInstanceId: z.string().min(1).max(512),
    access: z.enum(AGENT_MCP_ACCESS_LEVELS),
    scope: z.literal("assistant"),
  }),
]);

const ACCESS_RANK: Record<AgentMcpAccess, number> = { off: 0, "read-only": 1, "read-write": 2 };

function senderProjectId(ctx: IpcContext): string | null {
  return ctx.projectId !== null && isProjectWorkspaceId(ctx.projectId) ? ctx.projectId : null;
}

/** The manifest schema allows an empty display name; a consent row must still name something. */
function displayName(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function declaredFor(svc: PluginServiceSingleton, projectId: string) {
  return listDeclaredAgentMcpPlugins(svc.listPlugins(), projectId, (id) => svc.hasPlugin(id));
}

/**
 * Rosters a plugin that is not running here can have: its manifest's while the
 * host still knows it, else whatever an answer on record names.
 */
function surfaceOf(
  projectId: string,
  pluginInstanceId: string,
  manifest: LoadedPluginInfo["manifest"] | undefined
): Pick<DeclaredAgentMcpPlugin, "hasDatabases" | "hasDatabaseWrites" | "pluginEndpoint"> {
  if (!manifest) {
    const ownId = listLegacyAgentMcpEndpointIds(projectId, pluginInstanceId).find(
      (endpointId) => endpointId !== DATABASE_ENDPOINT_ID
    );
    return {
      hasDatabases: true,
      ...(ownId !== undefined ? { pluginEndpoint: { id: ownId, name: ownId } } : {}),
    };
  }
  const endpoint = manifest.contributes.agentMcp?.[0];
  return {
    hasDatabases: (manifest.contributes.databases ?? []).length > 0,
    ...(declaresDatabaseWrites(manifest) ? { hasDatabaseWrites: true as const } : {}),
    ...(endpoint
      ? {
          pluginEndpoint: {
            id: endpoint.id,
            name: endpoint.name,
            ...(endpoint.description !== undefined ? { description: endpoint.description } : {}),
          },
        }
      : {}),
  };
}

/** The level that describes which of a plugin's rosters are on, its declared writes counting as its own tools do. */
function levelOf(databases: boolean, own: boolean, writes = false): AgentMcpAccess {
  return own || writes ? "read-write" : databases ? "read-only" : "off";
}

function row(
  projectId: string,
  plugin: Pick<
    DeclaredAgentMcpPlugin,
    | "pluginInstanceId"
    | "pluginDisplayName"
    | "hasDatabases"
    | "hasDatabaseWrites"
    | "pluginEndpoint"
  >,
  available: boolean
): ProjectAgentToolPlugin {
  const id = plugin.pluginInstanceId;
  const installed = projectIdFromPluginInstanceKey(id) === null;
  const endpointId = plugin.pluginEndpoint?.id;
  const databases =
    plugin.hasDatabases && isAgentMcpEndpointEnabled(projectId, id, DATABASE_ENDPOINT_ID);
  const own = endpointId !== undefined && isAgentMcpEndpointEnabled(projectId, id, endpointId);
  const writes =
    databases &&
    plugin.hasDatabaseWrites === true &&
    isAgentMcpEndpointEnabled(projectId, id, DATABASE_WRITES_ACCESS_ID);

  const answer = projectAgentMcpAccessAnswer(projectId, id);
  const allProjects = installed ? allProjectsAgentMcpAccess(id) : null;
  const repoDatabases = projectDefaultForEndpoint(projectId, id, DATABASE_ENDPOINT_ID);
  const repoOwn =
    endpointId !== undefined ? projectDefaultForEndpoint(projectId, id, endpointId) : null;
  const repoWrites =
    plugin.hasDatabaseWrites === true &&
    repoDatabases === true &&
    projectDefaultForEndpoint(projectId, id, DATABASE_WRITES_ACCESS_ID) === true;
  const repositoryNamesPlugin = repoDatabases !== null || repoOwn !== null;
  const source: AgentMcpAccessSource =
    (answer !== undefined && answer !== null) || hasLegacyAgentMcpAnswer(projectId, id)
      ? "project"
      : allProjects !== null
        ? "all-projects"
        : repositoryNamesPlugin
          ? "repository"
          : "default";

  return {
    pluginInstanceId: id,
    pluginDisplayName: plugin.pluginDisplayName,
    origin: installed ? "installed" : "project",
    hasDatabases: plugin.hasDatabases,
    ...(plugin.hasDatabaseWrites === true ? { hasDatabaseWrites: true as const } : {}),
    ...(isSharedAcrossProjects(id, plugin.hasDatabases)
      ? { sharedAcrossProjects: true as const }
      : {}),
    ...(plugin.pluginEndpoint
      ? {
          pluginTools: {
            name: displayName(plugin.pluginEndpoint.name, plugin.pluginEndpoint.id),
            ...(plugin.pluginEndpoint.description !== undefined
              ? { description: plugin.pluginEndpoint.description }
              : {}),
          },
        }
      : {}),
    access: levelOf(databases, own, writes),
    source,
    assistantAccess: assistantAgentMcpAccess(projectId, id),
    ...(installed ? { allProjectsAccess: allProjects ?? "off" } : {}),
    ...(!installed && repositoryNamesPlugin
      ? {
          repositoryAccess: levelOf(
            plugin.hasDatabases && repoDatabases === true,
            repoOwn === true,
            repoWrites
          ),
        }
      : {}),
    ...(own && plugin.hasDatabases && !databases ? { databasesWithheld: true } : {}),
    ...(own && databases && plugin.hasDatabaseWrites === true && !writes
      ? { writesWithheld: true as const }
      : {}),
    available,
  };
}

/** Stands in for the own endpoint of a plugin whose manifest is gone; any id but `@databases`. */
const UNNAMED_OWN_ENDPOINT = "tools";

/**
 * The access still on record for a plugin that is not running here, read from
 * the answers rather than from rosters it may no longer declare, so a row never
 * shows less than would apply if the plugin came back.
 */
function retainedAccess(
  projectId: string,
  pluginInstanceId: string,
  manifest: LoadedPluginInfo["manifest"] | undefined
): AgentMcpAccess {
  const answer = projectAgentMcpAccessAnswer(projectId, pluginInstanceId);
  if (answer !== undefined && answer !== null) return answer;
  if (answer === undefined && hasLegacyAgentMcpAnswer(projectId, pluginInstanceId)) {
    // Each roster the old answer names follows it; any it does not name falls
    // through to the default, exactly as the route would decide. The endpoint
    // the manifest declares now is the one that would be asked about.
    const declaredId = manifest?.contributes.agentMcp?.[0]?.id;
    const ownIds =
      declaredId !== undefined
        ? [declaredId]
        : listLegacyAgentMcpEndpointIds(projectId, pluginInstanceId).filter(
            (endpointId) => endpointId !== DATABASE_ENDPOINT_ID
          );
    const own =
      ownIds.length > 0
        ? ownIds.some((endpointId) =>
            isAgentMcpEndpointEnabled(projectId, pluginInstanceId, endpointId)
          )
        : isAgentMcpEndpointEnabledByDefault(projectId, pluginInstanceId, UNNAMED_OWN_ENDPOINT);
    const databases = isAgentMcpEndpointEnabled(projectId, pluginInstanceId, DATABASE_ENDPOINT_ID);
    // A plugin whose manifest is gone may come back declaring writes.
    const writes =
      databases &&
      (manifest === undefined || declaresDatabaseWrites(manifest)) &&
      isAgentMcpEndpointEnabled(projectId, pluginInstanceId, DATABASE_WRITES_ACCESS_ID);
    return levelOf(databases, own, writes);
  }
  return allProjectsAgentMcpAccess(pluginInstanceId) ?? "off";
}

async function buildSnapshot(projectId: string | null): Promise<ProjectAgentToolsSnapshot> {
  const mcpServerEnabled = (await getMcpServerService()).isEnabled();
  if (projectId === null) return { plugins: [], mcpServerEnabled, relaunchNeeded: [] };

  const svc = await getPluginService();
  // A read before the deferred initialize() would see no plugins at all.
  await svc.waitForInit();

  const plugins = svc.listPlugins();
  await refreshProjectAgentMcpDefaults(projectId, projectStore.getProjectById(projectId)?.path);

  const declared = listDeclaredAgentMcpPlugins(plugins, projectId, (id) => svc.hasPlugin(id));
  const rows = declared.map((d) =>
    row(
      projectId,
      { ...d, pluginDisplayName: displayName(d.pluginDisplayName, d.pluginManifestId) },
      true
    )
  );

  // Consent outlives the plugin being loaded, so access left on for a plugin
  // that has since been disabled or uninstalled would silently apply again the
  // moment it comes back. Listing it keeps that answer visible and revocable.
  const retained = new Set([
    ...listAgentMcpAccessInstances(projectId),
    ...listAssistantAgentMcpAccessInstances(projectId),
  ]);
  for (const id of retained) {
    if (declared.some((d) => d.pluginInstanceId === id)) continue;
    const manifest = plugins.find((p) => p.instanceId === id)?.manifest;
    const orphan = row(
      projectId,
      {
        pluginInstanceId: id,
        pluginDisplayName: displayName(
          manifest?.displayName,
          manifest?.name,
          pluginManifestIdFromInstanceKey(id)
        ),
        ...surfaceOf(projectId, id, manifest),
      },
      false
    );
    const { databasesWithheld: _withheld, writesWithheld: _writesWithheld, ...rest } = orphan;
    rows.push({ ...rest, access: retainedAccess(projectId, id, manifest) });
  }

  // What a launch would be handed now, against what each running agent holds.
  // With the listener off a relaunch gets nothing either, so none is asked for.
  const eligible: EligiblePluginTools[] = [];
  if (mcpServerEnabled) {
    for (const d of declared) {
      const scope = agentMcpScopeFor(projectId, d);
      if (scope === null) continue;
      eligible.push({
        pluginInstanceId: d.pluginInstanceId,
        pluginDisplayName: displayName(d.pluginDisplayName, d.pluginManifestId),
        scope,
      });
    }
  }
  const relaunchNeeded = mcpServerEnabled ? listRelaunchNeeded(projectId, eligible) : [];

  return { plugins: rows, mcpServerEnabled, relaunchNeeded };
}

/** Whether a level means something for what the plugin offers. */
function isMeaningful(plugin: DeclaredAgentMcpPlugin, access: AgentMcpAccess): boolean {
  if (access === "read-only") return plugin.hasDatabases;
  if (access === "read-write") {
    return plugin.pluginEndpoint !== undefined || plugin.hasDatabaseWrites === true;
  }
  return true;
}

/**
 * Record how much of a plugin's tools the project's Daintree Assistant may use.
 * Less than it has now is always accepted, so an answer for a plugin that went
 * away, or that the agents lost, can be lowered or cleared. More needs the
 * plugin running here, and never goes past
 * what this project's agents have: the Assistant's answer is a share of theirs.
 * Read only is accepted for a plugin with no database tools, where it reaches
 * nothing until read and write is chosen as well.
 */
async function setAssistantAccess(
  projectId: string,
  pluginInstanceId: string,
  access: AgentMcpAccess
): Promise<void> {
  // Taking access away is always accepted, whatever became of the plugin or
  // the agents' access since it was given.
  if (ACCESS_RANK[access] <= ACCESS_RANK[assistantAgentMcpAccess(projectId, pluginInstanceId)]) {
    setProjectAssistantAgentMcpAccess(projectId, pluginInstanceId, access);
    return;
  }
  const svc = await getPluginService();
  await svc.waitForInit();
  await refreshProjectAgentMcpDefaults(projectId, projectStore.getProjectById(projectId)?.path);
  // Checked and written with no await between, as the project answer is.
  const plugin = declaredFor(svc, projectId).find((d) => d.pluginInstanceId === pluginInstanceId);
  if (!plugin) {
    throw new Error("agent tools: no running plugin offers tools in this project");
  }
  if (access === "read-write" && !isMeaningful(plugin, access)) {
    throw new Error(`agent tools: that plugin has nothing for "${access}" to allow`);
  }
  const projectAccess = row(projectId, plugin, true).access;
  if (ACCESS_RANK[access] > ACCESS_RANK[projectAccess]) {
    throw new Error(
      "agent tools: the Daintree Assistant can't have more access than this project's agents"
    );
  }
  setProjectAssistantAgentMcpAccess(projectId, pluginInstanceId, access);
}

/**
 * How much of each plugin's agent tools this project's agents may use (the
 * access `projectEnablement.ts` stores), and an installed plugin's access for
 * every project.
 *
 * The project always comes from the sender's own view binding, never from an
 * argument — the rule every project-plugin op follows — so a renderer can only
 * read or change the project it is showing.
 *
 * Deliberately IPC only, not an `ActionService` action: the action manifest is
 * the MCP tool surface, and an agent must never be able to grant itself a
 * plugin's tools. Reaching this needs the renderer, which needs the user.
 */
export const pluginAgentMcpNamespace = defineIpcNamespace({
  name: "pluginAgentMcp",
  ops: {
    listProjectPlugins: op(
      PLUGIN_AGENT_MCP_METHOD_CHANNELS.listProjectPlugins,
      (ctx: IpcContext): Promise<ProjectAgentToolsSnapshot> => buildSnapshot(senderProjectId(ctx)),
      { withContext: true }
    ),
    setPluginAccess: opValidated(
      PLUGIN_AGENT_MCP_METHOD_CHANNELS.setPluginAccess,
      SetPluginAccessSchema,
      async (ctx, payload): Promise<ProjectAgentToolsSnapshot> => {
        const projectId = senderProjectId(ctx);
        if (projectId === null) throw new Error("agent tools: sender has no project");
        if (payload.scope === "assistant") {
          await setAssistantAccess(projectId, payload.pluginInstanceId, payload.access);
          return buildSnapshot(projectId);
        }
        const { pluginInstanceId, access, scope } = payload;
        if (scope === "all-projects" && projectIdFromPluginInstanceKey(pluginInstanceId) !== null) {
          throw new Error("agent tools: only an installed plugin has a setting for every project");
        }
        const write = () => {
          if (scope === "project") {
            setProjectAgentMcpAccess(projectId, pluginInstanceId, access);
            return;
          }
          setAllProjectsAgentMcpAccess(pluginInstanceId, access);
          // Making a level the default from a project means this project
          // follows it too, rather than keeping its own answer and silently
          // parting ways the next time the default changes. Not over an answer
          // from before access levels: that one may keep database tools off,
          // and following the default would quietly turn them on.
          if (access !== null && !hasLegacyAgentMcpAnswer(projectId, pluginInstanceId)) {
            setProjectAgentMcpAccess(projectId, pluginInstanceId, null);
          }
        };

        if (access === null || access === "off") {
          // Always allowed — it is how a stale answer is cleared.
          write();
        } else {
          const svc = await getPluginService();
          await svc.waitForInit();
          // Checked and written with no await between, so a plugin unloading in
          // the gap can't leave consent for tools it never offered here.
          const plugin = declaredFor(svc, projectId).find(
            (d) => d.pluginInstanceId === pluginInstanceId
          );
          if (!plugin) {
            throw new Error("agent tools: no running plugin offers tools in this project");
          }
          if (!isMeaningful(plugin, access)) {
            throw new Error(`agent tools: that plugin has nothing for "${access}" to allow`);
          }
          write();
        }

        return buildSnapshot(projectId);
      },
      { withContext: true }
    ),
  },
});

export function registerPluginAgentMcpHandlers(): () => void {
  return pluginAgentMcpNamespace.register();
}
