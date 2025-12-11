import { create } from "zustand";
import type { AgentSettings, AgentSettingsEntry } from "@shared/types";
import { agentSettingsClient } from "@/clients";
import { DEFAULT_AGENT_SETTINGS } from "@shared/types";

interface AgentSettingsState {
  settings: AgentSettings | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface AgentSettingsActions {
  initialize: () => Promise<void>;
  updateAgent: (agentId: string, updates: Partial<AgentSettingsEntry>) => Promise<void>;
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

        const settings = (await agentSettingsClient.get()) ?? DEFAULT_AGENT_SETTINGS;
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

  updateAgent: async (agentId: string, updates: Partial<AgentSettingsEntry>) => {
    set({ error: null });
    try {
      const settings = await agentSettingsClient.set(agentId, updates);
      set({ settings });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : `Failed to update ${agentId} settings` });
      throw e;
    }
  },

  reset: async (agentId?: string) => {
    set({ error: null });
    try {
      const settings = await agentSettingsClient.reset(agentId);
      set({ settings });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to reset agent settings" });
      throw e;
    }
  },
}));

export function cleanupAgentSettingsStore() {
  initPromise = null;
  useAgentSettingsStore.setState({
    settings: DEFAULT_AGENT_SETTINGS,
    isLoading: true,
    error: null,
    isInitialized: false,
  });
}
