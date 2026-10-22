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
  /** Open `buttonId`'s popover off `origin`, replacing whichever was open. */
  open: (buttonId: string, origin: PluginToolbarPopoverOrigin) => void;
  /** Close the open popover — only if it is still opening `seq`, when given. */
  close: (seq?: number) => void;
  /** Close the open popover if its button is no longer contributed. */
  retain: (buttonIds: ReadonlySet<string>) => void;
}

let nextSeq = 1;

/**
 * The one plugin toolbar popover open in this project view. One for the whole
 * toolbar, not one per button: a button reachable from its promoted slot, the
 * tray and the overflow menu would otherwise stack copies of the same view.
 */
export const usePluginToolbarPopoverStore = create<PluginToolbarPopoverState>((set, get) => ({
  opening: null,
  open: (buttonId, origin) => set({ opening: { buttonId, origin, seq: nextSeq++ } }),
  close: (seq) => {
    const { opening } = get();
    if (opening === null) return;
    if (seq !== undefined && opening.seq !== seq) return;
    set({ opening: null });
  },
  retain: (buttonIds) => {
    const { opening } = get();
    if (opening !== null && !buttonIds.has(opening.buttonId)) set({ opening: null });
  },
}));
