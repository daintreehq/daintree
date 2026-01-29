import { create } from "zustand";
import type { AppAgentConfig } from "@shared/types";

interface AppAgentState {
  hasApiKey: boolean;
  config: Omit<AppAgentConfig, "apiKey"> | null;
  isInitialized: boolean;
  error: string | null;
}

interface AppAgentActions {
  initialize: () => Promise<void>;
  setApiKey: (apiKey: string) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  clearError: () => void;
}

type AppAgentStore = AppAgentState & AppAgentActions;

let initPromise: Promise<void> | null = null;

export const useAppAgentStore = create<AppAgentStore>()((set, get) => ({
  hasApiKey: false,
  config: null,
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
        set({ hasApiKey, config, isInitialized: true });
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
      set({ config, hasApiKey, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to set API key" });
      throw e;
    }
  },

  setModel: async (model: string) => {
    try {
      const config = await window.electron.appAgent.setConfig({ model });
      set({ config, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to set model" });
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
    isInitialized: false,
    error: null,
  });
}
