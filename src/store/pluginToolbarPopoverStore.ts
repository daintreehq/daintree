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
   * Where focus goes when the popover closes, in place of the control it hangs
   * off — set by a close that is hiding that control. Spent by the close.
   */
  closeFocusTarget: HTMLElement | null;
  /** Open `buttonId`'s popover off `origin`, replacing whichever was open. */
  open: (buttonId: string, origin: PluginToolbarPopoverOrigin) => void;
  /**
   * Close the open popover — only if it is still opening `seq`, when given —
   * optionally handing focus to `focusTarget` instead of its own control.
   */
  close: (seq?: number, focusTarget?: HTMLElement | null) => void;
  /** Close the open popover if its button is no longer contributed. */
  retain: (buttonIds: ReadonlySet<string>) => void;
  /** The pending {@link closeFocusTarget}, cleared as it is read. */
  takeCloseFocusTarget: () => HTMLElement | null;
}

let nextSeq = 1;

/**
 * The one plugin toolbar popover open in this project view. One for the whole
 * toolbar, not one per button: a button reachable from its promoted slot, the
 * tray and the overflow menu would otherwise stack copies of the same view.
 */
export const usePluginToolbarPopoverStore = create<PluginToolbarPopoverState>((set, get) => ({
  opening: null,
  closeFocusTarget: null,
  open: (buttonId, origin) =>
    set({ opening: { buttonId, origin, seq: nextSeq++ }, closeFocusTarget: null }),
  close: (seq, focusTarget = null) => {
    const { opening } = get();
    if (opening === null) return;
    if (seq !== undefined && opening.seq !== seq) return;
    set({ opening: null, closeFocusTarget: focusTarget });
  },
  retain: (buttonIds) => {
    const { opening } = get();
    if (opening !== null && !buttonIds.has(opening.buttonId)) set({ opening: null });
  },
  takeCloseFocusTarget: () => {
    const { closeFocusTarget } = get();
    if (closeFocusTarget !== null) set({ closeFocusTarget: null });
    return closeFocusTarget;
  },
}));
