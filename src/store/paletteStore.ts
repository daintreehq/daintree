import { create } from "zustand";

export type PaletteId =
  | "quick-switcher"
  | "worktree"
  | "panel"
  | "action"
  | "project-switcher"
  | "quick-create"
  | "prompt-history"
  | "send-to-agent"
  | "bulk-command"
  | "theme"
  | "resume-sessions"
  | "assistant-sessions"
  | "log-level"
  | "recent-dictations"
  | "host-switcher";

interface PaletteState {
  activePaletteId: PaletteId | null;
  /**
   * Bumped by every `openPalette` call, including one for the palette that is
   * already open. A palette's search state lives in whichever component renders
   * it, so this is how an opener elsewhere (a keybinding, an action) asks for
   * the fresh start a palette's own `open()` gives: cleared query, selection
   * back at the top.
   */
  openRequestId: number;
  openPalette: (id: PaletteId) => void;
  closePalette: (id: PaletteId) => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  activePaletteId: null,
  openRequestId: 0,
  openPalette: (id) =>
    set((state) => ({ activePaletteId: id, openRequestId: state.openRequestId + 1 })),
  closePalette: (id) =>
    set((state) => (state.activePaletteId === id ? { activePaletteId: null } : state)),
}));
