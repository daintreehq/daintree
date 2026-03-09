import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";

const memoryStorage: StateStorage = (() => {
  const storage = new Map<string, string>();
  return {
    getItem: (name) => storage.get(name) ?? null,
    setItem: (name, value) => {
      storage.set(name, value);
    },
    removeItem: (name) => {
      storage.delete(name);
    },
  };
})();

function getSafeStorage(): StateStorage {
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return memoryStorage;
}

export type DefaultAgentId = "claude" | "gemini" | "codex" | "opencode";

interface AgentPreferences {
  defaultAgent: DefaultAgentId | undefined;
}

interface AgentPreferencesState extends AgentPreferences {
  setDefaultAgent: (agent: DefaultAgentId | undefined) => void;
}

const DEFAULT_PREFERENCES: AgentPreferences = {
  defaultAgent: undefined,
};

export const useAgentPreferencesStore = create<AgentPreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      setDefaultAgent: (agent) => set({ defaultAgent: agent }),
    }),
    {
      name: "canopy-agent-preferences",
      storage: createJSONStorage(() => getSafeStorage()),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<AgentPreferencesState>;

        // If this store already has data, use it directly.
        if (persisted?.defaultAgent !== undefined) {
          return { ...currentState, ...persisted };
        }

        // One-time migration: read defaultAgent from the old toolbar preferences key.
        // We access localStorage directly here because getItem on StateStorage can return
        // a Promise in async storage implementations, but localStorage is always synchronous.
        try {
          if (typeof localStorage !== "undefined") {
            const oldRaw = localStorage.getItem("canopy-toolbar-preferences");
            if (oldRaw) {
              const oldData = JSON.parse(oldRaw) as {
                state?: { launcher?: { defaultAgent?: DefaultAgentId } };
              };
              const migrated = oldData?.state?.launcher?.defaultAgent;
              if (migrated) {
                return { ...currentState, ...persisted, defaultAgent: migrated };
              }
            }
          }
        } catch {
          // Migration failure is non-fatal — fall through to default.
        }

        return { ...currentState, ...persisted };
      },
    }
  )
);
