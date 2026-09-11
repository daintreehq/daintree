import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { PLUGIN_AGENT_MCP_METHOD_CHANNELS } from "./pluginAgentMcp.preload.js";
import { listDeclaredAgentMcpEndpoints } from "../../services/pluginAgentMcp/declaredEndpoints.js";
import {
  listEnabledAgentMcpEndpoints,
  setAgentMcpEndpointEnabled,
} from "../../services/pluginAgentMcp/projectEnablement.js";
import type * as PluginServiceModule from "../../services/PluginService.js";
import type * as McpServerServiceModule from "../../services/McpServerService.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import {
  pluginManifestIdFromInstanceKey,
  type LoadedPluginInfo,
} from "../../../shared/types/plugin.js";
import type {
  ProjectAgentToolEndpoint,
  ProjectAgentToolsSnapshot,
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

const SetEndpointEnabledSchema = z.object({
  pluginInstanceId: z.string().min(1).max(512),
  endpointId: z.string().min(1).max(128),
  enabled: z.boolean(),
});

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
  return listDeclaredAgentMcpEndpoints(svc.listPlugins(), projectId, (id) => svc.hasPlugin(id));
}

/**
 * An answer still on record for an endpoint no running plugin offers here any
 * more. Named from whatever `listPlugins()` still knows about the instance —
 * a disabled plugin keeps its manifest — and from the ids otherwise.
 */
function orphanRow(
  plugins: readonly LoadedPluginInfo[],
  pluginInstanceId: string,
  endpointId: string
): ProjectAgentToolEndpoint {
  const manifest = plugins.find((p) => p.instanceId === pluginInstanceId)?.manifest;
  const endpoint = manifest?.contributes.agentMcp?.find((e) => e.id === endpointId);
  return {
    pluginInstanceId,
    pluginDisplayName: displayName(
      manifest?.displayName,
      manifest?.name,
      pluginManifestIdFromInstanceKey(pluginInstanceId)
    ),
    endpointId,
    name: displayName(endpoint?.name, endpointId),
    ...(endpoint?.description !== undefined ? { description: endpoint.description } : {}),
    enabled: true,
    available: false,
  };
}

async function buildSnapshot(projectId: string | null): Promise<ProjectAgentToolsSnapshot> {
  const mcpServerEnabled = (await getMcpServerService()).isEnabled();
  if (projectId === null) return { endpoints: [], mcpServerEnabled };

  const svc = await getPluginService();
  // A read before the deferred initialize() would see no plugins at all.
  await svc.waitForInit();

  const plugins = svc.listPlugins();
  const enabled = listEnabledAgentMcpEndpoints(projectId);
  const isOn = (instanceId: string, endpointId: string) =>
    enabled.some((e) => e.pluginInstanceId === instanceId && e.endpointId === endpointId);

  const declared = listDeclaredAgentMcpEndpoints(plugins, projectId, (id) => svc.hasPlugin(id));
  const endpoints: ProjectAgentToolEndpoint[] = declared.map((d) => ({
    pluginInstanceId: d.pluginInstanceId,
    pluginDisplayName: displayName(d.pluginDisplayName, d.pluginManifestId),
    endpointId: d.endpointId,
    name: displayName(d.name, d.endpointId),
    ...(d.description !== undefined ? { description: d.description } : {}),
    enabled: isOn(d.pluginInstanceId, d.endpointId),
    available: true,
  }));

  // Consent outlives the plugin being loaded, so an answer left on by a plugin
  // that has since been disabled or uninstalled would silently apply again the
  // moment it comes back. Listing it keeps that answer visible and revocable.
  for (const e of enabled) {
    const offered = declared.some(
      (d) => d.pluginInstanceId === e.pluginInstanceId && d.endpointId === e.endpointId
    );
    if (!offered) endpoints.push(orphanRow(plugins, e.pluginInstanceId, e.endpointId));
  }

  return { endpoints, mcpServerEnabled };
}

/**
 * Which plugin agent tools this project's agents may use (the per-project
 * consent `projectEnablement.ts` stores).
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
    listProjectEndpoints: op(
      PLUGIN_AGENT_MCP_METHOD_CHANNELS.listProjectEndpoints,
      (ctx: IpcContext): Promise<ProjectAgentToolsSnapshot> => buildSnapshot(senderProjectId(ctx)),
      { withContext: true }
    ),
    setProjectEndpointEnabled: opValidated(
      PLUGIN_AGENT_MCP_METHOD_CHANNELS.setProjectEndpointEnabled,
      SetEndpointEnabledSchema,
      async (ctx, payload): Promise<ProjectAgentToolsSnapshot> => {
        const projectId = senderProjectId(ctx);
        if (projectId === null) throw new Error("agent tools: sender has no project");
        const { pluginInstanceId, endpointId, enabled } = payload;

        if (enabled) {
          const svc = await getPluginService();
          await svc.waitForInit();
          // Checked and written with no await between, so a plugin unloading in
          // the gap can't leave consent for an endpoint it never offered here.
          const offered = declaredFor(svc, projectId).some(
            (d) => d.pluginInstanceId === pluginInstanceId && d.endpointId === endpointId
          );
          if (!offered) {
            throw new Error("agent tools: no running plugin offers that endpoint in this project");
          }
          setAgentMcpEndpointEnabled(projectId, pluginInstanceId, endpointId, true);
        } else {
          // Turning off is always allowed — it is how a stale answer is cleared.
          setAgentMcpEndpointEnabled(projectId, pluginInstanceId, endpointId, false);
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
