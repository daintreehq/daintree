import { create } from "zustand";
import type { PluginLayoutConfig } from "@shared/types/plugin";

/**
 * Renderer mirror of the layouts plugins contribute to THIS view's project
 * (#13780). Main is the source of truth and filters by project, and renderer
 * state is per project view, so a project plugin's layouts never reach another
 * project's view. Filled by `usePluginLayouts`; `layout.apply` resolves ids
 * against it.
 */
interface PluginLayoutsState {
  layouts: readonly PluginLayoutConfig[];
  setLayouts: (layouts: readonly PluginLayoutConfig[]) => void;
}

export const usePluginLayoutsStore = create<PluginLayoutsState>((set) => ({
  layouts: [],
  setLayouts: (layouts) => set({ layouts }),
}));
