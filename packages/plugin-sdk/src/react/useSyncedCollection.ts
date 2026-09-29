import { useCallback, useEffect, useRef, useState } from "react";
import {
  syncedCollectionSnapshotChannel,
  type SyncedCollectionDelta,
  type SyncedCollectionSnapshot,
} from "../sync/syncedCollection.js";
import { getPluginHostBridge } from "./hostBridge.js";

export interface SyncedCollectionViewOptions {
  /** False unsubscribes and stops pulling; the last items stay. Default true. */
  enabled?: boolean;
  /** The view's `disposeSignal`. Once it aborts nothing more is pulled or applied. */
  signal?: AbortSignal;
}

export interface SyncedCollectionViewResult<T> {
  /** The mirrored items in the worker's order. A new array on each commit; unchanged items keep their identity. */
  items: readonly T[];
  /** The revision `items` reflects; 0 before the first snapshot lands. */
  revision: number;
  /** True until the first snapshot lands, and while a resync is in flight. */
  loading: boolean;
  /** The last failed pull. Deltas are not applied until a pull succeeds; `resync()` retries. */
  error: Error | null;
  /** Pull a fresh snapshot, keeping deltas that arrive meanwhile. */
  resync: () => void;
}

interface Mirror<T> {
  epoch: string;
  revision: number;
  map: Map<string, T>;
}

interface ViewState<T> {
  items: readonly T[];
  revision: number;
  loading: boolean;
  error: Error | null;
}

function isDelta(value: unknown): value is SyncedCollectionDelta<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Partial<SyncedCollectionDelta<unknown>>;
  return (
    typeof d.epoch === "string" &&
    typeof d.revision === "number" &&
    Array.isArray(d.removes) &&
    Array.isArray(d.upserts)
  );
}

function isSnapshot(value: unknown): value is SyncedCollectionSnapshot<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<SyncedCollectionSnapshot<unknown>>;
  return typeof s.epoch === "string" && typeof s.revision === "number" && Array.isArray(s.entries);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function scheduleFrame(run: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(run, 16);
  return () => clearTimeout(id);
}

/**
 * The view half of `createSyncedCollection`: mirrors a worker-owned keyed
 * collection by pulling a snapshot on mount and applying the deltas pushed
 * after it.
 *
 * Pushes reach the view with no ordering guarantee against invoke results, so
 * a pull-then-subscribe view can miss a change or apply one twice. This hook
 * subscribes first, then pulls; deltas that arrive while the pull is in flight
 * are held, and once the snapshot lands every delta at or below its revision
 * is dropped as already included. A revision that skips a number, or a delta
 * from a different worker epoch (the worker restarted), means something was
 * missed, and the hook pulls again. State commits at most once per frame.
 *
 * ```tsx
 * const { items: calls, loading } = useSyncedCollection<Call>(pluginId, "calls", {
 *   signal: disposeSignal,
 * });
 * ```
 */
export function useSyncedCollection<T>(
  pluginId: string,
  channel: string,
  options: SyncedCollectionViewOptions = {}
): SyncedCollectionViewResult<T> {
  const { enabled = true, signal } = options;
  const [state, setState] = useState<ViewState<T>>(() => ({
    items: [],
    revision: 0,
    loading: true,
    error: null,
  }));
  const resyncRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled || signal?.aborted) return;

    let live = true;
    let mirror: Mirror<T> | null = null;
    // Epochs a successful pull has moved past: a late delta from a worker that
    // has since restarted is dropped instead of forcing another pull.
    const retired = new Set<string>();
    let pulling = false;
    let failed = false;
    let pullSeq = 0;
    let held: SyncedCollectionDelta<T>[] = [];
    let lastError: Error | null = null;
    let cancelCommit: (() => void) | null = null;

    const commit = (): void => {
      cancelCommit = null;
      if (!live) return;
      const m = mirror;
      setState({
        items: m ? [...m.map.values()] : [],
        revision: m?.revision ?? 0,
        loading: pulling || (m === null && !failed),
        error: failed ? lastError : null,
      });
    };
    const scheduleCommit = (): void => {
      if (!cancelCommit) cancelCommit = scheduleFrame(commit);
    };

    const apply = (delta: SyncedCollectionDelta<T>): void => {
      const m = mirror;
      if (!m || retired.has(delta.epoch)) return;
      if (delta.epoch !== m.epoch || delta.revision > m.revision + 1) {
        // Missed something: a restarted worker, or a gap in the sequence.
        pull();
        held.push(delta);
        return;
      }
      if (delta.revision <= m.revision) return;
      if (delta.reset) m.map.clear();
      for (const key of delta.removes) m.map.delete(key);
      for (const [key, item] of delta.upserts) m.map.set(key, item);
      m.revision = delta.revision;
      scheduleCommit();
    };

    const drain = (): void => {
      const pending = held;
      held = [];
      for (const delta of pending) {
        if (pulling) {
          held.push(delta);
          continue;
        }
        apply(delta);
      }
    };

    const pull = (): void => {
      if (!live) return;
      if (pulling) return;
      pulling = true;
      const seq = ++pullSeq;
      scheduleCommit();
      Promise.resolve()
        .then(() =>
          getPluginHostBridge().invoke(pluginId, syncedCollectionSnapshotChannel(channel))
        )
        .then(
          (result) => {
            if (!live || seq !== pullSeq) return;
            pulling = false;
            if (!isSnapshot(result)) {
              failed = true;
              lastError = new Error(
                `@daintreehq/plugin-sdk/react: "${syncedCollectionSnapshotChannel(channel)}" did not answer a synced-collection snapshot.`
              );
              held = [];
              scheduleCommit();
              return;
            }
            const snapshot = result as SyncedCollectionSnapshot<T>;
            if (mirror && mirror.epoch !== snapshot.epoch) retired.add(mirror.epoch);
            retired.delete(snapshot.epoch);
            mirror = {
              epoch: snapshot.epoch,
              revision: snapshot.revision,
              map: new Map(snapshot.entries),
            };
            failed = false;
            lastError = null;
            scheduleCommit();
            drain();
          },
          (err: unknown) => {
            if (!live || seq !== pullSeq) return;
            pulling = false;
            failed = true;
            lastError = toError(err);
            // Without a base to apply them to, held deltas are meaningless;
            // the next successful pull includes what they carried.
            held = [];
            scheduleCommit();
          }
        );
    };

    let off: (() => void) | null = null;
    try {
      off = getPluginHostBridge().on(pluginId, channel, (payload) => {
        if (!live || !isDelta(payload)) return;
        const delta = payload as SyncedCollectionDelta<T>;
        if (pulling || mirror === null) {
          // Before the first snapshot, or during a resync. After a failed pull
          // nothing is held: there is no base to apply it to.
          if (pulling) held.push(delta);
          return;
        }
        if (failed) return;
        apply(delta);
      });
    } catch (err) {
      failed = true;
      lastError = toError(err);
      scheduleCommit();
      return () => {
        live = false;
        cancelCommit?.();
      };
    }

    resyncRef.current = () => {
      if (!live) return;
      if (pulling) {
        // Supersede the pull in flight: its answer may predate the reason for asking.
        pulling = false;
      }
      pull();
    };
    pull();

    const stop = (): void => {
      if (!live) return;
      live = false;
      off?.();
      cancelCommit?.();
      resyncRef.current = () => {};
      signal?.removeEventListener("abort", stop);
    };
    signal?.addEventListener("abort", stop, { once: true });
    return stop;
  }, [pluginId, channel, enabled, signal]);

  const resync = useCallback(() => resyncRef.current(), []);
  return { ...state, resync };
}
