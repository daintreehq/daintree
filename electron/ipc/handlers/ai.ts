import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import { DEFAULT_AGENT_SETTINGS, type UserAgentConfig } from "../../../shared/types/index.js";
import { AgentHelpService } from "../../services/AgentHelpService.js";
import { UserAgentRegistryService } from "../../services/UserAgentRegistryService.js";
import type { AgentHelpRequest, AgentHelpResult } from "../../../shared/types/ipc/agent.js";
import { broadcastToRenderer, typedHandle } from "../utils.js";
import { createApplicationMenu } from "../../menu.js";

const RESERVED_AGENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface NormalizedAgentSettings {
  root: Record<string, unknown>;
  agents: Record<string, Record<string, unknown>>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateAgentType(agentType: unknown): string {
  if (typeof agentType !== "string") {
    throw new Error("Invalid agentType");
  }
  const trimmed = agentType.trim();
  if (!trimmed) {
    throw new Error("Invalid agentType");
  }
  if (RESERVED_AGENT_KEYS.has(trimmed)) {
    throw new Error(`Invalid agentType: reserved key "${trimmed}"`);
  }
  return trimmed;
}

function normalizeAgentSettings(value: unknown): NormalizedAgentSettings {
  const root = isPlainRecord(value) ? { ...(value as Record<string, unknown>) } : {};

  const agents: Record<string, Record<string, unknown>> = {};
  const rawAgents = root.agents;
  if (isPlainRecord(rawAgents)) {
    for (const [agentId, entry] of Object.entries(rawAgents as Record<string, unknown>)) {
      if (!agentId || RESERVED_AGENT_KEYS.has(agentId)) {
        continue;
      }
      if (isPlainRecord(entry)) {
        agents[agentId] = { ...(entry as Record<string, unknown>) };
      }
    }
  }

  return { root, agents };
}

export function registerAiHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];
  const agentHelpService = new AgentHelpService();
  const userAgentRegistryService = new UserAgentRegistryService();

  const handleAgentSettingsGet = async () => {
    return store.get("agentSettings");
  };
  handlers.push(typedHandle(CHANNELS.AGENT_SETTINGS_GET, handleAgentSettingsGet));

  const handleAgentSettingsSet = async (payload: {
    agentType: string;
    settings: Record<string, unknown>;
  }) => {
    if (!isPlainRecord(payload)) {
      throw new Error("Invalid payload");
    }
    const { agentType, settings } = payload;
    const safeAgentType = validateAgentType(agentType);
    if (!isPlainRecord(settings)) {
      throw new Error("Invalid settings object");
    }

    const currentSettings = normalizeAgentSettings(
      store.get("agentSettings", DEFAULT_AGENT_SETTINGS)
    );
    const merged = {
      ...(currentSettings.agents?.[safeAgentType] ?? {}),
      ...settings,
    };
    // Strip retired legacy keys — never persist them back
    const { selected: _s, enabled: _e, ...safeEntry } = merged as Record<string, unknown>;
    const updatedAgents = {
      ...currentSettings.agents,
      [safeAgentType]: safeEntry,
    };
    // Write the agents record at slice.field level rather than the whole slice,
    // so other agentSettings root defaults aren't baked into config.json. We can't
    // address per-agent leaves via dot-path because user-defined agent IDs may
    // contain dots, which dot-prop would interpret as nested keys.
    store.set("agentSettings.agents", updatedAgents);
    return {
      ...currentSettings.root,
      agents: updatedAgents,
    };
  };
  handlers.push(typedHandle(CHANNELS.AGENT_SETTINGS_SET, handleAgentSettingsSet));

  const handleAgentSettingsReset = async (agentType?: unknown) => {
    if (agentType !== undefined) {
      const safeAgentType = validateAgentType(agentType);
      const currentSettings = normalizeAgentSettings(
        store.get("agentSettings", DEFAULT_AGENT_SETTINGS)
      );
      const updatedAgents = {
        ...currentSettings.agents,
        [safeAgentType]: DEFAULT_AGENT_SETTINGS.agents[safeAgentType] ?? {},
      };
      store.set("agentSettings.agents", updatedAgents);
      return {
        ...currentSettings.root,
        agents: updatedAgents,
      };
    } else {
      // Full reset: replace the whole slice with defaults intentionally.
      store.set("agentSettings", DEFAULT_AGENT_SETTINGS);
      return DEFAULT_AGENT_SETTINGS;
    }
  };
  handlers.push(typedHandle(CHANNELS.AGENT_SETTINGS_RESET, handleAgentSettingsReset));

  const handleAgentHelpGet = async (request: AgentHelpRequest): Promise<AgentHelpResult> => {
    if (!request || typeof request !== "object") {
      throw new Error("Invalid request");
    }
    const { agentId, refresh = false } = request;
    if (typeof agentId !== "string" || !agentId) {
      throw new Error("Invalid agentId");
    }
    if (refresh !== undefined && typeof refresh !== "boolean") {
      throw new Error("Invalid refresh parameter");
    }
    return agentHelpService.getHelp(agentId, refresh);
  };
  handlers.push(typedHandle(CHANNELS.AGENT_HELP_GET, handleAgentHelpGet));

  const handleUserAgentRegistryGet = async () => {
    return userAgentRegistryService.getRegistry();
  };
  handlers.push(typedHandle(CHANNELS.USER_AGENT_REGISTRY_GET, handleUserAgentRegistryGet));

  const handleUserAgentRegistryAdd = async (config: UserAgentConfig) => {
    if (!config || typeof config !== "object") {
      throw new Error("Invalid config");
    }
    return userAgentRegistryService.addAgent(config);
  };
  handlers.push(
    // @ts-expect-error: handler returns {success: false, error} — pending migration to throw AppError. See #6020.
    typedHandle(CHANNELS.USER_AGENT_REGISTRY_ADD, handleUserAgentRegistryAdd)
  );

  const handleUserAgentRegistryUpdate = async (payload: {
    id: string;
    config: UserAgentConfig;
  }) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { id, config } = payload;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Invalid id");
    }
    if (!config || typeof config !== "object") {
      throw new Error("Invalid config");
    }
    return userAgentRegistryService.updateAgent(id, config);
  };
  handlers.push(
    // @ts-expect-error: handler returns {success: false, error} — pending migration to throw AppError. See #6020.
    typedHandle(CHANNELS.USER_AGENT_REGISTRY_UPDATE, handleUserAgentRegistryUpdate)
  );

  const handleUserAgentRegistryRemove = async (id: string) => {
    if (!id || typeof id !== "string") {
      throw new Error("Invalid id");
    }
    return userAgentRegistryService.removeAgent(id);
  };
  handlers.push(
    // @ts-expect-error: handler returns {success: false, error} — pending migration to throw AppError. See #6020.
    typedHandle(CHANNELS.USER_AGENT_REGISTRY_REMOVE, handleUserAgentRegistryRemove)
  );

  const handleReloadConfig = async () => {
    userAgentRegistryService.reload();

    if (deps.mainWindow && !deps.mainWindow.isDestroyed()) {
      createApplicationMenu(deps.mainWindow, deps.cliAvailabilityService);
    }

    if (deps.events) {
      deps.events.emit("sys:config:reload");
    }

    broadcastToRenderer(CHANNELS.APP_CONFIG_RELOADED);

    return { success: true };
  };
  handlers.push(
    // @ts-expect-error: handler returns {success: true} — pending migration to throw AppError on failure and return void on success. See #6020.
    typedHandle(CHANNELS.APP_RELOAD_CONFIG, handleReloadConfig)
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
