import type {
  FileBrowserSortDirection,
  FileBrowserSortKey,
  FileBrowserTreeSnapshot,
} from "@shared/types/panel";
import { deepEqualIgnoringUndefined } from "@shared/utils/layoutMerge";
import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { saveNormalized } from "./persistence";
import {
  FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH,
  normalizeFileBrowserSidebarWidth,
} from "@/panels/file-browser/sidebarWidth";

type Set = PanelRegistryStoreApi["setState"];

export interface FileBrowserViewPatch {
  browserSelectedPath?: string;
  browserExpandedPaths?: string[];
  browserHideDotfiles?: boolean;
  /** "" roots the tree back at the worktree root. */
  browserRootPath?: string;
  /** `true` collapses the tree sidebar; `false` and absent both mean open. */
  browserSidebarCollapsed?: boolean;
  /** `true` collapses the viewer column; `false` and absent both mean open. */
  browserViewerCollapsed?: boolean;
  /** Last-known tree structure, captured as the view goes away (#11367). */
  browserTreeSnapshot?: FileBrowserTreeSnapshot;
  /** Tree column width in px; clamped into range before it lands. */
  browserSidebarWidth?: number;
  /** What the tree and folder listing order entries by (#11620). */
  browserSortKey?: FileBrowserSortKey;
  /** Direction for `browserSortKey`; `asc` and absent are the same state. */
  browserSortDirection?: FileBrowserSortDirection;
}

function sameStringList(a: string[] | undefined, b: string[]): boolean {
  if (a === b) return true;
  if (a === undefined || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export const createFileBrowserPanelActions = (
  set: Set
): Pick<PanelRegistrySlice, "setFileBrowserView"> => ({
  // One setter for every view field rather than one per field: expanding a
  // folder from the keyboard moves the selection at the same time, and two
  // sequential writes would persist an intermediate state where the selected
  // row does not exist in the expanded tree.
  setFileBrowserView: (id: string, patch: FileBrowserViewPatch) => {
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel) return state;
      if (panel.kind !== "file-browser") return state;

      // Normalize at the single write chokepoint so a continuous drag (or any
      // programmatic caller) can never persist an out-of-range or non-finite
      // width: a finite value is clamped into range, and `NaN`/`Infinity`
      // (valid under TS's `number`) collapse to `undefined` and are ignored as
      // a no-op rather than churning the store with an invalid value.
      const nextWidth =
        patch.browserSidebarWidth === undefined
          ? undefined
          : normalizeFileBrowserSidebarWidth(patch.browserSidebarWidth);

      const selectedUnchanged =
        patch.browserSelectedPath === undefined ||
        patch.browserSelectedPath === panel.browserSelectedPath;
      const expandedUnchanged =
        patch.browserExpandedPaths === undefined ||
        sameStringList(panel.browserExpandedPaths, patch.browserExpandedPaths);
      const hideDotfilesUnchanged =
        patch.browserHideDotfiles === undefined ||
        patch.browserHideDotfiles === panel.browserHideDotfiles;
      // "" and absent are the same state (the worktree root), so resetting a
      // never-rooted panel must not count as a change.
      const rootUnchanged =
        patch.browserRootPath === undefined ||
        patch.browserRootPath === (panel.browserRootPath ?? "");
      // `false` and absent are the same open state, so patching `false` onto a
      // never-collapsed panel must not count as a change. Compared as
      // normalized booleans rather than raw optionals for that reason.
      const sidebarCollapsedUnchanged =
        patch.browserSidebarCollapsed === undefined ||
        (patch.browserSidebarCollapsed === true) === (panel.browserSidebarCollapsed === true);
      // The viewer flag gets its own comparison rather than riding the sidebar's:
      // folding them together would make a viewer-only patch look unchanged and
      // bail out below, so every viewer toggle would be a silent no-op (#11496).
      const viewerCollapsedUnchanged =
        patch.browserViewerCollapsed === undefined ||
        (patch.browserViewerCollapsed === true) === (panel.browserViewerCollapsed === true);
      // Deep rather than reference equality: capture builds a fresh snapshot
      // object on every hide, and most hides change nothing — a reference
      // check would dirty the panel entry (and the persisted layout) each time.
      const treeSnapshotUnchanged =
        patch.browserTreeSnapshot === undefined ||
        deepEqualIgnoringUndefined(patch.browserTreeSnapshot, panel.browserTreeSnapshot);
      // Absent width and the 288 default are the same state, so resetting a
      // never-resized panel to the default must count as a no-op — normalized
      // through `?? DEFAULT` on both sides, like the collapsed flag.
      const widthUnchanged =
        nextWidth === undefined ||
        nextWidth === (panel.browserSidebarWidth ?? FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH);
      // Both sort halves normalize absent to their default before comparing,
      // like the collapse flags: patching "name"/"asc" onto a never-sorted
      // panel is the state it is already in, not a change worth a write.
      const sortKeyUnchanged =
        patch.browserSortKey === undefined ||
        patch.browserSortKey === (panel.browserSortKey ?? "name");
      const sortDirectionUnchanged =
        patch.browserSortDirection === undefined ||
        patch.browserSortDirection === (panel.browserSortDirection ?? "asc");

      // Bail on a no-op write. The tree calls this on every arrow key, and a
      // drag calls it on every mousemove; a fresh panel object each time would
      // re-render every panel-store subscriber and re-write the persisted
      // snapshot for nothing.
      if (
        selectedUnchanged &&
        expandedUnchanged &&
        hideDotfilesUnchanged &&
        rootUnchanged &&
        sidebarCollapsedUnchanged &&
        viewerCollapsedUnchanged &&
        treeSnapshotUnchanged &&
        widthUnchanged &&
        sortKeyUnchanged &&
        sortDirectionUnchanged
      )
        return state;

      const nextPanel = {
        ...panel,
        ...(patch.browserSelectedPath !== undefined && {
          browserSelectedPath: patch.browserSelectedPath,
        }),
        ...(patch.browserExpandedPaths !== undefined && {
          browserExpandedPaths: patch.browserExpandedPaths,
        }),
        ...(patch.browserHideDotfiles !== undefined && {
          browserHideDotfiles: patch.browserHideDotfiles,
        }),
        ...(patch.browserRootPath !== undefined && {
          browserRootPath: patch.browserRootPath,
        }),
        ...(patch.browserSidebarCollapsed !== undefined && {
          browserSidebarCollapsed: patch.browserSidebarCollapsed,
        }),
        ...(patch.browserViewerCollapsed !== undefined && {
          browserViewerCollapsed: patch.browserViewerCollapsed,
        }),
        ...(patch.browserTreeSnapshot !== undefined && {
          browserTreeSnapshot: patch.browserTreeSnapshot,
        }),
        ...(nextWidth !== undefined && { browserSidebarWidth: nextWidth }),
        ...(patch.browserSortKey !== undefined && {
          browserSortKey: patch.browserSortKey,
        }),
        ...(patch.browserSortDirection !== undefined && {
          browserSortDirection: patch.browserSortDirection,
        }),
      };

      const newById = { ...state.panelsById, [id]: nextPanel };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },
});
