import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { saveNormalized } from "./persistence";

type Set = PanelRegistryStoreApi["setState"];

export const createMarkdownActions = (
  set: Set
): Pick<PanelRegistrySlice, "setMarkdownFilePath" | "setMarkdownViewMode"> => ({
  setMarkdownFilePath: (id, filePath) => {
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel) return state;
      if (panel.kind !== "markdown") return state;
      if (panel.markdownFilePath === filePath) return state;

      const newById = { ...state.panelsById, [id]: { ...panel, markdownFilePath: filePath } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setMarkdownViewMode: (id, viewMode) => {
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel) return state;
      if (panel.kind !== "markdown") return state;
      if ((panel.markdownViewMode ?? "rendered") === viewMode) return state;

      const newById = { ...state.panelsById, [id]: { ...panel, markdownViewMode: viewMode } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },
});
