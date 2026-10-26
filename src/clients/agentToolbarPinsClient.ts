import type { AgentToolbarPinsSnapshot } from "@shared/types";

export const agentToolbarPinsClient = {
  get: (): Promise<AgentToolbarPinsSnapshot> => {
    return window.electron.agentToolbarPins.get();
  },

  set: (agentId: string, pinned: boolean): Promise<AgentToolbarPinsSnapshot> => {
    return window.electron.agentToolbarPins.set(agentId, pinned);
  },

  onChanged: (callback: (snapshot: AgentToolbarPinsSnapshot) => void): (() => void) => {
    return window.electron.agentToolbarPins.onChanged(callback);
  },
};
