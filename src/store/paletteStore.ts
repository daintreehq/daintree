import { create } from "zustand";

export type PaletteId =
  | "terminal"
  | "quick-switcher"
  | "new-terminal"
  | "worktree"
  | "panel"
  | "action"
  | "notes"
  | "project-switcher";

interface PaletteState {
  activePaletteId: PaletteId | null;
  openPalette: (id: PaletteId) => void;
  closePalette: (id: PaletteId) => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  activePaletteId: null,
  openPalette: (id) => set({ activePaletteId: id }),
  closePalette: (id) =>
    set((state) => (state.activePaletteId === id ? { activePaletteId: null } : state)),
}));
