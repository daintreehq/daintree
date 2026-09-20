import { create } from "zustand";
import { getPanelStoreSnapshot } from "./storeAccessors";

/**
 * Which dev preview tool is switched on in each dev preview panel — one at a
 * time per panel. Session state: a tool is an interaction mode, and a reopened
 * app starts with every preview in plain browsing.
 */
export interface DevPreviewToolState {
  /** The tool switched on in each dev preview panel. One at a time per panel. */
  activeByPanel: Readonly<Record<string, string>>;
  setActive: (panelId: string, toolId: string | null) => void;
  toggle: (panelId: string, toolId: string) => void;
  /**
   * How wide the host's tool drawer is, for every preview at once: a width is a
   * judgement about this screen, not about one panel, and a user who widens it
   * in one preview means it for the next one too.
   */
  drawerWidth: number;
  setDrawerWidth: (width: number) => void;
}

/** The drawer's width window. The default is where an untouched drawer opens. */
export const TOOL_DRAWER_DEFAULT_WIDTH = 360;
export const TOOL_DRAWER_MIN_WIDTH = 280;
export const TOOL_DRAWER_MAX_WIDTH = 560;

export function clampToolDrawerWidth(width: number): number {
  if (!Number.isFinite(width)) return TOOL_DRAWER_DEFAULT_WIDTH;
  return Math.min(Math.max(width, TOOL_DRAWER_MIN_WIDTH), TOOL_DRAWER_MAX_WIDTH);
}

/**
 * Drop entries for panels that no longer exist or sit in the trash — restoring
 * one brings the preview back browsing. Belt and braces under the session
 * manager, which watches the panel store and clears these entries as they
 * happen (`src/services/devPreviewTools/sessionManager.ts`); this catches a
 * preview removed while nothing was watching. The panel store is read through
 * its accessor so this store never imports a partner at module evaluation.
 */
function pruned(entries: Readonly<Record<string, string>>): Record<string, string> {
  const panels = getPanelStoreSnapshot()?.panelsById;
  const next: Record<string, string> = {};
  for (const [panelId, toolId] of Object.entries(entries)) {
    const panel = panels?.[panelId];
    if (panels === undefined || (panel !== undefined && panel.location !== "trash")) {
      next[panelId] = toolId;
    }
  }
  return next;
}

export const useDevPreviewToolStore = create<DevPreviewToolState>((set) => ({
  activeByPanel: {},
  drawerWidth: TOOL_DRAWER_DEFAULT_WIDTH,
  setDrawerWidth: (width) => set({ drawerWidth: clampToolDrawerWidth(width) }),
  setActive: (panelId, toolId) =>
    set((state) => {
      const next = pruned(state.activeByPanel);
      if (toolId === null) delete next[panelId];
      else next[panelId] = toolId;
      return { activeByPanel: next };
    }),
  toggle: (panelId, toolId) =>
    set((state) => {
      const next = pruned(state.activeByPanel);
      if (next[panelId] === toolId) delete next[panelId];
      else next[panelId] = toolId;
      return { activeByPanel: next };
    }),
}));
