import { create } from "zustand";
import type { PortalTab } from "@shared/types";

/**
 * Ephemeral UI state for bulk portal-tab-close confirmations
 * (`closeAllTabs` / `closeOthers` at the 3+-tab threshold). The action
 * `run()` writes here instead of closing immediately; the app-level
 * `PortalCloseConfirmDialog` host subscribes and renders a modal that
 * re-dispatches the action with `{ confirmed: true }` on confirm or clears
 * the store on cancel.
 *
 * Mirrors `terminalPendingDestructiveActionStore` (Shape A) — the canonical
 * pattern for action-triggered confirms that aren't classified
 * `danger:"confirm"` at the metadata level.
 */
export type PortalPendingCloseKind = "closeAll" | "closeOthers";

export interface PortalPendingCloseSnapshot {
  kind: PortalPendingCloseKind;
  /**
   * Tabs that would be closed — snapshotted at request time so the preview
   * list stays stable even if portal IPC updates tab titles while the dialog
   * is open.
   */
  tabsToClose: PortalTab[];
  /**
   * For `closeOthers`: the tab to keep. The confirmed dispatch carries this
   * so the action re-derives the close set from current store state rather
   * than the (possibly stale) snapshot.
   */
  keepTabId?: string;
}

interface PortalPendingCloseState {
  pending: PortalPendingCloseSnapshot | null;
  request: (snapshot: PortalPendingCloseSnapshot) => void;
  clear: () => void;
}

export const usePortalPendingCloseStore = create<PortalPendingCloseState>((set) => ({
  pending: null,
  request: (snapshot) => set({ pending: snapshot }),
  clear: () => set({ pending: null }),
}));
