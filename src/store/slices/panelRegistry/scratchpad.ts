import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import type { TerminalScratchpad } from "@shared/types/panel";
import { isPtyPanel } from "@shared/types/panel";
import { saveNormalized } from "./persistence";
import {
  SCRATCHPAD_MAX_CHARS,
  clampScratchpadWidth,
  scratchpadHasContent,
} from "@/lib/terminalScratchpad";

type Set = PanelRegistryStoreApi["setState"];

type Next = TerminalScratchpad | undefined;

/**
 * Every Scratchpad write goes through here: a missing or non-terminal panel is
 * left alone (a late write must never recreate a removed pane), an unchanged
 * value is a no-op, and a change is persisted through the same debounced save
 * every other panel field uses.
 */
function updateScratchpad(
  set: Set,
  id: string,
  next: (current: TerminalScratchpad | undefined) => Next
): void {
  set((state) => {
    const panel = state.panelsById[id];
    if (!panel || !isPtyPanel(panel)) return state;
    const current = panel.scratchpad;
    const updated = next(current);
    if (updated === current) return state;

    const newById = { ...state.panelsById, [id]: { ...panel, scratchpad: updated } };
    saveNormalized(newById, state.panelIds);
    return { panelsById: newById };
  });
}

export const createScratchpadActions = (
  set: Set
): Pick<
  PanelRegistrySlice,
  "showScratchpad" | "collapseScratchpad" | "setScratchpadContent" | "setScratchpadWidth"
> => ({
  showScratchpad: (id) => {
    updateScratchpad(set, id, (current) => {
      if (!current) return { content: "", collapsed: false };
      return current.collapsed ? { ...current, collapsed: false } : current;
    });
  },

  // An empty scratchpad leaves nothing behind to expand, so collapsing it
  // removes it; the overflow menu is the way back.
  collapseScratchpad: (id) => {
    updateScratchpad(set, id, (current) => {
      if (!current) return current;
      if (!scratchpadHasContent(current)) return undefined;
      return current.collapsed ? current : { ...current, collapsed: true };
    });
  },

  setScratchpadContent: (id, content) => {
    const bounded = content.slice(0, SCRATCHPAD_MAX_CHARS);
    updateScratchpad(set, id, (current) => {
      if (!current || current.content === bounded) return current;
      return { ...current, content: bounded };
    });
  },

  setScratchpadWidth: (id, width) => {
    const clamped = clampScratchpadWidth(width);
    updateScratchpad(set, id, (current) => {
      if (!current || current.width === clamped) return current;
      return { ...current, width: clamped };
    });
  },
});
