import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  createSafeJSONStorage,
  readLocalStorageItemSafely,
  safeJSONParse,
} from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import {
  LAUNCHABLE_AGENT_IDS,
  type AssistantOnlyAgentId,
  type BuiltInAgentId,
} from "@shared/config/agentIds";

/**
 * Launchable built-ins only. Excluding the assistant-only ids in the TYPE rather than
 * guarding the setter makes the invariant hold at every entry point at compile time —
 * `setDefaultAgent` writes without validation, so a runtime guard would only cover the
 * paths someone remembered to route through it.
 */
export type DefaultAgentId = Exclude<BuiltInAgentId, AssistantOnlyAgentId>;

/**
 * This preference names the agent a DIRECT launch spawns, and an assistant-only agent
 * has no PTY form to spawn — picking one here used to persist a default that every
 * launch path then quietly refused, so a stored one is dropped on rehydrate. Which
 * agent the Daintree Assistant runs is its own setting, on the assistant settings tab.
 */
function isValidAgentId(value: unknown): value is DefaultAgentId {
  return typeof value === "string" && (LAUNCHABLE_AGENT_IDS as readonly string[]).includes(value);
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
      name: "daintree-agent-preferences",
      storage: createSafeJSONStorage(),
      version: 0,
      migrate: (persistedState) => persistedState as AgentPreferencesState,
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
          const oldRaw = readLocalStorageItemSafely("daintree-toolbar-preferences");
          const oldData = safeJSONParse<{
            state?: { launcher?: { defaultAgent?: unknown } };
          }>(oldRaw, { store: "agentPreferencesStore", key: "daintree-toolbar-preferences" }, {});
          const migrated = oldData?.state?.launcher?.defaultAgent;
          if (isValidAgentId(migrated)) {
            return { ...currentState, defaultAgent: migrated };
          }
        } catch {
          // Migration failure is non-fatal — fall through to default.
        }

        return { ...currentState };
      },
    }
  )
);

registerPersistedStore({
  storeId: "agentPreferencesStore",
  store: useAgentPreferencesStore,
  persistedStateType: "{ defaultAgent: DefaultAgentId | undefined }",
});
