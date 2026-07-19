import type { GitStatus, DiffChangeSetEntry } from "@shared/types/git";
import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { saveNormalized } from "./persistence";

type Set = PanelRegistryStoreApi["setState"];

function sameChangeSet(a: DiffChangeSetEntry[] | undefined, b: DiffChangeSetEntry[]): boolean {
  if (a === b) return true;
  if (a === undefined || a.length !== b.length) return false;
  return a.every((entry, i) => {
    const next = b[i]!;
    return (
      entry.path === next.path &&
      entry.status === next.status &&
      entry.insertions === next.insertions &&
      entry.deletions === next.deletions &&
      entry.viewedKey === next.viewedKey
    );
  });
}

export const createDiffPanelActions = (
  set: Set
): Pick<PanelRegistrySlice, "setDiffPanelFile" | "setDiffPanelChangeSet"> => ({
  // Path and status move together: a diff fetched for one file under another
  // file's status would ask git for a diff that doesn't exist, so the two must
  // never be observable apart. `viewedKey` joins them because path+status is
  // not unique under partial staging — without it in the comparison, selecting
  // the unstaged twin of a staged file bails as "unchanged" and the selection
  // sticks on the wrong entry.
  setDiffPanelFile: (id: string, filePath: string, fileStatus: GitStatus, viewedKey?: string) => {
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel) return state;
      if (panel.kind !== "diff") return state;
      if (
        panel.filePath === filePath &&
        panel.fileStatus === fileStatus &&
        panel.viewedKey === viewedKey
      ) {
        return state;
      }

      const nextPanel = { ...panel, filePath, fileStatus };
      // Runtime-only cursor: drop it rather than carry a stale key when the
      // caller has none (a restored panel, or an opener with no keyed set).
      if (viewedKey === undefined) delete nextPanel.viewedKey;
      else nextPanel.viewedKey = viewedKey;

      const newById = { ...state.panelsById, [id]: nextPanel };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  // The opener re-derives its change set on every worktree poll, so this is
  // called with a fresh array on a cadence the user never triggered. Bailing on
  // a value-equal set keeps those ticks from re-rendering the whole workspace.
  // Runtime-only field: no `saveNormalized`, since it never persists.
  setDiffPanelChangeSet: (id: string, changeSet: DiffChangeSetEntry[]) => {
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel) return state;
      if (panel.kind !== "diff") return state;
      if (sameChangeSet(panel.changeSet, changeSet)) return state;

      return { panelsById: { ...state.panelsById, [id]: { ...panel, changeSet } } };
    });
  },
});
