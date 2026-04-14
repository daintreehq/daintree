import { create } from "zustand";
import type { AgentSettings, AgentSettingsEntry } from "@shared/types";
import { agentSettingsClient } from "@/clients";
import { DEFAULT_AGENT_SETTINGS } from "@shared/types";
import { getEffectiveAgentIds } from "../../shared/config/agentRegistry";

/**
 * In-memory normalization: seeds `pinned: false` for any registered agent
 * that has no stored entry. Does NOT persist — persistent migration is
 * handled by migration-012 in the main process.
 */
export function normalizeAgentSelection(settings: AgentSettings): AgentSettings {
  const registeredIds = getEffectiveAgentIds();
  let changed = false;
  const agents = { ...settings.agents };

  for (const id of registeredIds) {
    const entry = agents[id];
    if (!entry) continue;

    if (entry.pinned === undefined) {
      agents[id] = { ...entry, pinned: false };
      changed = true;
    }
  }

  return changed ? { ...settings, agents } : settings;
}

interface AgentSettingsState {
  settings: AgentSettings | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface AgentSettingsActions {
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  updateAgent: (agentId: string, updates: Partial<AgentSettingsEntry>) => Promise<void>;
  setAgentPinned: (agentId: string, pinned: boolean) => Promise<void>;
  reset: (agentId?: string) => Promise<void>;
}

type AgentSettingsStore = AgentSettingsState & AgentSettingsActions;

let initPromise: Promise<void> | null = null;

export const useAgentSettingsStore = create<AgentSettingsStore>()((set, get) => ({
  settings: null,
  isLoading: true,
  error: null,
  isInitialized: false,

  initialize: () => {
    if (get().isInitialized) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        set({ isLoading: true, error: null });

        const raw = (await agentSettingsClient.get()) ?? DEFAULT_AGENT_SETTINGS;
        const settings = normalizeAgentSelection(raw);
        set({ settings, isLoading: false, isInitialized: true });
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : "Failed to load agent settings",
          isLoading: false,
          isInitialized: true,
        });
      }
    })();

    return initPromise;
  },

  refresh: async () => {
    set({ error: null });
    try {
      const raw = (await agentSettingsClient.get()) ?? DEFAULT_AGENT_SETTINGS;
      const settings = normalizeAgentSelection(raw);
      set({ settings });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to refresh agent settings" });
      throw e;
    }
  },

  updateAgent: async (agentId: string, updates: Partial<AgentSettingsEntry>) => {
    set({ error: null });
    try {
      const raw = await agentSettingsClient.set(agentId, updates);
      const settings = normalizeAgentSelection(raw);
      set({ settings });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : `Failed to update ${agentId} settings` });
      throw e;
    }
  },

  setAgentPinned: async (agentId: string, pinned: boolean) => {
    return get().updateAgent(agentId, { pinned });
  },

  reset: async (agentId?: string) => {
    set({ error: null });
    try {
      const raw = await agentSettingsClient.reset(agentId);
      const settings = normalizeAgentSelection(raw);
      set({ settings });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to reset agent settings" });
      throw e;
    }
  },
}));

export function getPinnedAgents(): string[] {
  const settings = useAgentSettingsStore.getState().settings;
  if (!settings?.agents) return [];
  return Object.entries(settings.agents)
    .filter(([, entry]) => entry.pinned === true)
    .map(([id]) => id);
}

export function cleanupAgentSettingsStore() {
  initPromise = null;
  useAgentSettingsStore.setState({
    settings: DEFAULT_AGENT_SETTINGS,
    isLoading: true,
    error: null,
    isInitialized: false,
  });
}
