import {
  isDevPreviewPanel,
  isFilePanel,
  isPtyPanel,
  type PanelInstance,
  type TabGroup,
} from "@shared/types/panel";
import { rebaseAbsolutePath } from "@shared/utils/projectPathRelocation";
import { usePanelStore } from "./panelStore";
import { useWorktreeSelectionStore } from "./worktreeStore";

/**
 * Live in-memory rebase of a project VIEW's runtime path state after its folder
 * moves/renames (#11282, phase 3). Phase 2 rebases the PERSISTED `state.json`;
 * this is its renderer-live twin — a relocation keeps the WebContentsView (and
 * every xterm instance) alive, so the in-memory panel/worktree stores must be
 * repointed in place, or panels would stay bound to the OLD main-worktree id and
 * appear orphaned once the reopened worktree feed re-lists ids at the new root.
 *
 * Reuses the conservative phase-2 {@link rebaseAbsolutePath} primitive: it only
 * touches absolute paths at/under `oldRoot`, matching at a segment boundary, and
 * leaves relative values, URLs and opaque ids untouched. Kind-aware so the
 * discriminated union stays typed — `worktreeId` on every panel, `cwd` on
 * terminal/dev-preview panels, absolute `filePath` on file panels. (Diff and
 * file-browser paths are worktree-relative; browser fields are URLs.)
 */
function rebasePanel(panel: PanelInstance, oldRoot: string, newRoot: string): PanelInstance {
  let next = panel;

  if (next.worktreeId != null) {
    const worktreeId = rebaseAbsolutePath(next.worktreeId, oldRoot, newRoot);
    if (worktreeId !== next.worktreeId) next = { ...next, worktreeId };
  }
  if ((isPtyPanel(next) || isDevPreviewPanel(next)) && typeof next.cwd === "string") {
    const cwd = rebaseAbsolutePath(next.cwd, oldRoot, newRoot);
    if (cwd !== next.cwd) next = { ...next, cwd };
  }
  if (isFilePanel(next) && typeof next.filePath === "string") {
    const filePath = rebaseAbsolutePath(next.filePath, oldRoot, newRoot);
    if (filePath !== next.filePath) next = { ...next, filePath };
  }

  return next;
}

export function rebaseProjectViewRuntimePaths(oldRoot: string, newRoot: string): void {
  usePanelStore.setState((state) => {
    let changed = false;

    const panelsById: Record<string, PanelInstance> = {};
    for (const [id, panel] of Object.entries(state.panelsById)) {
      const next = rebasePanel(panel, oldRoot, newRoot);
      if (next !== panel) changed = true;
      panelsById[id] = next;
    }

    // Tab-group worktree bindings (a tab group is pinned to one worktree id).
    let tabGroups = state.tabGroups;
    let groupsChanged = false;
    const nextGroups = new Map<string, TabGroup>();
    for (const [gid, group] of state.tabGroups) {
      const wt = group.worktreeId;
      const next = typeof wt === "string" ? rebaseAbsolutePath(wt, oldRoot, newRoot) : wt;
      if (next !== wt) {
        groupsChanged = true;
        nextGroups.set(gid, { ...group, worktreeId: next });
      } else {
        nextGroups.set(gid, group);
      }
    }
    if (groupsChanged) {
      tabGroups = nextGroups;
      changed = true;
    }

    if (!changed) return state;

    // The per-worktree index's KEYS are worktree ids, which just changed. A
    // relocation only RENAMES ids (old root → new root); bucket MEMBERSHIP and
    // order are untouched, so remap the keys and reuse each bucket array
    // verbatim rather than rebuilding from `panelIds` (which could reorder within
    // a bucket). The "__none__" bucket and buckets for linked worktrees outside
    // the old root keep their keys — rebaseAbsolutePath no-ops on them.
    const panelIdsByWorktreeId: Record<string, string[]> = {};
    for (const [worktreeId, ids] of Object.entries(state.panelIdsByWorktreeId)) {
      const key =
        worktreeId === "__none__" ? worktreeId : rebaseAbsolutePath(worktreeId, oldRoot, newRoot);
      panelIdsByWorktreeId[key] = ids;
    }

    return { panelsById, panelIdsByWorktreeId, tabGroups };
  });

  // The active worktree selection is a worktree id (absolute path). Repoint it
  // directly rather than via `setActiveWorktree` — the reopened worktree feed
  // hasn't re-listed the new id yet, and the setter's terminal-policy side
  // effects would fire against a not-yet-present worktree.
  const selection = useWorktreeSelectionStore.getState();
  const activeId = selection.activeWorktreeId;
  if (typeof activeId === "string") {
    const next = rebaseAbsolutePath(activeId, oldRoot, newRoot);
    if (next !== activeId) {
      useWorktreeSelectionStore.setState({ activeWorktreeId: next });
    }
  }
}
