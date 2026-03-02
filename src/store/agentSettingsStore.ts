import { create } from "zustand";
import type { AgentSettings, AgentSettingsEntry, CliAvailability } from "@shared/types";
import { agentSettingsClient } from "@/clients";
import { DEFAULT_AGENT_SETTINGS } from "@shared/types";
import { getEffectiveAgentIds } from "../../shared/config/agentRegistry";

interface AgentSettingsState {
  settings: AgentSettings | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface AgentSettingsActions {
  initialize: () => Promise<void>;
  updateAgent: (agentId: string, updates: Partial<AgentSettingsEntry>) => Promise<void>;
  setAgentSelected: (agentId: string, selected: boolean) => Promise<void>;
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

  setAgentSelected: async (agentId: string, selected: boolean) => {
    return get().updateAgent(agentId, { selected });
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

let migrationPromise: Promise<void> | null = null;

/**
 * Migrate agents that have no `selected` field by defaulting to
 * `true` when the CLI is installed, `false` otherwise.
 * Only touches agents whose `selected` is strictly `undefined`.
 * Covers both stored agent entries and agents newly added to the registry.
 *
 * Also migrates the deprecated `enabled` field: if `enabled === false` and
 * `selected` is not already `false`, sets `selected = false` to preserve user
 * intent, then clears `enabled`.
 *
 * Idempotent — subsequent calls are no-ops when all agents already have `selected` set.
 */
export async function migrateAgentSelection(availability: CliAvailability): Promise<void> {
  // Prevent concurrent executions
  if (migrationPromise) return migrationPromise;

  const { settings } = useAgentSettingsStore.getState();
  if (!settings?.agents) return;

  const registeredIds = getEffectiveAgentIds();
  const agentsNeedingMigration = registeredIds.filter(
    (agentId) => settings.agents[agentId]?.selected === undefined
  );

  // Find agents with deprecated `enabled === false` that need migration
  const agentsNeedingEnabledMigration = registeredIds.filter((agentId) => {
    const entry = settings.agents[agentId];
    return entry?.enabled === false && entry?.selected !== false;
  });

  if (agentsNeedingMigration.length === 0 && agentsNeedingEnabledMigration.length === 0) return;

  migrationPromise = (async () => {
    try {
      // First: migrate agents without `selected` (existing migration)
      for (const agentId of agentsNeedingMigration) {
        const selected = availability[agentId] === true;
        await agentSettingsClient.set(agentId, { selected });
      }

      // Second: migrate deprecated `enabled` → `selected`
      // Runs after the above to avoid clobbering freshly-seeded values
      for (const agentId of agentsNeedingEnabledMigration) {
        await agentSettingsClient.set(agentId, { selected: false, enabled: undefined });
      }

      // Re-read the full settings after all updates
      const updated = await agentSettingsClient.get();
      if (updated) {
        useAgentSettingsStore.setState({ settings: updated });
      }
    } finally {
      migrationPromise = null;
    }
  })();

  return migrationPromise;
}

export function getSelectedAgents(): string[] {
  const settings = useAgentSettingsStore.getState().settings;
  if (!settings?.agents) return [];
  return Object.entries(settings.agents)
    .filter(([, entry]) => entry.selected !== false)
    .map(([id]) => id);
}

export function cleanupAgentSettingsStore() {
  initPromise = null;
  migrationPromise = null;
  useAgentSettingsStore.setState({
    settings: DEFAULT_AGENT_SETTINGS,
    isLoading: true,
    error: null,
    isInitialized: false,
  });
}
