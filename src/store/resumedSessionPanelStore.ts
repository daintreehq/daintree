import { create } from "zustand";

interface ResumedSessionPanelState {
  /** Panels that came back from Cmd+Z as a new process resuming the closed one's conversation. */
  panelIds: ReadonlySet<string>;
  markResumed: (panelId: string) => void;
}

/**
 * In memory, like the close history behind it (#17107): a restart or an
 * evicted view forgets which panels were resumed this way.
 */
export const useResumedSessionPanelStore = create<ResumedSessionPanelState>()((set) => ({
  panelIds: new Set(),
  markResumed: (panelId) =>
    set((state) => {
      if (state.panelIds.has(panelId)) return state;
      const next = new Set(state.panelIds);
      next.add(panelId);
      return { panelIds: next };
    }),
}));
