import { create } from "zustand";
import type { UserAgentRegistry, UserAgentConfig } from "@shared/types";
import { userAgentRegistryClient } from "@/clients/userAgentRegistryClient";
import { setUserRegistry } from "../../shared/config/agentRegistry";

interface UserAgentRegistryState {
  registry: UserAgentRegistry | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface UserAgentRegistryActions {
  initialize: () => Promise<void>;
  addAgent: (config: UserAgentConfig) => Promise<{ success: boolean; error?: string }>;
  updateAgent: (
    id: string,
    config: UserAgentConfig
  ) => Promise<{ success: boolean; error?: string }>;
  removeAgent: (id: string) => Promise<{ success: boolean; error?: string }>;
  refresh: () => Promise<void>;
}

type UserAgentRegistryStore = UserAgentRegistryState & UserAgentRegistryActions;

let initPromise: Promise<void> | null = null;

export const useUserAgentRegistryStore = create<UserAgentRegistryStore>()((set, get) => ({
  registry: null,
  isLoading: true,
  error: null,
  isInitialized: false,

  initialize: () => {
    if (get().isInitialized) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        set({ isLoading: true, error: null });

        const registry = (await userAgentRegistryClient.get()) ?? {};
        setUserRegistry(registry);
        set({ registry, isLoading: false, isInitialized: true });
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : "Failed to load user agent registry",
          isLoading: false,
          isInitialized: true,
        });
      }
    })();

    return initPromise;
  },

  addAgent: async (config: UserAgentConfig) => {
    set({ error: null });
    try {
      const result = await userAgentRegistryClient.add(config);
      if (result.success) {
        const registry = await userAgentRegistryClient.get();
        setUserRegistry(registry);
        set({ registry });
      } else {
        set({ error: result.error });
      }
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : "Failed to add agent";
      set({ error });
      return { success: false, error };
    }
  },

  updateAgent: async (id: string, config: UserAgentConfig) => {
    set({ error: null });
    try {
      const result = await userAgentRegistryClient.update(id, config);
      if (result.success) {
        const registry = await userAgentRegistryClient.get();
        setUserRegistry(registry);
        set({ registry });
      } else {
        set({ error: result.error });
      }
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : "Failed to update agent";
      set({ error });
      return { success: false, error };
    }
  },

  removeAgent: async (id: string) => {
    set({ error: null });
    try {
      const result = await userAgentRegistryClient.remove(id);
      if (result.success) {
        const registry = await userAgentRegistryClient.get();
        setUserRegistry(registry);
        set({ registry });
      } else {
        set({ error: result.error });
      }
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : "Failed to remove agent";
      set({ error });
      return { success: false, error };
    }
  },

  refresh: async () => {
    set({ error: null });
    try {
      const registry = await userAgentRegistryClient.get();
      setUserRegistry(registry);
      set({ registry });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to refresh user agent registry" });
      throw e;
    }
  },
}));

export function cleanupUserAgentRegistryStore() {
  initPromise = null;
  useUserAgentRegistryStore.setState({
    registry: {},
    isLoading: true,
    error: null,
    isInitialized: false,
  });
}
