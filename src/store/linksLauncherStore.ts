import { create } from "zustand";
import {
  consumeDeferredPaletteFocusRestore,
  deferPaletteFocusRestore,
} from "@/components/ui/paletteFocusRestore";

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
  /**
   * The action palette's own focus return, held for a detached opening the
   * palette opened: the launcher has no control of its own to give focus back
   * to, and the palette's opener is where the keyboard was. Spent by the close.
   */
  paletteRestore: (() => void) | null;
  /** Open at `origin`; already open there, only read the links again. */
  open: (origin: LinksLauncherOrigin) => void;
  /** Close the launcher — only if it is still opening `seq`, when given. */
  close: (seq?: number, focus?: (() => HTMLElement | null) | null) => void;
  requestRefresh: () => void;
  takeCloseFocus: () => (() => HTMLElement | null) | null;
  takePaletteRestore: () => (() => void) | null;
}

let nextSeq = 1;

/** The one links launcher of this project view; never persisted. */
export const useLinksLauncherStore = create<LinksLauncherState>((set, get) => ({
  opening: null,
  refreshSeq: 0,
  closeFocus: null,
  paletteRestore: null,
  open: (origin) =>
    set((s) =>
      // Already open there: the same opening, read again, keeping the focus
      // return it holds.
      s.opening?.origin === origin
        ? { refreshSeq: s.refreshSeq + 1 }
        : {
            opening: { origin, seq: nextSeq++ },
            refreshSeq: s.refreshSeq + 1,
            closeFocus: null,
            paletteRestore: null,
          }
    ),
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
  takePaletteRestore: () => {
    const { paletteRestore } = get();
    if (paletteRestore !== null) set({ paletteRestore: null });
    return paletteRestore;
  },
}));

/**
 * Open the launcher from somewhere other than its button (the action
 * palette, a keybinding): beside the button when it is on screen, else at the
 * detached anchor. A wrapper the overflow measurement keeps mounted but hidden
 * carries `aria-hidden`, which is how a button in `…` is told apart.
 *
 * A palette pick arms a hand-off of the palette's focus return before it
 * dispatches. A detached opening takes it over: the palette would otherwise
 * give the keyboard back to its opener on its way out whenever focus is
 * between controls (the list re-rendering under it), and the launcher's
 * anchor has nowhere to return it to when it closes.
 */
export function openLinksLauncher(): void {
  const shown = Array.from(
    document.querySelectorAll('[data-toolbar-button-id="links-launcher"]')
  ).some((wrapper) => wrapper.isConnected && wrapper.closest('[aria-hidden="true"]') === null);
  const store = useLinksLauncherStore.getState();
  store.open(shown ? "button" : "detached");
  if (shown) return;
  const seq = useLinksLauncherStore.getState().opening?.seq;
  if (consumeDeferredPaletteFocusRestore() === null) return;
  deferPaletteFocusRestore((restore) => {
    // Already closed: its close found no return yet, so give it back now.
    if (useLinksLauncherStore.getState().opening?.seq !== seq) {
      restore();
      return;
    }
    useLinksLauncherStore.setState({ paletteRestore: restore });
  });
}
