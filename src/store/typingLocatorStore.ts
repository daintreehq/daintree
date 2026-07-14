import { create } from "zustand";

/**
 * Transient "here is where your typing is going" label (#11134).
 *
 * Deliberately not routed through `notify()`: this is ephemeral typing
 * feedback the user is already looking for, not an event they could otherwise
 * miss, and it must leave no inbox history. The grid-bar and InlineStatusBanner
 * surfaces are both wrong for the same reason — they are for runtime signals
 * with recovery actions.
 */
interface TypingLocatorState {
  label: string | null;
  /** Bumped on every show so a repeat locator for the same pane restarts the dwell. */
  revision: number;
  showLocator: (label: string) => void;
  clearLocator: () => void;
}

export const useTypingLocatorStore = create<TypingLocatorState>()((set) => ({
  label: null,
  revision: 0,
  showLocator: (label) => set((s) => ({ label, revision: s.revision + 1 })),
  clearLocator: () => set({ label: null }),
}));
