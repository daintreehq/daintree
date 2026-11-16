import { create } from "zustand";

interface ResumedSessionPanelState {
  /** Panels that came back from Cmd+Z as a new process resuming the closed one's conversation. */
  panelIds: ReadonlySet<string>;
  /** Marks a resumed panel, forgetting any marked panel no longer open or trashed. */
  markResumed: (panelId: string, isKnown: (panelId: string) => boolean) => void;
}

/**
 * In memory, like the close history behind it (#17107): a restart or an
 * evicted view forgets which panels were resumed this way.
 */
export const useResumedSessionPanelStore = create<ResumedSessionPanelState>()((set) => ({
  panelIds: new Set(),
  markResumed: (panelId, isKnown) =>
    set((state) => {
      const next = new Set([...state.panelIds].filter(isKnown));
      next.add(panelId);
      return { panelIds: next };
    }),
}));
