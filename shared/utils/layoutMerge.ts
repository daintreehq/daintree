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
 *
 * Known limitation (follow-up, not a regression vs. the old full-replace): the
 * delta is entry-level. A panel whose only change since the writer's baseline is
 * an ambient runtime field (e.g. an agent's `agentState`) is reported as changed,
 * so Main replaces the whole entry — including its layout fields. If a sibling
 * window moved that same panel, the ambient-driven save can overwrite the move.
 * The old code overwrote every panel's layout on every save, so this is strictly
 * better; fully fixing it needs a field-level merge and is tracked separately.
 *
 * `fieldLevelMerge` (#11461) is the narrow, opt-in slice of that field-level
 * merge, for fields Main itself can author out-of-band (an agent's captured
 * `agentSessionId`). Such a field must not move just because the containing entry
 * was flagged changed by an unrelated ambient field. For those fields only,
 * authority is per-field: the incoming value applies when the writer listed the
 * field in `fieldEdits` (it genuinely changed it since its own baseline), and
 * otherwise the on-disk value stands — whether the writer omitted the field or
 * is carrying a stale copy of it.
 *
 * Both halves matter. Preserving on omission stops a post-exit save from erasing
 * a session id the renderer never held; rejecting an unauthored value stops a
 * stale sibling window from resurrecting one that was deliberately consumed.
 */

/**
 * The `fieldLevelMerge` fields a writer actually changed on one entry since its
 * baseline — set, changed, or cleared. Absence from this list is what tells Main
 * the writer has no opinion, so plain presence/absence of the value can't.
 */
export interface IdArrayFieldEdit {
  id: string;
  fields: string[];
}

export interface IdArrayDelta {
  /** Ids the writer added or whose content changed relative to its baseline. */
  changedIds: string[];
  /** Ids present in the writer's baseline but absent from its current array. */
  removedIds: string[];
  /**
   * Per-entry field-level authority claims for tracked fields. Omitted when
   * empty, so the common delta keeps its historical shape.
   */
  fieldEdits?: IdArrayFieldEdit[];
}

function hasStringId(entry: unknown): entry is { id: string } {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { id?: unknown }).id === "string" &&
    (entry as { id: string }).id.length > 0
  );
}

/**
 * Recursively rewrite a value into the exact shape JSON serialization would
 * produce: `undefined`-valued object keys are dropped, `undefined`/hole array
 * elements and non-finite numbers become `null`, and object keys are sorted so
 * ordering never matters. Functions/symbols are dropped by JSON downstream.
 */
function canonicalizeForJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((element) => (element === undefined ? null : canonicalizeForJson(element)));
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) {
      out[key] = canonicalizeForJson(record[key]);
    }
  }
  return out;
}

/**
 * Structural equality under JSON round-trip semantics. Layout arrays are
 * persisted as JSON, which drops `undefined`-valued keys and maps array holes /
 * non-finite numbers to `null`; the in-memory snapshots a renderer diffs
 * against still carry explicit `undefined` keys (e.g. `worktreeId: undefined`).
 * A naive comparison would then flag an otherwise-identical entry as changed on
 * the first save after hydration, wrongly granting the writer authority to
 * overwrite a sibling's edit (#11350). Comparing the canonical JSON form makes
 * the delta reflect only changes that survive a persist round-trip.
 */
export function deepEqualIgnoringUndefined(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(canonicalizeForJson(left)) === JSON.stringify(canonicalizeForJson(right));
  } catch {
    // Non-serializable input (BigInt, circular): treat as changed so the entry
    // is sent rather than silently dropped from the delta.
    return false;
  }
}

/**
 * Compute the delta between a renderer's last-acknowledged baseline and its
 * current array. `equals` decides whether an entry's content changed (identity
 * is by `id`; content equality is caller-defined, e.g. a deep comparison).
 *
 * `trackedFields` names the `fieldLevelMerge` fields this writer can speak for. A
 * tracked field whose value differs from the writer's baseline — set, changed, or
 * cleared — is reported in `fieldEdits`; one that matches its baseline is not, and
 * Main then leaves the on-disk value alone (#11461). Deriving authority from the
 * baseline rather than tracking intent in the store works because the baseline is
 * primed from the on-disk snapshot at hydration: a value only Main ever knew
 * matches on both sides and is never claimed.
 *
 * An entry with no baseline entry at all claims nothing. Usually that means the
 * writer just created the panel, and its values still apply because there is no
 * on-disk row to defer to. But a baseline can also be missing because an earlier
 * save failed or the view was cached across a project switch, and then the
 * on-disk row may hold something newer — so silence, not authority, is correct.
 */
export function computeIdArrayDelta<T extends { id: string }>(
  base: readonly T[],
  current: readonly T[],
  equals: (a: T, b: T) => boolean,
  trackedFields?: readonly (keyof T & string)[]
): IdArrayDelta {
  const baseById = new Map<string, T>();
  for (const entry of base) {
    if (hasStringId(entry)) baseById.set(entry.id, entry);
  }

  const changedIds: string[] = [];
  const changedSeen = new Set<string>();
  const fieldEdits: IdArrayFieldEdit[] = [];
  const currentIds = new Set<string>();
  for (const entry of current) {
    if (!hasStringId(entry)) continue;
    currentIds.add(entry.id);
    const prev = baseById.get(entry.id);
    if (prev === undefined || !equals(prev, entry)) {
      changedSeen.add(entry.id);
      changedIds.push(entry.id);
    }
    if (trackedFields === undefined || prev === undefined) continue;
    const edited = trackedFields.filter((field) => prev[field] !== entry[field]);
    if (edited.length === 0) continue;
    fieldEdits.push({ id: entry.id, fields: [...edited] });
    // A claim is only honoured for an entry the writer is allowed to touch, so
    // keep the two lists consistent even if a caller-supplied `equals` ignores
    // the tracked field.
    if (!changedSeen.has(entry.id)) {
      changedSeen.add(entry.id);
      changedIds.push(entry.id);
    }
  }

  const removedIds: string[] = [];
  for (const id of baseById.keys()) {
    if (!currentIds.has(id)) {
      removedIds.push(id);
    }
  }

  // Omitted when empty so the common delta keeps its historical shape.
  return fieldEdits.length > 0 ? { changedIds, removedIds, fieldEdits } : { changedIds, removedIds };
}

export interface IdArrayMergeOptions<T> {
  /**
   * Fields merged per-field instead of with the containing entry, because Main
   * can author them out-of-band. The incoming value applies only when the writer
   * claimed the field in `fieldEdits`.
   */
  fieldLevelMerge: readonly (keyof T & string)[];
  /** Per-entry authority claims for those fields, as sent by the writer. */
  fieldEdits?: readonly IdArrayFieldEdit[];
}

function buildFieldEditIndex(
  fieldEdits: readonly IdArrayFieldEdit[] | undefined
): Map<string, Set<string>> {
  const byId = new Map<string, Set<string>>();
  if (fieldEdits === undefined) return byId;
  for (const entry of fieldEdits) {
    if (!hasStringId(entry) || !Array.isArray(entry.fields)) continue;
    // Union duplicate entries for the same id rather than letting the last win.
    const fields = byId.get(entry.id) ?? new Set<string>();
    for (const field of entry.fields) {
      if (typeof field === "string" && field.length > 0) fields.add(field);
    }
    byId.set(entry.id, fields);
  }
  return byId;
}

/**
 * Resolve `fieldLevelMerge` fields against the on-disk entry: a field the writer
 * claimed keeps its incoming value, and every other one reverts to what is on
 * disk. That rejects both an omission (which would erase a value the writer never
 * held) and a stale carried-over value (which would resurrect one another writer
 * deliberately cleared). Returns `incoming` untouched when the two already agree,
 * so the common path allocates nothing.
 *
 * With no on-disk entry there is nothing to defer to, so the incoming values
 * stand. A writer whose entry was deleted on disk therefore still recreates it
 * with its own tracked values — the entry-level last-writer-wins rule #11350
 * already applies to a changed entry, and this does not narrow it.
 */
function applyFieldAuthority<T extends { id: string }>(
  incoming: T,
  onDisk: T | undefined,
  fieldLevelMerge: readonly (keyof T & string)[],
  claimed: ReadonlySet<string> | undefined
): T {
  if (onDisk === undefined) return incoming;
  let patched: T | undefined;
  for (const field of fieldLevelMerge) {
    if (claimed?.has(field)) continue;
    if (onDisk[field] === incoming[field]) continue;
    patched = patched ?? { ...incoming };
    patched[field] = onDisk[field];
  }
  return patched ?? incoming;
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
 *
 * `options.fieldLevelMerge` narrows the "incoming value wins" rule for the named
 * fields only: they move only where the writer claimed them in
 * `options.fieldEdits`, and otherwise keep their on-disk value (#11461).
 */
export function mergeIdArray<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  changedIds: readonly string[],
  removedIds: readonly string[],
  options?: IdArrayMergeOptions<T>
): T[] {
  const existingById = new Map<string, T>();
  for (const entry of existing) {
    // Defensive: a malformed on-disk entry (null / missing id) must not crash
    // the merge or the whole per-project write queue (#11350). Skip it.
    if (hasStringId(entry)) existingById.set(entry.id, entry);
  }
  const changed = new Set(changedIds);
  const removed = new Set(removedIds);
  const incomingIds = new Set<string>();
  const claimedById = buildFieldEditIndex(options?.fieldEdits);

  const result: T[] = [];
  for (const entry of incoming) {
    if (!hasStringId(entry)) continue;
    incomingIds.add(entry.id);
    if (removed.has(entry.id)) {
      continue;
    }
    if (changed.has(entry.id)) {
      result.push(
        options === undefined
          ? entry
          : applyFieldAuthority(
              entry,
              existingById.get(entry.id),
              options.fieldLevelMerge,
              claimedById.get(entry.id)
            )
      );
      continue;
    }
    const onDisk = existingById.get(entry.id);
    if (onDisk !== undefined) {
      result.push(onDisk);
    }
    // else: a sibling deleted it and the writer did not change it — do not
    // resurrect.
  }

  for (const entry of existingById.values()) {
    if (!incomingIds.has(entry.id) && !removed.has(entry.id)) {
      result.push(entry);
    }
  }

  return result;
}

/**
 * Record counterpart to {@link computeIdArrayDelta} for a flat
 * `Record<terminalId, draftText>` (terminal draft inputs, #11352). The map is
 * keyed by id and has no meaningful order, so equality is plain string
 * comparison and there is no reorder concern.
 *
 * `changedIds` are keys present in `current` whose value differs from `base`
 * (added or edited). `removedIds` are keys present in `base` but gone from
 * `current` — the only way to derive a tombstone, since a cleared draft is
 * dropped from the live map entirely and cannot be seen in `current` alone.
 */
export function computeRecordDelta(
  base: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>
): IdArrayDelta {
  const hasOwn = (obj: Readonly<Record<string, string>>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(obj, key);

  const changedIds: string[] = [];
  for (const [id, value] of Object.entries(current)) {
    // Own-property compare so an id like `toString`/`constructor` isn't
    // mistaken for present-on-base via the prototype chain.
    if (!hasOwn(base, id) || base[id] !== value) {
      changedIds.push(id);
    }
  }

  const removedIds: string[] = [];
  for (const id of Object.keys(base)) {
    if (!hasOwn(current, id)) {
      removedIds.push(id);
    }
  }

  return { changedIds, removedIds };
}

/**
 * Record counterpart to {@link mergeIdArray}. Merges a writer's `changedIds` /
 * `removedIds` into the on-disk `existing` record, preserving every key the
 * writer did not touch — including sibling-window keys it never knew (#11352).
 *
 * Semantics per key:
 *   - in `removedIds`  → deleted (the writer cleared/sent it). Removal wins over
 *     a malformed overlap where the same key also appears in `changedIds`.
 *   - in `changedIds`  → the incoming value wins (added/edited by the writer);
 *     a missing/empty incoming value is treated as a defensive deletion.
 *   - otherwise         → the on-disk value is kept (a sibling's concurrent
 *     edit survives; a key the writer never knew is preserved).
 * A key present in `incoming` but not in `changedIds` is never resurrected.
 * Empty/malformed on-disk values are dropped so they don't survive forever.
 */
export function mergeRecord(
  existing: Readonly<Record<string, string>>,
  incoming: Readonly<Record<string, string>>,
  changedIds: readonly string[],
  removedIds: readonly string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(existing)) {
    if (id && typeof value === "string" && value !== "") {
      result[id] = value;
    }
  }

  const removed = new Set(removedIds);
  for (const id of changedIds) {
    if (removed.has(id)) continue;
    // Own-property read so a `constructor`/`toString` id can't pull a function
    // off the prototype chain.
    const value = Object.prototype.hasOwnProperty.call(incoming, id) ? incoming[id] : undefined;
    if (typeof value === "string" && value !== "") {
      result[id] = value;
    } else {
      delete result[id];
    }
  }

  for (const id of removedIds) {
    delete result[id];
  }

  return result;
}
