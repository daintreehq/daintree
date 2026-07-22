import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { saveNormalized } from "./persistence";

type Set = PanelRegistryStoreApi["setState"];

export interface FileBrowserViewPatch {
  browserSelectedPath?: string;
  browserExpandedPaths?: string[];
  browserShowIgnored?: boolean;
}

function sameStringList(a: string[] | undefined, b: string[]): boolean {
  if (a === b) return true;
  if (a === undefined || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export const createFileBrowserPanelActions = (
  set: Set
): Pick<PanelRegistrySlice, "setFileBrowserView"> => ({
  // One setter for all three fields rather than three: expanding a folder from
  // the keyboard moves the selection at the same time, and two sequential
  // writes would persist an intermediate state where the selected row does not
  // exist in the expanded tree.
  setFileBrowserView: (id: string, patch: FileBrowserViewPatch) => {
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel) return state;
      if (panel.kind !== "file-browser") return state;

      const selectedUnchanged =
        patch.browserSelectedPath === undefined ||
        patch.browserSelectedPath === panel.browserSelectedPath;
      const expandedUnchanged =
        patch.browserExpandedPaths === undefined ||
        sameStringList(panel.browserExpandedPaths, patch.browserExpandedPaths);
      const ignoredUnchanged =
        patch.browserShowIgnored === undefined ||
        patch.browserShowIgnored === panel.browserShowIgnored;

      // Bail on a no-op write. The tree calls this on every arrow key, and a
      // fresh panel object each time would re-render every panel-store
      // subscriber and re-write the persisted snapshot for nothing.
      if (selectedUnchanged && expandedUnchanged && ignoredUnchanged) return state;

      const nextPanel = {
        ...panel,
        ...(patch.browserSelectedPath !== undefined && {
          browserSelectedPath: patch.browserSelectedPath,
        }),
        ...(patch.browserExpandedPaths !== undefined && {
          browserExpandedPaths: patch.browserExpandedPaths,
        }),
        ...(patch.browserShowIgnored !== undefined && {
          browserShowIgnored: patch.browserShowIgnored,
        }),
      };

      const newById = { ...state.panelsById, [id]: nextPanel };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },
});
