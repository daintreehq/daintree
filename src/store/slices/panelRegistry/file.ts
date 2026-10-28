import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { saveNormalized } from "./persistence";

type Set = PanelRegistryStoreApi["setState"];

export const createFilePanelActions = (
  set: Set
): Pick<PanelRegistrySlice, "setFilePanelPath" | "setFileViewMode" | "setFileEditorChoice"> => ({
  setFilePanelPath: (id, filePath) => {
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel) return state;
      if (panel.kind !== "file") return state;
      if (panel.filePath === filePath) return state;

      // A root pinned for the file a link opened says nothing about the file
      // the user picks next, so it doesn't carry over — nor does the editor a
      // default picked for it.
      const { fileContainmentRoot: _pinnedRoot, fileEditorChoice: _pinnedEditor, ...rest } = panel;
      const newById = { ...state.panelsById, [id]: { ...rest, filePath } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setFileViewMode: (id, viewMode) => {
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel) return state;
      if (panel.kind !== "file") return state;
      if ((panel.fileViewMode ?? "source") === viewMode) return state;

      const newById = { ...state.panelsById, [id]: { ...panel, fileViewMode: viewMode } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setFileEditorChoice: (id, choice) => {
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel || panel.kind !== "file" || panel.fileEditorChoice === choice) return state;
      const newById = { ...state.panelsById, [id]: { ...panel, fileEditorChoice: choice } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },
});
