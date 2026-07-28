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
