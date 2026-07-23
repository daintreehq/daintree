/**
 * Baseline-aware three-way merge for persisted store writes shared across
 * project views (issue #11351).
 *
 * The problem: every project view is its own WebContentsView / V8 context, but
 * they all share one `persist:daintree` localStorage partition. Each view
 * hydrates a persist store once, then serializes its whole in-memory snapshot
 * back over the shared key on every write. A view holding a stale snapshot
 * silently overwrites fields (or another project's map entries) that a sibling
 * view wrote more recently — the assistant hibernate anchors being the
 * highest-value casualty.
 *
 * The fix mirrors the concurrent-layout merge (#11350, `shared/utils/layoutMerge.ts`)
 * but at the localStorage write boundary and keyed by record key rather than by
 * array id. A writer's storage adapter retains the value it hydrated (or last
 * durably wrote) as its `baseline`; at write time the merger sees three inputs:
 *
 *   - `baseline`: what this writer previously knew.
 *   - `incoming`: this writer's current snapshot (what Zustand asked to persist).
 *   - `onDisk`:   the freshest shared value read immediately before the write.
 *
 * Comparing `incoming` against `baseline` makes the writer's *intent*
 * unambiguous without timestamps or tombstones, so a stale writer only ever
 * affects the keys it actually touched and never resurrects a sibling's (or its
 * own) intentional deletion. See {@link mergeRecordByWriterDelta} for the exact
 * per-key semantics.
 *
 * Critical invariant (enforced by the storage adapter, not here): after a
 * successful write the baseline advances to `incoming`, never to the merged
 * result. The merged result may contain sibling-only keys this view never took
 * into memory; folding those into the baseline would make them look like
 * intentional deletions on the next write.
 *
 * Scope / known limitations (this is the deterministic fix for the *sequential*
 * stale-writer clobber the issue reports — switch to a cached view and touch a
 * persisted store — not a general cross-process transaction):
 *   - The storage adapter's read-then-write is not atomic across renderer
 *     processes. Two views that both read the same value before either writes
 *     can still race (get/get/set/set); localStorage exposes no compare-and-swap.
 *     A fully linearizable guarantee needs a Main-process serialized owner
 *     (tracked separately) — out of scope here.
 *   - Concurrent edits to the *same* key are last-writer-wins on the whole value
 *     (e.g. two views rebasing the same hibernate session's cwd): no entry is
 *     lost, but a field-level conflict can be superseded — the same entry-level
 *     limitation `layoutMerge.ts` documents.
 *   - A deletion is only expressible for a key the writer's baseline knew. A key
 *     removed by a view that never hydrated it (e.g. project-removal cleanup
 *     fanned out to a view lacking that entry) can leave a disk-only value; it is
 *     inert (keyed by a dead id) rather than incorrect.
 */

import type { StorageValue } from "zustand/middleware";
import { deepEqualIgnoringUndefined } from "@shared/utils/layoutMerge";

export interface PersistWriteMergeContext<T> {
  /**
   * The value this writer last knew: what it hydrated, or its last durable
   * write. `null` before the first hydration read — the store-specific merger
   * normalizes that to its persisted defaults so a fresh view's untouched
   * fields are not mistaken for edits.
   */
  baseline: StorageValue<T> | null;
  /**
   * The freshest shared value read from storage immediately before this write.
   * `null` when the key is absent or its stored blob is unrecoverably corrupt.
   */
  onDisk: StorageValue<T> | null;
  /** This writer's current snapshot — the value Zustand asked to persist. */
  incoming: StorageValue<T>;
}

/**
 * Store-specific reconciler invoked at the storage layer before a merge-enabled
 * write. Returns the value that should actually be persisted. Must be pure and
 * must return `incoming.version` (the persisted schema is unchanged by a merge).
 */
export type PersistWriteMerge<T> = (context: PersistWriteMergeContext<T>) => StorageValue<T>;

/**
 * Merge one `Record<string, V>` (e.g. a `Record<projectId, session>` map) using
 * the writer's baseline to classify intent. Semantics per key:
 *
 *   - changed/added by the writer (absent from `baseline`, or `incoming` differs
 *     from `baseline`) → the incoming value wins.
 *   - unchanged by the writer and present on disk → the on-disk value is kept,
 *     preserving a sibling view's concurrent edit.
 *   - unchanged by the writer and absent from disk → dropped (a sibling deleted
 *     it and the writer has no authority to resurrect it).
 *   - present in `baseline` but absent from `incoming` → dropped (the writer
 *     intentionally deleted it), even if it still lingers on disk.
 *   - never known to the writer (absent from both `baseline` and `incoming`) but
 *     present on disk → preserved, keeping a sibling's addition.
 *
 * Content equality defaults to {@link deepEqualIgnoringUndefined} so an entry
 * that is identical after a JSON round-trip is not misread as a writer edit.
 */
export function mergeRecordByWriterDelta<V>(
  baseline: Readonly<Record<string, V>>,
  incoming: Readonly<Record<string, V>>,
  onDisk: Readonly<Record<string, V>>,
  equals: (left: V, right: V) => boolean = deepEqualIgnoringUndefined
): Record<string, V> {
  // Map lookups return `V | undefined`; a persisted record value is never
  // `undefined`, so `undefined` unambiguously means "key absent". This keeps the
  // merge sound under `noUncheckedIndexedAccess` without unsafe assertions — the
  // same convention `layoutMerge.ts` uses for its by-id map.
  const baselineMap = new Map<string, V>(Object.entries(baseline));
  const onDiskMap = new Map<string, V>(Object.entries(onDisk));
  const incomingMap = new Map<string, V>(Object.entries(incoming));
  const result: Record<string, V> = {};

  for (const [key, incomingValue] of incomingMap) {
    const baselineValue = baselineMap.get(key);
    if (baselineValue === undefined || !equals(baselineValue, incomingValue)) {
      // The writer added or changed this key since its baseline → it wins.
      result[key] = incomingValue;
    } else {
      // Unchanged by the writer: keep a sibling's concurrent on-disk value if
      // present; if a sibling deleted it, do not resurrect it.
      const onDiskValue = onDiskMap.get(key);
      if (onDiskValue !== undefined) result[key] = onDiskValue;
    }
  }

  for (const [key, onDiskValue] of onDiskMap) {
    if (incomingMap.has(key)) continue; // already decided above
    if (baselineMap.has(key)) continue; // in baseline, gone from incoming → writer deleted it
    // A sibling addition the writer never knew about → preserve it.
    result[key] = onDiskValue;
  }

  return result;
}

/**
 * Merge a fixed-shape object's scalar fields using the writer's baseline: a
 * field the writer changed wins; a field it left untouched keeps whatever a
 * sibling last wrote on disk. Unlike {@link mergeRecordByWriterDelta} this never
 * adds or drops keys — the persisted shape is fixed — so every field present in
 * `incoming` is resolved and no field is invented.
 */
export function pickFieldByWriterDelta<V>(baselineValue: V, incomingValue: V, onDiskValue: V): V {
  return deepEqualIgnoringUndefined(baselineValue, incomingValue) ? onDiskValue : incomingValue;
}
