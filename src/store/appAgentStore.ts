import { create } from "zustand";
import type { AppAgentConfig } from "@shared/types";

interface AppAgentState {
  hasApiKey: boolean;
  config: Omit<AppAgentConfig, "apiKey"> | null;
  enabled: boolean;
  isInitialized: boolean;
  error: string | null;
}

interface AppAgentActions {
  initialize: () => Promise<void>;
  setApiKey: (apiKey: string) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  clearError: () => void;
}

type AppAgentStore = AppAgentState & AppAgentActions;

let initPromise: Promise<void> | null = null;

export const useAppAgentStore = create<AppAgentStore>()((set, get) => ({
  hasApiKey: false,
  config: null,
  enabled: true,
  isInitialized: false,
  error: null,

  initialize: () => {
    if (get().isInitialized) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        const [hasApiKey, config] = await Promise.all([
          window.electron.appAgent.hasApiKey(),
          window.electron.appAgent.getConfig(),
        ]);
        set({ hasApiKey, config, enabled: config.enabled !== false, isInitialized: true });
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : "Failed to initialize app agent",
          isInitialized: true,
        });
      }
    })();

    return initPromise;
  },

  setApiKey: async (apiKey: string) => {
    try {
      const config = await window.electron.appAgent.setConfig({ apiKey });
      const hasApiKey = await window.electron.appAgent.hasApiKey();
      set({ config, hasApiKey, enabled: config.enabled !== false, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to set API key" });
      throw e;
    }
  },

  setModel: async (model: string) => {
    try {
      const config = await window.electron.appAgent.setConfig({ model });
      set({ config, enabled: config.enabled !== false, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to set model" });
      throw e;
    }
  },

  setEnabled: async (enabled: boolean) => {
    try {
      const config = await window.electron.appAgent.setConfig({ enabled });
      set({ config, enabled, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to update enabled state" });
      throw e;
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));

export function cleanupAppAgentStore() {
  initPromise = null;
  useAppAgentStore.setState({
    hasApiKey: false,
    config: null,
    enabled: true,
    isInitialized: false,
    error: null,
  });
}
