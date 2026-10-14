import { create } from "zustand";
import { agentDefaultsClient } from "@/clients/agentDefaultsClient";
import { logError } from "@/utils/logger";
import { isBuiltInAgentId, type BuiltInAgentId } from "@shared/config/agentIds";

export type DefaultAgentId = BuiltInAgentId;

interface AgentPreferencesState {
  /**
   * The host's default agent for new terminals and automated workflows
   * (#13345). A mirror of `agentSettings.defaultAgent` in the host's main
   * process, so it follows the host this window is attached to, never this
   * machine. Undefined when the host has none.
   */
  defaultAgent: DefaultAgentId | undefined;
  /** A person's choice: shown at once and saved on the host. */
  setDefaultAgent: (agent: DefaultAgentId | undefined) => Promise<void>;
  /** Mirror what the host holds. Never writes back, so a push can't echo. */
  applyHostDefaultAgent: (agent: DefaultAgentId | null | undefined) => void;
}

let writeEpoch = 0;

export const useAgentPreferencesStore = create<AgentPreferencesState>()((set, get) => ({
  defaultAgent: undefined,

  setDefaultAgent: async (agent) => {
    const epoch = ++writeEpoch;
    const previous = get().defaultAgent;
    set({ defaultAgent: agent });
    try {
      await agentDefaultsClient.set({ defaultAgent: agent ?? null });
    } catch (error) {
      // A newer choice owns the value now; only the latest write rolls back.
      if (epoch === writeEpoch && get().defaultAgent === agent) set({ defaultAgent: previous });
      logError("Failed to save the default agent", error);
    }
  },

  applyHostDefaultAgent: (agent) => {
    const next = isBuiltInAgentId(agent) ? agent : undefined;
    if (get().defaultAgent !== next) set({ defaultAgent: next });
  },
}));
