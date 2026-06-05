// eager-import-allow: wires plugin-MCP method channels and supervisor initialization on startup
import { defineIpcNamespace, op } from "../define.js";
import { PLUGIN_MCP_METHOD_CHANNELS } from "./pluginMcp.preload.js";
import { getPluginMcpSupervisor } from "../../services/PluginMcpSupervisor.js";
import { pluginService } from "../../services/PluginService.js";
import { store } from "../../store.js";
import {
  PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION,
  PLUGIN_MCP_MAX_MAX_TOOLS_PER_SESSION,
  PLUGIN_MCP_MIN_MAX_TOOLS_PER_SESSION,
  type PluginMcpConfig,
  type PluginMcpGetFullSchemaResult,
  type PluginMcpListToolsResult,
  type PluginMcpServerInfo,
  type PluginMcpServerKey,
  type PluginMcpStderrResult,
  type PluginMcpToolKey,
} from "../../../shared/types/ipc/pluginMcp.js";

async function handleList(): Promise<PluginMcpServerInfo[]> {
  return getPluginMcpSupervisor().list();
}

async function handleGetStderr(key: PluginMcpServerKey): Promise<PluginMcpStderrResult> {
  return getPluginMcpSupervisor().getStderr(key.pluginId, key.serverId);
}

/**
 * Resolve the plugin's contribution and lazily spawn its MCP server (idempotent
 * — a no-op if already running), then return tier-1 tool summaries (#9235).
 * Spawning here, on first enumeration, is the lazy-discovery contract: plugin
 * activation no longer eagerly starts MCP subprocesses.
 */
async function handleListTools(key: PluginMcpServerKey): Promise<PluginMcpListToolsResult> {
  await ensureServerStarted(key);
  const cfg = store.get("pluginMcpConfig") as { maxToolsPerSession?: unknown } | undefined;
  return getPluginMcpSupervisor().listTools(
    key.pluginId,
    key.serverId,
    clampMaxTools(cfg?.maxToolsPerSession)
  );
}

/** Tier-2 lookup: the full input schema for a single agent-selected tool (#9235). */
async function handleGetFullSchema(key: PluginMcpToolKey): Promise<PluginMcpGetFullSchemaResult> {
  await ensureServerStarted(key);
  return getPluginMcpSupervisor().getFullSchema(key.pluginId, key.serverId, key.toolName);
}

/**
 * Look up the live contribution and (idempotently) start its supervised server.
 * Resolution happens at the handler boundary — same pattern as
 * {@link handleRestart} — so the supervisor stays decoupled from `PluginService`
 * and never holds a stale `resolveSettings` closure across a plugin reload.
 */
async function ensureServerStarted(key: PluginMcpServerKey): Promise<void> {
  const lookup = pluginService.findMcpServerContribution(key.pluginId, key.serverId);
  if (!lookup) {
    throw new Error(
      `Cannot enumerate tools for "${key.pluginId}/${key.serverId}": plugin or server is not registered`
    );
  }
  await getPluginMcpSupervisor().start({
    pluginId: key.pluginId,
    pluginDir: lookup.pluginDir,
    contributions: [lookup.contribution],
    resolveSettings: (settingId) => pluginService.resolveSettingTemplate(key.pluginId, settingId),
  });
}

/**
 * Re-spawn a specific supervised server, e.g. after the user rotates a secret
 * the manifest substitutes in via `${settings:*}`. Resolution of the new
 * settings value happens here at the handler boundary so the supervisor stays
 * decoupled from `PluginService`.
 */
async function handleRestart(key: PluginMcpServerKey): Promise<void> {
  const lookup = pluginService.findMcpServerContribution(key.pluginId, key.serverId);
  if (!lookup) {
    // A renderer race with plugin unload can land here. Throw so the caller
    // sees the failure rather than treating it as a silent no-op restart.
    throw new Error(
      `Cannot restart "${key.pluginId}/${key.serverId}": plugin or server is not registered`
    );
  }
  await getPluginMcpSupervisor().restart({
    pluginId: key.pluginId,
    pluginDir: lookup.pluginDir,
    serverId: key.serverId,
    contribution: lookup.contribution,
    resolveSettings: (settingId) => pluginService.resolveSettingTemplate(key.pluginId, settingId),
  });
}

/**
 * Read the advanced plugin-MCP config (#9235). Falls back to the default cap if
 * the persisted value is absent or out of range — the supervisor applies the
 * same clamp at enumeration time, so this only normalises what the UI shows.
 */
async function handleGetConfig(): Promise<PluginMcpConfig> {
  const cfg = store.get("pluginMcpConfig") as { maxToolsPerSession?: unknown } | undefined;
  return { maxToolsPerSession: clampMaxTools(cfg?.maxToolsPerSession) };
}

/** Persist the advanced plugin-MCP config, clamping the cap to a sane range. */
async function handleSetConfig(config: PluginMcpConfig): Promise<PluginMcpConfig> {
  const next: PluginMcpConfig = { maxToolsPerSession: clampMaxTools(config.maxToolsPerSession) };
  store.set("pluginMcpConfig", next);
  return next;
}

function clampMaxTools(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION;
  }
  const floored = Math.floor(value);
  if (floored < PLUGIN_MCP_MIN_MAX_TOOLS_PER_SESSION) return PLUGIN_MCP_MIN_MAX_TOOLS_PER_SESSION;
  if (floored > PLUGIN_MCP_MAX_MAX_TOOLS_PER_SESSION) return PLUGIN_MCP_MAX_MAX_TOOLS_PER_SESSION;
  return floored;
}

export const pluginMcpNamespace = defineIpcNamespace({
  name: "pluginMcp",
  ops: {
    list: op(PLUGIN_MCP_METHOD_CHANNELS.list, handleList),
    getStderr: op(PLUGIN_MCP_METHOD_CHANNELS.getStderr, handleGetStderr),
    restart: op(PLUGIN_MCP_METHOD_CHANNELS.restart, handleRestart),
    listTools: op(PLUGIN_MCP_METHOD_CHANNELS.listTools, handleListTools),
    getFullSchema: op(PLUGIN_MCP_METHOD_CHANNELS.getFullSchema, handleGetFullSchema),
    getConfig: op(PLUGIN_MCP_METHOD_CHANNELS.getConfig, handleGetConfig),
    setConfig: op(PLUGIN_MCP_METHOD_CHANNELS.setConfig, handleSetConfig),
  },
});

export function registerPluginMcpHandlers(): () => void {
  return pluginMcpNamespace.register();
}
