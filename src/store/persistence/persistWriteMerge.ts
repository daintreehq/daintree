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

function hasOwn(object: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

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
  const result: Record<string, V> = {};

  for (const key of Object.keys(incoming)) {
    const incomingValue = incoming[key];
    if (!hasOwn(baseline, key) || !equals(baseline[key], incomingValue)) {
      // The writer added or changed this key since its baseline → it wins.
      result[key] = incomingValue;
    } else if (hasOwn(onDisk, key)) {
      // The writer did not touch it; a sibling may have → keep the on-disk value.
      result[key] = onDisk[key];
    }
    // else: the writer did not touch it and a sibling deleted it → do not
    // resurrect.
  }

  for (const key of Object.keys(onDisk)) {
    if (hasOwn(incoming, key)) continue; // already decided above
    if (hasOwn(baseline, key)) continue; // in baseline, gone from incoming → writer deleted it
    // A sibling addition the writer never knew about → preserve it.
    result[key] = onDisk[key];
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
