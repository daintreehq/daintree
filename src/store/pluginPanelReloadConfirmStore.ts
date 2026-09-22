import { create } from "zustand";

/**
 * The confirmation `plugin.reloadPanel` stages when the view says it holds
 * unsaved work (#12611). The action writes here and refuses the dispatch; the
 * app-level dialog renders it and, on confirm, records a one-shot approval for
 * that panel before dispatching the reload again.
 *
 * The approval lives here rather than in a `confirmed` argument because the
 * action is also an MCP tool: an argument an agent could set would let it skip
 * the very dialog this exists to show.
 */
export interface PluginPanelReloadConfirmRequest {
  panelId: string;
  panelTitle: string;
}

interface PluginPanelReloadConfirmState {
  pending: PluginPanelReloadConfirmRequest | null;
  approvedPanelId: string | null;
  request: (request: PluginPanelReloadConfirmRequest) => void;
  /** The user confirmed: close the dialog and approve one reload of the panel. */
  approve: (panelId: string) => void;
  clear: () => void;
  /** Spend the approval for `panelId`, reporting whether there was one. */
  consumeApproval: (panelId: string) => boolean;
}

export const usePluginPanelReloadConfirmStore = create<PluginPanelReloadConfirmState>(
  (set, get) => ({
    pending: null,
    approvedPanelId: null,
    request: (request) => set({ pending: request, approvedPanelId: null }),
    approve: (panelId) => set({ pending: null, approvedPanelId: panelId }),
    clear: () => set({ pending: null }),
    consumeApproval: (panelId) => {
      if (get().approvedPanelId !== panelId) return false;
      set({ approvedPanelId: null });
      return true;
    },
  })
);
