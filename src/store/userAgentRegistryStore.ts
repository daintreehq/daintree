import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { UserAgentRegistry, UserAgentConfig } from "@shared/types";
import { userAgentRegistryClient } from "@/clients/userAgentRegistryClient";
import { setUserRegistry } from "../../shared/config/agentRegistry";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useToolbarPreferencesStore } from "./toolbarPreferencesStore";
import { launcherItemToolbarButtonId } from "@shared/types/toolbar";

interface UserAgentRegistryState {
  registry: UserAgentRegistry | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface UserAgentRegistryActions {
  initialize: () => Promise<void>;
  /**
   * Seed the registry from an already-fetched payload (the batched `app:boot`
   * hydrate result) without an IPC round-trip. No-ops when the store is
   * already initialized so a late seed can't clobber fresher data.
   */
  seedRegistry: (registry: UserAgentRegistry) => void;
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

export const useUserAgentRegistryStore = create<UserAgentRegistryStore>()(
  subscribeWithSelector((set, get) => ({
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
          set({ registry, isLoading: false, isInitialized: true });
        } catch (e) {
          set({
            error: formatErrorMessage(e, "Failed to load user agent registry"),
            isLoading: false,
            isInitialized: false,
          });
        } finally {
          initPromise = null;
        }
      })();

      return initPromise;
    },

    seedRegistry: (registry: UserAgentRegistry) => {
      if (get().isInitialized) return;
      set({ registry, isLoading: false, error: null, isInitialized: true });
    },

    addAgent: async (config: UserAgentConfig) => {
      set({ error: null });
      try {
        const result = await userAgentRegistryClient.add(config);
        if (result.success) {
          const registry = (await userAgentRegistryClient.get()) ?? {};
          set({ registry });
        } else {
          set({ error: result.error });
        }
        return result;
      } catch (e) {
        const error = formatErrorMessage(e, "Failed to add agent");
        set({ error });
        return { success: false, error };
      }
    },

    updateAgent: async (id: string, config: UserAgentConfig) => {
      set({ error: null });
      try {
        const result = await userAgentRegistryClient.update(id, config);
        if (result.success) {
          const registry = (await userAgentRegistryClient.get()) ?? {};
          set({ registry });
        } else {
          set({ error: result.error });
        }
        return result;
      } catch (e) {
        const error = formatErrorMessage(e, "Failed to update agent");
        set({ error });
        return { success: false, error };
      }
    },

    removeAgent: async (id: string) => {
      set({ error: null });
      try {
        const result = await userAgentRegistryClient.remove(id);
        if (result.success) {
          const registry = (await userAgentRegistryClient.get()) ?? {};
          set({ registry });
          // A deleted user agent's toolbar pin goes with it (#12217). Not
          // merely tidiness: `launcher:agent:{id}` carries no provenance, so a
          // plugin agent that later registers the same id would inherit the pin
          // the user made for this one. Only after the backend confirms — a
          // failed removal keeps the agent, so its pin still describes
          // something real.
          const buttonId = launcherItemToolbarButtonId("agent", id);
          const toolbar = useToolbarPreferencesStore.getState();
          const { pinnedButtons, leftButtons, rightButtons } = toolbar.layout;
          // Guarded on there being something to clear: the setter writes
          // through `persist`, and every write ships this view's whole layout
          // including its last-writer-wins side arrays.
          if (
            buttonId in pinnedButtons ||
            leftButtons.includes(buttonId) ||
            rightButtons.includes(buttonId)
          ) {
            toolbar.setLauncherItemOnToolbar(buttonId, false);
          }
        } else {
          set({ error: result.error });
        }
        return result;
      } catch (e) {
        const error = formatErrorMessage(e, "Failed to remove agent");
        set({ error });
        return { success: false, error };
      }
    },

    refresh: async () => {
      set({ error: null });
      try {
        const registry = (await userAgentRegistryClient.get()) ?? {};
        set({ registry });
      } catch (e) {
        set({ error: formatErrorMessage(e, "Failed to refresh user agent registry") });
        throw e;
      }
    },
  }))
);

useUserAgentRegistryStore.subscribe(
  (state) => state.registry,
  (registry) => {
    if (registry !== null) {
      setUserRegistry(registry);
    }
  }
);

export function cleanupUserAgentRegistryStore() {
  initPromise = null;
  useUserAgentRegistryStore.setState({
    registry: null,
    isLoading: true,
    error: null,
    isInitialized: false,
  });
  setUserRegistry({});
}
