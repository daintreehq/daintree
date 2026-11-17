import { create } from "zustand";

/**
 * Where the links launcher hangs: its own toolbar button, or, when the action
 * palette opens it while that button is out of sight (in `…`, hidden, or not
 * there yet), a detached anchor at the toolbar's trailing edge.
 */
export type LinksLauncherOrigin = "button" | "detached";

export interface LinksLauncherOpening {
  origin: LinksLauncherOrigin;
  /** Tells openings apart, so a close kept from an earlier one can't end a later one. */
  seq: number;
}

interface LinksLauncherState {
  opening: LinksLauncherOpening | null;
  /**
   * Bumped by every opening, and by the `…` menu opening with the launcher's
   * links inlined: a link changed from another view of this project reached
   * only that view's cache, so each showing re-reads main's list.
   */
  refreshSeq: number;
  /**
   * Finds where focus goes when the launcher closes, in place of the control
   * it hangs off: set by a close that is hiding that control. Spent by the close.
   */
  closeFocus: (() => HTMLElement | null) | null;
  open: (origin: LinksLauncherOrigin) => void;
  /** Close the launcher — only if it is still opening `seq`, when given. */
  close: (seq?: number, focus?: (() => HTMLElement | null) | null) => void;
  requestRefresh: () => void;
  takeCloseFocus: () => (() => HTMLElement | null) | null;
}

let nextSeq = 1;

/** The one links launcher of this project view; never persisted. */
export const useLinksLauncherStore = create<LinksLauncherState>((set, get) => ({
  opening: null,
  refreshSeq: 0,
  closeFocus: null,
  open: (origin) =>
    set((s) => ({
      opening: { origin, seq: nextSeq++ },
      refreshSeq: s.refreshSeq + 1,
      closeFocus: null,
    })),
  close: (seq, focus = null) => {
    const { opening } = get();
    if (opening === null) return;
    if (seq !== undefined && opening.seq !== seq) return;
    set({ opening: null, closeFocus: focus });
  },
  requestRefresh: () => set((s) => ({ refreshSeq: s.refreshSeq + 1 })),
  takeCloseFocus: () => {
    const { closeFocus } = get();
    if (closeFocus !== null) set({ closeFocus: null });
    return closeFocus;
  },
}));

/**
 * Open the launcher from somewhere other than its button (the action
 * palette, a keybinding): beside the button when it is on screen, else at the
 * detached anchor. A wrapper the overflow measurement keeps mounted but hidden
 * carries `aria-hidden`, which is how a button in `…` is told apart.
 */
export function openLinksLauncher(): void {
  const shown = Array.from(
    document.querySelectorAll('[data-toolbar-button-id="links-launcher"]')
  ).some((wrapper) => wrapper.isConnected && wrapper.closest('[aria-hidden="true"]') === null);
  useLinksLauncherStore.getState().open(shown ? "button" : "detached");
}
