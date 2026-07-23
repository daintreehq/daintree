/**
 * Three-way merge for the per-project layout arrays (terminal/panel snapshots
 * and tab groups) that are persisted concurrently by multiple windows viewing
 * the same project.
 *
 * The problem (#11350): the same project can be open in more than one window
 * (#5033 / #5492). Each window hydrates its layout once from a point-in-time
 * read, then autosaves its whole in-memory array back to the shared project
 * state. Those writes are serialized in Main but never merged, so a window
 * holding an older snapshot silently overwrites a sibling window's additions,
 * moves, and deletions — a dropped panel becomes unreachable on next load.
 *
 * The fix is a compact three-way merge. A writing renderer sends its full array
 * plus two id lists derived from its own last-acknowledged baseline:
 *   - `changedIds`: entries the writer added or modified since its baseline.
 *   - `removedIds`: entries present in its baseline but gone from its array.
 * Main merges the incoming array against the on-disk array so that a writer only
 * ever affects entries it actually touched; everything else (a sibling window's
 * concurrent changes) is preserved. Entries the writer did not change take the
 * on-disk value, so a sibling's edit survives; an entry the writer never knew
 * (a sibling's addition) is kept; an entry the writer did not change but that a
 * sibling deleted is not resurrected.
 *
 * Ordering is resolved last-writer-wins: the merged result follows the incoming
 * array's order for entries the writer knows, with sibling-only entries appended.
 * A concurrent reorder can therefore be superseded, but no entry is ever lost —
 * which is the invariant #11350 requires.
 *
 * Pure and dependency-free so both the renderer (delta computation) and Main
 * (merge application) can share it.
 */

export interface IdArrayDelta {
  /** Ids the writer added or whose content changed relative to its baseline. */
  changedIds: string[];
  /** Ids present in the writer's baseline but absent from its current array. */
  removedIds: string[];
}

/**
 * Compute the delta between a renderer's last-acknowledged baseline and its
 * current array. `equals` decides whether an entry's content changed (identity
 * is by `id`; content equality is caller-defined, e.g. a deep comparison).
 */
export function computeIdArrayDelta<T extends { id: string }>(
  base: readonly T[],
  current: readonly T[],
  equals: (a: T, b: T) => boolean
): IdArrayDelta {
  const baseById = new Map<string, T>();
  for (const entry of base) {
    baseById.set(entry.id, entry);
  }

  const changedIds: string[] = [];
  const currentIds = new Set<string>();
  for (const entry of current) {
    currentIds.add(entry.id);
    const prev = baseById.get(entry.id);
    if (prev === undefined || !equals(prev, entry)) {
      changedIds.push(entry.id);
    }
  }

  const removedIds: string[] = [];
  for (const entry of base) {
    if (!currentIds.has(entry.id)) {
      removedIds.push(entry.id);
    }
  }

  return { changedIds, removedIds };
}

/**
 * Merge a writer's `incoming` array into the current on-disk `existing` array,
 * applying only the changes the writer actually made (`changedIds` /
 * `removedIds`) and preserving every other existing entry — including entries a
 * sibling window added or modified.
 *
 * Semantics per id:
 *   - in `removedIds`  → dropped (the writer deleted it).
 *   - in `changedIds`  → the incoming value wins (the writer added/changed it).
 *   - otherwise, present on disk → the on-disk value is kept (preserves a
 *     sibling's concurrent edit; a same-value no-op is a harmless identity).
 *   - otherwise, absent from disk → dropped (a sibling deleted it and the writer
 *     did not touch it, so the writer has no authority to resurrect it).
 * Existing entries the writer never knew (not in `incoming`, not in
 * `removedIds`) are appended, preserving sibling additions.
 */
export function mergeIdArray<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  changedIds: readonly string[],
  removedIds: readonly string[]
): T[] {
  const existingById = new Map<string, T>();
  for (const entry of existing) {
    existingById.set(entry.id, entry);
  }
  const changed = new Set(changedIds);
  const removed = new Set(removedIds);
  const incomingIds = new Set<string>();

  const result: T[] = [];
  for (const entry of incoming) {
    incomingIds.add(entry.id);
    if (removed.has(entry.id)) {
      continue;
    }
    if (changed.has(entry.id)) {
      result.push(entry);
      continue;
    }
    const onDisk = existingById.get(entry.id);
    if (onDisk !== undefined) {
      result.push(onDisk);
    }
    // else: a sibling deleted it and the writer did not change it — do not
    // resurrect.
  }

  for (const entry of existing) {
    if (!incomingIds.has(entry.id) && !removed.has(entry.id)) {
      result.push(entry);
    }
  }

  return result;
}
