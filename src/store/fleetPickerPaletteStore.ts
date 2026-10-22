import { create } from "zustand";

/**
 * Open state of the cold-start fleet picker palette. The palette mounts in the
 * project-level dialog host while its trigger sits in the worktree sidebar
 * header, so the open flag has to live somewhere both can reach.
 */
interface FleetPickerPaletteState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useFleetPickerPaletteStore = create<FleetPickerPaletteState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
