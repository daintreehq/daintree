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
 * has a natural prop path to a `useState` in the app shell.
 *
 * Nothing here persists, and there is no longer anything that could. `isOpen`
 * deliberately does not — a dialog that reopens itself on next launch because
 * it was open at quit is a surprise, not a restored preference — and the
 * collapse set that used to ride the `persist` middleware went with the
 * disclosure it served (#11669): a project collapsed last week hiding an agent
 * that blocks today is the wrong default on a surface whose job is to show
 * every agent. The orphaned `daintree-pilot` localStorage key is inert.
 */
export const usePilotStore = create<PilotState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}));
