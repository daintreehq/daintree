import type { PanelInstance, TabGroup } from "@shared/types/panel";
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
 * leaves relative values, URLs and opaque ids untouched — so it is safe to run
 * across every candidate field without per-kind narrowing.
 */

// Absolute-path-bearing fields that can appear on a live panel. `worktreeId` is
// itself a normalized absolute path (the worktree root); `cwd` is on PTY panels;
// `filePath`/`markdownFilePath` on file/diff panels. Worktree-relative browser
// paths, URLs and opaque command/env state are deliberately excluded — the
// primitive leaves them alone anyway.
const PANEL_PATH_FIELDS = ["worktreeId", "cwd", "filePath", "markdownFilePath"] as const;

function rebasePanel(panel: PanelInstance, oldRoot: string, newRoot: string): PanelInstance {
  let patch: Record<string, string> | null = null;
  const record = panel as unknown as Record<string, unknown>;
  for (const field of PANEL_PATH_FIELDS) {
    const value = record[field];
    if (typeof value !== "string") continue;
    const next = rebaseAbsolutePath(value, oldRoot, newRoot);
    if (next !== value) (patch ??= {})[field] = next;
  }
  return patch ? ({ ...panel, ...patch } as PanelInstance) : panel;
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

    // Rebuild the per-worktree panel index — its KEYS are worktree ids, which
    // just changed. Membership and order are preserved (only the bucket key
    // moves), so rebuild from `panelIds` rather than mutating buckets in place.
    const panelIdsByWorktreeId: Record<string, string[]> = {};
    for (const id of state.panelIds) {
      const panel = panelsById[id];
      if (!panel) continue;
      const key = panel.worktreeId ?? "__none__";
      (panelIdsByWorktreeId[key] ??= []).push(id);
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
