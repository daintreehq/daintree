import { defineIpcNamespace, op } from "../define.js";
import { PLUGIN_MCP_METHOD_CHANNELS } from "./pluginMcp.preload.js";
import { getPluginMcpSupervisor } from "../../services/PluginMcpSupervisor.js";
import { pluginService } from "../../services/PluginService.js";
import type {
  PluginMcpServerInfo,
  PluginMcpServerKey,
  PluginMcpStderrResult,
} from "../../../shared/types/ipc/pluginMcp.js";

async function handleList(): Promise<PluginMcpServerInfo[]> {
  return getPluginMcpSupervisor().list();
}

async function handleGetStderr(key: PluginMcpServerKey): Promise<PluginMcpStderrResult> {
  return getPluginMcpSupervisor().getStderr(key.pluginId, key.serverId);
}

/**
 * Re-spawn a specific supervised server, e.g. after the user rotates a secret
 * the manifest substitutes in via `${settings:*}`. Resolution of the new
 * settings value happens here at the handler boundary so the supervisor stays
 * decoupled from `PluginService`.
 */
async function handleRestart(key: PluginMcpServerKey): Promise<void> {
  const contribution = pluginService.findMcpServerContribution(key.pluginId, key.serverId);
  if (!contribution) return;
  await getPluginMcpSupervisor().restart({
    pluginId: key.pluginId,
    serverId: key.serverId,
    contribution,
    resolveSettings: (settingId) => pluginService.resolveSettingTemplate(key.pluginId, settingId),
  });
}

export const pluginMcpNamespace = defineIpcNamespace({
  name: "pluginMcp",
  ops: {
    list: op(PLUGIN_MCP_METHOD_CHANNELS.list, handleList),
    getStderr: op(PLUGIN_MCP_METHOD_CHANNELS.getStderr, handleGetStderr),
    restart: op(PLUGIN_MCP_METHOD_CHANNELS.restart, handleRestart),
  },
});

export function registerPluginMcpHandlers(): () => void {
  return pluginMcpNamespace.register();
}
