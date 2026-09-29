/**
 * What the `<channel>-snapshot` invoke answers: the whole collection at one
 * revision. `entries` are `[key, item]` pairs in the collection's order, so a
 * view applies deltas without knowing how items are keyed.
 */
export interface SyncedCollectionSnapshot<T> {
  /** Identifies one worker-side collection instance. A restarted worker has a new epoch. */
  epoch: string;
  revision: number;
  entries: Array<[string, T]>;
}

/**
 * One change set pushed on `<channel>`. Revisions within an epoch are
 * consecutive, so a view that sees `revision` skip a number knows it missed a
 * delta. Apply in order: `reset` (clear everything), then `removes`, then
 * `upserts` — a key already present keeps its position, a new one is appended.
 */
export interface SyncedCollectionDelta<T> {
  epoch: string;
  revision: number;
  /** True when the collection was replaced wholesale; `upserts` then holds every item. */
  reset?: boolean;
  removes: string[];
  upserts: Array<[string, T]>;
}

export interface SyncedCollectionOptions<T> {
  /** The item's stable identity. Must be a string, unique within the collection. */
  key: (item: T) => string;
  /** Items the collection starts with. */
  initial?: Iterable<T>;
  /**
   * How long changes are gathered into one delta, in ms. Default 16: a loop
   * that upserts 20,000 items sends one message, not 20,000. 0 still batches
   * everything done in the same task.
   */
  flushMs?: number;
}

/** A keyed collection a worker owns and plugin views mirror with `useSyncedCollection`. */
export interface SyncedCollection<T> {
  /** The push channel. The snapshot handler is registered as `snapshotChannel`. */
  readonly channel: string;
  readonly snapshotChannel: string;
  /** The revision of the last delta sent (or skipped because nobody had pulled yet). */
  readonly revision: number;
  readonly size: number;
  get(key: string): T | undefined;
  has(key: string): boolean;
  /** The items in order. A new array each call. */
  values(): T[];
  /** Add an item, or replace the one with the same key in place. */
  upsert(item: T): void;
  upsertMany(items: Iterable<T>): void;
  /** Remove by key. Returns whether the key was present. */
  remove(key: string): boolean;
  removeMany(keys: Iterable<string>): void;
  /** Replace the whole collection; views receive one `reset` delta. */
  replace(items: Iterable<T>): void;
  clear(): void;
  /** Send pending changes now instead of at the end of the `flushMs` window. */
  flush(): Promise<void>;
  /** Stop sending deltas. The snapshot channel keeps answering until the plugin unloads. */
  dispose(): void;
}

/**
 * The two host calls a synced collection makes. `PluginHostApi` satisfies it,
 * and so does `createMockHost` from `/testing`.
 */
export interface SyncedCollectionHost {
  registerHandler(channel: string, handler: (...args: unknown[]) => unknown): Promise<void>;
  postToPanel(channel: string, payload: unknown): Promise<void>;
}

/** The invoke channel a synced collection's snapshot is served on. */
export function syncedCollectionSnapshotChannel(channel: string): string {
  return `${channel}-snapshot`;
}

function newEpoch(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The worker half of "pull on mount, then push deltas". Registers a
 * `<channel>-snapshot` handler that answers `{ epoch, revision, entries }` and
 * pushes `{ epoch, revision, reset?, removes, upserts }` on `channel` as the
 * collection changes, gathering changes made within `flushMs` into one
 * message. Pair it with `useSyncedCollection(pluginId, channel)` in the view,
 * which handles the ordering races between the pull and the pushes.
 *
 * Pushing the whole list on every change costs the square of its length over
 * its lifetime; a delta costs only what changed.
 *
 * ```ts
 * export async function activate(host: PluginHostApi) {
 *   const calls = await createSyncedCollection(host, "calls", { key: (c: Call) => c.id });
 *   // …on every tool call:
 *   calls.upsert(call);
 *   return () => calls.dispose();
 * }
 * ```
 *
 * Call it during `activate()`: it registers a handler, which the host allows
 * only then. Apart from one empty delta announcing this instance (so a view
 * left over from a previous worker resyncs), nothing is pushed until a view
 * has pulled a snapshot: a plugin whose panel was never opened sends no deltas.
 */
export async function createSyncedCollection<T>(
  host: SyncedCollectionHost,
  channel: string,
  options: SyncedCollectionOptions<T>
): Promise<SyncedCollection<T>> {
  const { key } = options;
  const flushMs = Math.max(0, options.flushMs ?? 16);
  const snapshotChannel = syncedCollectionSnapshotChannel(channel);
  const epoch = newEpoch();

  const items = new Map<string, T>();
  for (const item of options.initial ?? []) items.set(key(item), item);

  let revision = 0;
  let pulled = false;
  let disposed = false;
  let pendingReset = false;
  const pendingRemoves = new Set<string>();
  const pendingUpserts = new Map<string, T>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPost: Promise<void> = Promise.resolve();
  let warned = false;

  const dirty = (): boolean => pendingReset || pendingRemoves.size > 0 || pendingUpserts.size > 0;

  const flushNow = (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!dirty()) return lastPost;
    revision++;
    const delta: SyncedCollectionDelta<T> = {
      epoch,
      revision,
      removes: pendingReset ? [] : [...pendingRemoves],
      upserts: [...pendingUpserts],
    };
    if (pendingReset) delta.reset = true;
    pendingReset = false;
    pendingRemoves.clear();
    pendingUpserts.clear();
    // Before the first pull no view can be holding a snapshot to apply this
    // to: a view subscribes, then pulls, and drops every delta at or below the
    // revision it pulled. The revision still advances.
    if (!pulled || disposed) return lastPost;
    lastPost = send(delta, 0);
    return lastPost;
  };

  // A lost delta with nothing after it would leave views stale with no gap to
  // notice, so the newest one is retried. Once a later delta exists, that one
  // carries the gap and the view resyncs on it.
  const send = (delta: SyncedCollectionDelta<T>, attempt: number): Promise<void> =>
    host.postToPanel(channel, delta).catch((error: unknown) => {
      if (!warned) {
        warned = true;
        console.warn(`[synced-collection] pushing "${channel}" failed.`, error);
      }
      if (attempt >= 3 || disposed) return;
      setTimeout(
        () => {
          if (!disposed && revision === delta.revision) void send(delta, attempt + 1);
        },
        1000 * 2 ** attempt
      );
    });

  const touch = (): void => {
    if (disposed) {
      pendingReset = false;
      pendingRemoves.clear();
      pendingUpserts.clear();
      return;
    }
    if (timer === null) timer = setTimeout(() => void flushNow(), flushMs);
  };

  const upsert = (item: T): void => {
    const k = key(item);
    items.set(k, item);
    pendingUpserts.set(k, item);
    touch();
  };

  const remove = (k: string): boolean => {
    if (!items.has(k)) return false;
    items.delete(k);
    pendingUpserts.delete(k);
    // Kept even when the key comes straight back: a remove then re-add moves
    // it to the end here, and only a remove before the upsert does the same in
    // the view.
    if (!pendingReset) pendingRemoves.add(k);
    touch();
    return true;
  };

  const replace = (next: Iterable<T>): void => {
    items.clear();
    pendingRemoves.clear();
    pendingUpserts.clear();
    pendingReset = true;
    for (const item of next) {
      const k = key(item);
      items.set(k, item);
      pendingUpserts.set(k, item);
    }
    touch();
  };

  await host.registerHandler(snapshotChannel, (): SyncedCollectionSnapshot<T> => {
    // Send what is pending first so the snapshot's revision covers it: a
    // pending change would otherwise be in `entries` and again in the next
    // delta under a revision the view has not seen.
    pulled = true;
    void flushNow();
    return { epoch, revision, entries: [...items] };
  });

  // Announce the epoch. A view still showing a previous worker's snapshot has
  // no reason to pull again, and this worker sends it nothing until someone
  // pulls; an empty delta from an unknown epoch makes it resync. Views on this
  // epoch drop it, since revision 0 is at or below any snapshot.
  void host
    .postToPanel(channel, {
      epoch,
      revision,
      removes: [],
      upserts: [],
    } satisfies SyncedCollectionDelta<T>)
    .catch(() => {});

  return {
    channel,
    snapshotChannel,
    get revision() {
      return revision;
    },
    get size() {
      return items.size;
    },
    get: (k) => items.get(k),
    has: (k) => items.has(k),
    values: () => [...items.values()],
    upsert,
    upsertMany(next) {
      for (const item of next) upsert(item);
    },
    remove,
    removeMany(keys) {
      for (const k of keys) remove(k);
    },
    replace,
    clear: () => replace([]),
    flush: flushNow,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pendingReset = false;
      pendingRemoves.clear();
      pendingUpserts.clear();
    },
  };
}
