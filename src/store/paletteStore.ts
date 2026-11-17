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
  /**
   * How many prompt-history palettes are mounted in this view. Unlike the
   * other palettes, that one renders inside an agent composer that holds
   * history, so a view can have none: a shell pane, a browser pane, an empty
   * grid. An opener that isn't a composer asks this before handing off, or the
   * slot would name a palette nothing draws.
   */
  promptHistoryHosts: number;
  openPalette: (id: PaletteId) => void;
  closePalette: (id: PaletteId) => void;
  /** Counts a mounted prompt-history palette; the returned disposer uncounts it once. */
  registerPromptHistoryHost: () => () => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  activePaletteId: null,
  openRequestId: 0,
  promptHistoryHosts: 0,
  openPalette: (id) =>
    set((state) => ({ activePaletteId: id, openRequestId: state.openRequestId + 1 })),
  closePalette: (id) =>
    set((state) => (state.activePaletteId === id ? { activePaletteId: null } : state)),
  registerPromptHistoryHost: () => {
    set((state) => ({ promptHistoryHosts: state.promptHistoryHosts + 1 }));
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      set((state) => ({ promptHistoryHosts: Math.max(0, state.promptHistoryHosts - 1) }));
    };
  },
}));
