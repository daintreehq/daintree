import {
  isDevPreviewPanel,
  isFilePanel,
  isPtyPanel,
  type PanelInstance,
  type TabGroup,
} from "@shared/types/panel";
import { rebaseAbsolutePath, rebaseMruEntry } from "@shared/utils/projectPathRelocation";
import { usePanelStore } from "./panelStore";
import { useWorktreeSelectionStore, type WorktreeMaximizeSnapshot } from "./worktreeStore";

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
 * terminal/dev-preview panels, absolute `filePath` and `fileContainmentRoot` on
 * file panels. (Diff and file-browser paths are worktree-relative; browser
 * fields are URLs.)
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
  if (isFilePanel(next) && typeof next.fileContainmentRoot === "string") {
    const fileContainmentRoot = rebaseAbsolutePath(next.fileContainmentRoot, oldRoot, newRoot);
    if (fileContainmentRoot !== next.fileContainmentRoot) next = { ...next, fileContainmentRoot };
  }

  return next;
}

function rebaseNullableId(id: string | null, oldRoot: string, newRoot: string): string | null {
  return typeof id === "string" ? rebaseAbsolutePath(id, oldRoot, newRoot) : id;
}

/** A new Set with every worktree-id member rebased, or the same Set when none moved. */
function rebaseIdSet(ids: Set<string>, oldRoot: string, newRoot: string): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const id of ids) {
    const rebased = rebaseAbsolutePath(id, oldRoot, newRoot);
    if (rebased !== id) changed = true;
    next.add(rebased);
  }
  return changed ? next : ids;
}

/**
 * A new Map with every worktree-id key (and, through `rebaseValue`, every value
 * that carries one) rebased, or the same Map when nothing moved. Insertion order
 * is kept, so iteration-order readers see the same sequence under new keys.
 */
function rebaseIdKeyedMap<V>(
  map: Map<string, V>,
  oldRoot: string,
  newRoot: string,
  rebaseValue: (value: V) => V = (value) => value
): Map<string, V> {
  let changed = false;
  const next = new Map<string, V>();
  for (const [id, value] of map) {
    const key = rebaseAbsolutePath(id, oldRoot, newRoot);
    const nextValue = rebaseValue(value);
    if (key !== id || nextValue !== value) changed = true;
    next.set(key, nextValue);
  }
  return changed ? next : map;
}

/** The layout snapshot is stamped with the worktree it was captured in. */
function rebaseLayoutSnapshot<T extends { worktreeId: string | undefined }>(
  layout: T | null,
  oldRoot: string,
  newRoot: string
): T | null {
  if (!layout || typeof layout.worktreeId !== "string") return layout;
  const worktreeId = rebaseAbsolutePath(layout.worktreeId, oldRoot, newRoot);
  return worktreeId === layout.worktreeId ? layout : { ...layout, worktreeId };
}

export function rebaseProjectViewRuntimePaths(oldRoot: string, newRoot: string): void {
  usePanelStore.setState((state) => {
    const patch: Partial<typeof state> = {};

    let panelsChanged = false;
    const panelsById: Record<string, PanelInstance> = {};
    for (const [id, panel] of Object.entries(state.panelsById)) {
      const next = rebasePanel(panel, oldRoot, newRoot);
      if (next !== panel) panelsChanged = true;
      panelsById[id] = next;
    }
    if (panelsChanged) patch.panelsById = panelsById;

    // Tab-group worktree bindings (a tab group is pinned to one worktree id).
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
    if (groupsChanged) patch.tabGroups = nextGroups;

    // The per-worktree index's KEYS are worktree ids, which just changed. A
    // relocation only RENAMES ids (old root → new root); bucket MEMBERSHIP and
    // order are untouched, so remap the keys and reuse each bucket array
    // verbatim rather than rebuilding from `panelIds` (which could reorder within
    // a bucket). The "__none__" bucket and buckets for linked worktrees outside
    // the old root keep their keys — rebaseAbsolutePath no-ops on them.
    let indexChanged = false;
    const panelIdsByWorktreeId: Record<string, string[]> = {};
    for (const [worktreeId, ids] of Object.entries(state.panelIdsByWorktreeId)) {
      const key =
        worktreeId === "__none__" ? worktreeId : rebaseAbsolutePath(worktreeId, oldRoot, newRoot);
      if (key !== worktreeId) indexChanged = true;
      panelIdsByWorktreeId[key] = ids;
    }
    if (indexChanged) patch.panelIdsByWorktreeId = panelIdsByWorktreeId;

    // `worktree:<id>` quick-switcher entries; the next selection persists this
    // whole list, so a stale entry would outlive the rewritten state.json one.
    const mruList = state.mruList.map((entry) => rebaseMruEntry(entry, oldRoot, newRoot));
    if (mruList.some((entry, i) => entry !== state.mruList[i])) patch.mruList = mruList;

    const preMaximizeLayout = rebaseLayoutSnapshot(state.preMaximizeLayout, oldRoot, newRoot);
    if (preMaximizeLayout !== state.preMaximizeLayout) patch.preMaximizeLayout = preMaximizeLayout;

    return Object.keys(patch).length > 0 ? patch : state;
  });

  // Worktree ids (absolute paths) the selection store holds, directly and as
  // keys. Repoint them in one write rather than via `setActiveWorktree` — the
  // reopened worktree feed hasn't re-listed the new ids yet, and the setter's
  // terminal-policy side effects would fire against a not-yet-present worktree.
  // `restoreWorktreeId` matters most: the outgoing project-switch snapshot
  // validates it against the new-root worktree ids and drops a stale one.
  useWorktreeSelectionStore.setState((state) => {
    const rebaseMaximize = (snapshot: WorktreeMaximizeSnapshot): WorktreeMaximizeSnapshot => {
      const preMaximizeLayout = rebaseLayoutSnapshot(snapshot.preMaximizeLayout, oldRoot, newRoot);
      return preMaximizeLayout === snapshot.preMaximizeLayout
        ? snapshot
        : { ...snapshot, preMaximizeLayout };
    };
    const next = {
      activeWorktreeId: rebaseNullableId(state.activeWorktreeId, oldRoot, newRoot),
      restoreWorktreeId: rebaseNullableId(state.restoreWorktreeId, oldRoot, newRoot),
      focusedWorktreeId: rebaseNullableId(state.focusedWorktreeId, oldRoot, newRoot),
      expandedWorktrees: rebaseIdSet(state.expandedWorktrees, oldRoot, newRoot),
      expandedTerminals: rebaseIdSet(state.expandedTerminals, oldRoot, newRoot),
      lastFocusedTerminalByWorktree: rebaseIdKeyedMap(
        state.lastFocusedTerminalByWorktree,
        oldRoot,
        newRoot
      ),
      maximizeByWorktree: rebaseIdKeyedMap(
        state.maximizeByWorktree,
        oldRoot,
        newRoot,
        rebaseMaximize
      ),
    };
    const patch: Partial<typeof state> = {};
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (next[key] !== state[key]) Object.assign(patch, { [key]: next[key] });
    }
    return Object.keys(patch).length > 0 ? patch : state;
  });
}
