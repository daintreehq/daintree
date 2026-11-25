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
  | "global-assistant-sessions"
  | "log-level"
  | "recent-dictations"
  | "host-switcher";

/**
 * What the quick switcher is searching instead of everything: the active
 * worktree's files (#17329), or one plugin search provider (#13792).
 */
export type QuickSwitcherScope = { kind: "files" } | { kind: "plugin"; key: string };

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
  /**
   * The quick switcher's scope. Held here rather than in the switcher so an
   * opener can ask for a scoped switcher in the same update that opens it: the
   * first frame then already shows the scoped list. Every opening of any
   * palette, and closing the switcher, drops it.
   */
  quickSwitcherScope: QuickSwitcherScope | null;
  openPalette: (id: PaletteId) => void;
  /** Open the quick switcher, scoped when `scope` is given; a repeat open restarts it. */
  openQuickSwitcher: (scope?: QuickSwitcherScope | null) => void;
  /** Change the scope of the switcher that is already open (keyword + Tab, Backspace). */
  setQuickSwitcherScope: (scope: QuickSwitcherScope | null) => void;
  closePalette: (id: PaletteId) => void;
  /** Counts a mounted prompt-history palette; the returned disposer uncounts it once. */
  registerPromptHistoryHost: () => () => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  activePaletteId: null,
  openRequestId: 0,
  promptHistoryHosts: 0,
  quickSwitcherScope: null,
  openPalette: (id) =>
    set((state) => ({
      activePaletteId: id,
      openRequestId: state.openRequestId + 1,
      quickSwitcherScope: null,
    })),
  openQuickSwitcher: (scope = null) =>
    set((state) => ({
      activePaletteId: "quick-switcher",
      openRequestId: state.openRequestId + 1,
      quickSwitcherScope: scope,
    })),
  setQuickSwitcherScope: (scope) =>
    set((state) =>
      state.activePaletteId === "quick-switcher" ? { quickSwitcherScope: scope } : state
    ),
  closePalette: (id) =>
    set((state) =>
      state.activePaletteId === id ? { activePaletteId: null, quickSwitcherScope: null } : state
    ),
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
