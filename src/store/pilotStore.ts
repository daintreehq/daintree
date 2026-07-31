import { create } from "zustand";

interface PilotState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

/**
 * Open state for the fleet overview.
 *
 * A store rather than local state threaded through `App`: Pilot is opened from
 * the action registry, the project switcher and a keybinding, and none of those
 * has a natural prop path to a `useState` in the app shell. The surface itself
 * is stateless — it renders whatever the fleet snapshot currently says.
 */
export const usePilotStore = create<PilotState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}));
