import {
  isDevPreviewPanel,
  isFilePanel,
  isPtyPanel,
  type PanelInstance,
  type TabGroup,
} from "@shared/types/panel";
import { rebaseAbsolutePath, rebaseMruEntry } from "@shared/utils/projectPathRelocation";
import { usePanelStore } from "./panelStore";
import type { TrashedTerminalGroupMetadata } from "./slices/panelRegistry/types";
import {
  persistMruList,
  useWorktreeSelectionStore,
  type WorktreeMaximizeSnapshot,
} from "./worktreeStore";

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
 * fields are URLs.) A PTY's conversation cwd stays put: it names where the CLI
 * filed the session, which the folder move didn't carry along.
 */
function rebasePanel(panel: PanelInstance, oldRoot: string, newRoot: string): PanelInstance {
  let next = panel;

  if (next.worktreeId != null) {
    const worktreeId = rebaseAbsolutePath(next.worktreeId, oldRoot, newRoot);
    if (worktreeId !== next.worktreeId) next = { ...next, worktreeId };
  }
  if (typeof next.pendingDockWorktreeId === "string") {
    const pendingDockWorktreeId = rebaseAbsolutePath(next.pendingDockWorktreeId, oldRoot, newRoot);
    if (pendingDockWorktreeId !== next.pendingDockWorktreeId) {
      next = { ...next, pendingDockWorktreeId };
    }
  }
  if (isPtyPanel(next) && next.worktreeMoveNotice) {
    const notice = next.worktreeMoveNotice;
    const destinationWorktreeId = rebaseAbsolutePath(
      notice.destinationWorktreeId,
      oldRoot,
      newRoot
    );
    if (destinationWorktreeId !== notice.destinationWorktreeId) {
      next = { ...next, worktreeMoveNotice: { ...notice, destinationWorktreeId } };
    }
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
 * A new Map with keys and values passed through the given rebases, or the same
 * Map when nothing moved. Insertion order is kept, so iteration-order readers see
 * the same sequence under the new keys. When a moved key lands on one already
 * there, the moved entry wins: the new root had no worktree before the move, so
 * whatever sat under its id is a leftover.
 */
function remapMap<V>(
  map: Map<string, V>,
  rebaseKey: (key: string) => string,
  rebaseValue: (value: V) => V
): Map<string, V> {
  let changed = false;
  const movedKeys = new Set<string>();
  const next = new Map<string, V>();
  for (const [key, value] of map) {
    const nextKey = rebaseKey(key);
    const nextValue = rebaseValue(value);
    if (nextKey !== key || nextValue !== value) changed = true;
    if (nextKey === key && movedKeys.has(key)) continue;
    if (nextKey !== key) movedKeys.add(nextKey);
    next.set(nextKey, nextValue);
  }
  return changed ? next : map;
}

const unchanged = <T>(value: T): T => value;

/** Trashed/backgrounded group members carry the group's worktree for its restore. */
function rebaseGroupMember<T extends { groupMetadata?: TrashedTerminalGroupMetadata }>(
  entry: T,
  oldRoot: string,
  newRoot: string
): T {
  const metadata = entry.groupMetadata;
  if (!metadata || typeof metadata.worktreeId !== "string") return entry;
  const worktreeId = rebaseAbsolutePath(metadata.worktreeId, oldRoot, newRoot);
  return worktreeId === metadata.worktreeId
    ? entry
    : { ...entry, groupMetadata: { ...metadata, worktreeId } };
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
  const rebaseId = (id: string): string => rebaseAbsolutePath(id, oldRoot, newRoot);
  const mruBefore = usePanelStore.getState().mruList;

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

    // Keyed by panel id; only the group metadata a restore rebuilds from moves.
    const rebaseMember = <T extends { groupMetadata?: TrashedTerminalGroupMetadata }>(
      entry: T
    ): T => rebaseGroupMember(entry, oldRoot, newRoot);
    const trashedTerminals = remapMap(state.trashedTerminals, unchanged, rebaseMember);
    if (trashedTerminals !== state.trashedTerminals) patch.trashedTerminals = trashedTerminals;
    const backgroundedTerminals = remapMap(state.backgroundedTerminals, unchanged, rebaseMember);
    if (backgroundedTerminals !== state.backgroundedTerminals) {
      patch.backgroundedTerminals = backgroundedTerminals;
    }

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
    const crossDiffInitial = rebaseNullableId(
      state.crossDiffDialog.initialWorktreeId,
      oldRoot,
      newRoot
    );
    const next = {
      activeWorktreeId: rebaseNullableId(state.activeWorktreeId, oldRoot, newRoot),
      restoreWorktreeId: rebaseNullableId(state.restoreWorktreeId, oldRoot, newRoot),
      focusedWorktreeId: rebaseNullableId(state.focusedWorktreeId, oldRoot, newRoot),
      pendingWorktreeId: rebaseNullableId(state.pendingWorktreeId, oldRoot, newRoot),
      // Fleet-scope exit writes these straight back into the selection.
      _previousActiveWorktreeId: rebaseNullableId(
        state._previousActiveWorktreeId,
        oldRoot,
        newRoot
      ),
      _previousRestoreWorktreeId: rebaseNullableId(
        state._previousRestoreWorktreeId,
        oldRoot,
        newRoot
      ),
      crossDiffDialog:
        crossDiffInitial === state.crossDiffDialog.initialWorktreeId
          ? state.crossDiffDialog
          : { ...state.crossDiffDialog, initialWorktreeId: crossDiffInitial },
      expandedWorktrees: rebaseIdSet(state.expandedWorktrees, oldRoot, newRoot),
      expandedTerminals: rebaseIdSet(state.expandedTerminals, oldRoot, newRoot),
      lastFocusedTerminalByWorktree: remapMap(
        state.lastFocusedTerminalByWorktree,
        rebaseId,
        unchanged
      ),
      maximizeByWorktree: remapMap(state.maximizeByWorktree, rebaseId, rebaseMaximize),
    };
    const patch: Partial<typeof state> = {};
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (next[key] !== state[key]) Object.assign(patch, { [key]: next[key] });
    }
    return Object.keys(patch).length > 0 ? patch : state;
  });

  // Main already rewrote the saved list; sending the rebased one keeps this
  // view's write bookkeeping on it and supersedes any held write of the old one,
  // which would otherwise replay the old root once the host link is back. Not
  // gated on hydration's MRU suppression: that stops recording selections, and
  // this records none.
  const mruList = usePanelStore.getState().mruList;
  if (mruList !== mruBefore) void persistMruList(mruList);
}
