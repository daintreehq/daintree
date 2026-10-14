import type {
  AgentDefaultsLegacyCandidates,
  AgentDefaultsPatch,
  AgentDefaultsSnapshot,
} from "@shared/types";

export const agentDefaultsClient = {
  get: (): Promise<AgentDefaultsSnapshot> => {
    return window.electron.agentDefaults.get();
  },

  set: (patch: AgentDefaultsPatch): Promise<AgentDefaultsSnapshot> => {
    return window.electron.agentDefaults.set(patch);
  },

  migrateLegacy: (candidates: AgentDefaultsLegacyCandidates): Promise<AgentDefaultsSnapshot> => {
    return window.electron.agentDefaults.migrateLegacy(candidates);
  },

  onChanged: (callback: (snapshot: AgentDefaultsSnapshot) => void): (() => void) => {
    return window.electron.agentDefaults.onChanged(callback);
  },
};
