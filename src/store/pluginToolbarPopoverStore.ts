import { create } from "zustand";

/**
 * Which toolbar control a plugin popover hangs off: the promoted button itself,
 * or the trigger of the menu the user picked its row from. A menu row is gone
 * once its menu closes, so the popover anchors to — and returns focus to — the
 * control that stays.
 */
export type PluginToolbarPopoverOrigin = "button" | "tray" | "overflow-left" | "overflow-right";

export interface PluginToolbarPopoverOpening {
  buttonId: string;
  origin: PluginToolbarPopoverOrigin;
  /** Tells openings apart, so a close a view kept from an earlier one can't end a later one. */
  seq: number;
}

interface PluginToolbarPopoverState {
  opening: PluginToolbarPopoverOpening | null;
  /**
   * Finds where focus goes when the popover closes, in place of the control it
   * hangs off — set by a close that is hiding that control, and asked only
   * once focus actually moves, since the toolbar can reflow again meanwhile.
   * Spent by the close.
   */
  closeFocus: (() => HTMLElement | null) | null;
  /** Open `buttonId`'s popover off `origin`, replacing whichever was open. */
  open: (buttonId: string, origin: PluginToolbarPopoverOrigin) => void;
  /**
   * Close the open popover — only if it is still opening `seq`, when given —
   * optionally handing focus to what `focus` finds instead of its own control.
   */
  close: (seq?: number, focus?: (() => HTMLElement | null) | null) => void;
  /** Close the open popover if its button is no longer contributed. */
  retain: (buttonIds: ReadonlySet<string>) => void;
  /** The pending {@link closeFocus}, cleared as it is read. */
  takeCloseFocus: () => (() => HTMLElement | null) | null;
}

let nextSeq = 1;

/**
 * The one plugin toolbar popover open in this project view. One for the whole
 * toolbar, not one per button: a button reachable from its promoted slot, the
 * tray and the overflow menu would otherwise stack copies of the same view.
 */
export const usePluginToolbarPopoverStore = create<PluginToolbarPopoverState>((set, get) => ({
  opening: null,
  closeFocus: null,
  open: (buttonId, origin) =>
    set({ opening: { buttonId, origin, seq: nextSeq++ }, closeFocus: null }),
  close: (seq, focus = null) => {
    const { opening } = get();
    if (opening === null) return;
    if (seq !== undefined && opening.seq !== seq) return;
    set({ opening: null, closeFocus: focus });
  },
  retain: (buttonIds) => {
    const { opening } = get();
    if (opening !== null && !buttonIds.has(opening.buttonId)) set({ opening: null });
  },
  takeCloseFocus: () => {
    const { closeFocus } = get();
    if (closeFocus !== null) set({ closeFocus: null });
    return closeFocus;
  },
}));
