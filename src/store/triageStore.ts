import { create } from "zustand";
import type { TriageSnapshot } from "@shared/types/ipc/triage";

interface TriageState {
  isOpen: boolean;
  /** Null until main has answered once — distinct from "no cards yet". */
  snapshot: TriageSnapshot | null;
  open: () => void;
  close: () => void;
  toggle: () => void;
  applySnapshot: (snapshot: TriageSnapshot) => void;
}

/**
 * Open state for the triage panel, and the latest cards main pushed.
 *
 * A store for the same reason as `pilotStore`: the panel opens from an action,
 * a keybinding and a toolbar button, and is lazy-mounted only once open. The
 * snapshot is kept across closes so reopening shows the last cards at once,
 * while main rescans in the background.
 */
export const useTriageStore = create<TriageState>((set) => ({
  isOpen: false,
  snapshot: null,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  applySnapshot: (snapshot) => set({ snapshot }),
}));
