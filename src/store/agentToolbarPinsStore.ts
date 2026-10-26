import { create } from "zustand";
import type { AgentToolbarPins, AgentToolbarPinsSnapshot } from "@shared/types";
import { isAgentPinned } from "@shared/utils/agentPinned";
import { agentToolbarPinsClient } from "@/clients/agentToolbarPinsClient";

interface AgentToolbarPinsState {
  /**
   * This machine's toolbar agent pins (#14702), whichever host the view's
   * project lives on. Empty until the first snapshot lands, which reads as no
   * intent for any agent.
   */
  pins: AgentToolbarPins;
  /** Main's revision of `pins`; -1 until the first snapshot lands. */
  revision: number;
}

interface AgentToolbarPinsActions {
  /** Takes main's pins unless this view already holds a newer revision. */
  applySnapshot: (snapshot: AgentToolbarPinsSnapshot) => void;
  /**
   * Pins or unpins one agent, optimistically. On failure the view takes main's
   * current pins rather than its own earlier copy, which another view's change
   * may have overtaken, and the error is rethrown.
   */
  setAgentPinned: (agentId: string, pinned: boolean) => Promise<void>;
}

export type AgentToolbarPinsStore = AgentToolbarPinsState & AgentToolbarPinsActions;

export const useAgentToolbarPinsStore = create<AgentToolbarPinsStore>()((set, get) => ({
  pins: {},
  revision: -1,

  applySnapshot: (snapshot) => {
    if (snapshot.revision < get().revision) return;
    set({ pins: snapshot.pins, revision: snapshot.revision });
  },

  setAgentPinned: async (agentId, pinned) => {
    const previous = get().pins;
    set({ pins: { ...previous, [agentId]: pinned } });
    try {
      get().applySnapshot(await agentToolbarPinsClient.set(agentId, pinned));
    } catch (error) {
      try {
        get().applySnapshot(await agentToolbarPinsClient.get());
      } catch {
        if (get().pins[agentId] === pinned) set({ pins: previous });
      }
      throw error;
    }
  },
}));

/** The pins once the first snapshot has landed; null before, so "not loaded" never reads as "none". */
export function selectLoadedAgentPins(state: AgentToolbarPinsStore): AgentToolbarPins | null {
  return state.revision >= 0 ? state.pins : null;
}

/** The agents this machine explicitly pins to the toolbar. */
export function getPinnedAgents(): string[] {
  return Object.entries(useAgentToolbarPinsStore.getState().pins)
    .filter(([, pinned]) => isAgentPinned(pinned))
    .map(([id]) => id);
}
