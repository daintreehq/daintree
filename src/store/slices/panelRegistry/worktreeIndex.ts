/**
 * Per-worktree panel id index. Maintained at write time on add/remove/transfer
 * so per-row selectors (`useWorktreeTerminals(wid)`) can scope work to a single
 * worktree's panels in O(1) lookup, rather than scanning all `panelIds` on
 * every per-terminal field tick. See issue #7451.
 *
 * Reference-stability invariant: the bucket array for any worktree whose
 * membership did NOT change in a given mutation must remain the same array
 * reference across `set()`. Selectors rely on this for strict-equality skips
 * — touching an unrelated worktree's bucket would re-fire every per-row
 * selector on every per-terminal tick.
 */
import type { TabGroupLocation } from "@shared/types/panel";

export type PanelIdsByWorktreeId = Record<string, string[]>;

/** Bucket key for panels with `worktreeId === undefined`. */
export const NO_WORKTREE = "__none__";

/**
 * Single source of truth for whether a panel belongs to a worktree scope at a
 * location. Docked global (worktree-less) panels are intentionally visible in
 * every worktree-scoped dock; grid panels remain worktree-exact so globals
 * never leak into a worktree's grid. Every dock render AND reorder-commit path
 * must share this predicate — a stricter commit-side filter is how dock chip
 * reorders silently no-op (#11289).
 */
export function panelMatchesWorktreeScope(
  panelWorktreeId: string | null | undefined,
  worktreeId: string | null | undefined,
  location: TabGroupLocation
): boolean {
  const panelWt = panelWorktreeId ?? undefined;
  const scopeWt = worktreeId ?? undefined;
  if (panelWt === scopeWt) return true;
  return location === "dock" && panelWt === undefined && scopeWt !== undefined;
}

/**
 * Candidate panel ids, in canonical order, for a scan over every registered
 * panel — the ungrouped-panel pass in `getTabGroups` and the dock rail's own
 * ordered membership selector (`ContentDock`).
 *
 * Iterates `panelIds` first (preserving committed order so explicit/virtual
 * group ordering and drag-reorder via `reorderTabGroups` stay correct), then
 * appends any ids present in `panelIdsByWorktreeId` but not yet in `panelIds`.
 *
 * That tail is the fix for #9649: during a `beginSpawnBatch`/`flushSpawnBatch`
 * window, the worktree index is updated eagerly at panel creation while
 * `panelIds` only appends at flush. Reading `panelIds` alone left freshly-
 * batched recipe panels out of every virtual group until a worktree switch
 * forced a re-derive. `gridPanelIds` in `useContentGridContext` already reads
 * the index, so including its pending ids keeps the ungrouped source consistent
 * with the grid's structural dep — the panel paints on first mount.
 *
 * For a concrete `worktreeId`, the tail scans that worktree's bucket plus the
 * `NO_WORKTREE` bucket (dock-global panels are visible in every worktree-scoped
 * dock — the per-panel `panelMatchesWorktreeScope` filter inside the loop keeps
 * them out of grid queries). For `worktreeId === undefined`, it scans every
 * bucket.
 *
 * Lives here rather than beside `getTabGroups` because both callers need it and
 * this module is a leaf — importing it from `tabGroups.ts` into a component
 * pulls the whole panel-registry action graph into module init and deadlocks
 * the store's own barrel on a cycle.
 */
export function collectUngroupedCandidateIds(
  panelIds: string[],
  panelIdsByWorktreeId: Record<string, string[]>,
  worktreeId: string | undefined
): string[] {
  const seen = new Set(panelIds);
  const buckets =
    worktreeId === undefined
      ? Object.values(panelIdsByWorktreeId)
      : [panelIdsByWorktreeId[worktreeId], panelIdsByWorktreeId[NO_WORKTREE]];

  let pending: string[] | undefined;
  for (const bucket of buckets) {
    if (!bucket) continue;
    for (const id of bucket) {
      if (seen.has(id)) continue;
      seen.add(id);
      (pending ??= []).push(id);
    }
  }

  return pending ? [...panelIds, ...pending] : panelIds;
}

function bucketKey(worktreeId: string | undefined | null): string {
  return worktreeId ?? NO_WORKTREE;
}

export function addToWorktreeIndex(
  index: PanelIdsByWorktreeId,
  worktreeId: string | undefined | null,
  panelId: string
): PanelIdsByWorktreeId {
  const key = bucketKey(worktreeId);
  const existing = index[key];
  if (existing && existing.includes(panelId)) return index;
  const next = existing ? [...existing, panelId] : [panelId];
  return { ...index, [key]: next };
}

export function removeFromWorktreeIndex(
  index: PanelIdsByWorktreeId,
  worktreeId: string | undefined | null,
  panelId: string
): PanelIdsByWorktreeId {
  const key = bucketKey(worktreeId);
  const existing = index[key];
  if (!existing || !existing.includes(panelId)) return index;
  const next = existing.filter((id) => id !== panelId);
  if (next.length === 0) {
    const { [key]: _removed, ...rest } = index;
    return rest;
  }
  return { ...index, [key]: next };
}

export function transferBetweenWorktreeIndex(
  index: PanelIdsByWorktreeId,
  oldWorktreeId: string | undefined | null,
  newWorktreeId: string | undefined | null,
  panelId: string
): PanelIdsByWorktreeId {
  if (bucketKey(oldWorktreeId) === bucketKey(newWorktreeId)) return index;
  return addToWorktreeIndex(
    removeFromWorktreeIndex(index, oldWorktreeId, panelId),
    newWorktreeId,
    panelId
  );
}

/**
 * Rebuild the full index from current panel state. Used as a defensive
 * recovery (e.g. after `hydrateTabGroups` repairs worktreeIds in bulk) and
 * by the unit-test helpers; mutation-time paths should call the targeted
 * `add/remove/transfer` helpers above to preserve bucket reference stability.
 */
export function buildWorktreeIndex(
  panelIds: string[],
  panelsById: Record<string, { worktreeId?: string | null }>
): PanelIdsByWorktreeId {
  const out: PanelIdsByWorktreeId = {};
  for (const id of panelIds) {
    const panel = panelsById[id];
    if (!panel) continue;
    const key = bucketKey(panel.worktreeId);
    const bucket = out[key];
    if (bucket) {
      bucket.push(id);
    } else {
      out[key] = [id];
    }
  }
  return out;
}
