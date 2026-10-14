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
// The host's last word, so a failed save falls back to what the host holds —
// not to an earlier optimistic choice that never landed either.
let acknowledgedDefaultAgent: DefaultAgentId | undefined;

function toMirror(agent: unknown): DefaultAgentId | undefined {
  return isBuiltInAgentId(agent) ? agent : undefined;
}

export const useAgentPreferencesStore = create<AgentPreferencesState>()((set, get) => ({
  defaultAgent: undefined,

  setDefaultAgent: async (agent) => {
    const epoch = ++writeEpoch;
    set({ defaultAgent: agent });
    try {
      const snapshot = await agentDefaultsClient.set({ defaultAgent: agent ?? null });
      if (epoch === writeEpoch) acknowledgedDefaultAgent = toMirror(snapshot?.defaultAgent);
    } catch (error) {
      logError("Failed to save the default agent", error);
      // Only the latest choice rolls back, and to what the host holds.
      if (epoch === writeEpoch) set({ defaultAgent: acknowledgedDefaultAgent });
    }
  },

  applyHostDefaultAgent: (agent) => {
    const next = toMirror(agent);
    acknowledgedDefaultAgent = next;
    if (get().defaultAgent !== next) set({ defaultAgent: next });
  },
}));
