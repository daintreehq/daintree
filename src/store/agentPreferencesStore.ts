import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage, readLocalStorageItemSafely } from "./persistence/safeStorage";
import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "@shared/config/agentIds";

export type DefaultAgentId = BuiltInAgentId;

function isValidAgentId(value: unknown): value is DefaultAgentId {
  return typeof value === "string" && (BUILT_IN_AGENT_IDS as readonly string[]).includes(value);
}

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
      storage: createSafeJSONStorage(),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<AgentPreferencesState> | null;

        // persistedState is null only when the store has never been written to localStorage.
        // If it's non-null (including an empty object from a cleared preference), trust it
        // and skip migration so that an explicit setDefaultAgent(undefined) is not undone.
        if (persisted !== null) {
          const raw = persisted?.defaultAgent;
          return {
            ...currentState,
            defaultAgent: isValidAgentId(raw) ? raw : undefined,
          };
        }

        // One-time migration: read defaultAgent from the old toolbar preferences key.
        // We access localStorage directly here because getItem on StateStorage can return
        // a Promise in async storage implementations, but localStorage is always synchronous.
        try {
          const oldRaw = readLocalStorageItemSafely("canopy-toolbar-preferences");
          if (oldRaw) {
            const oldData = JSON.parse(oldRaw) as {
              state?: { launcher?: { defaultAgent?: unknown } };
            };
            const migrated = oldData?.state?.launcher?.defaultAgent;
            if (isValidAgentId(migrated)) {
              return { ...currentState, defaultAgent: migrated };
            }
          }
        } catch {
          // Migration failure is non-fatal — fall through to default.
        }

        return { ...currentState };
      },
    }
  )
);
