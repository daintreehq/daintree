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
 *
 * A change set too large for one push is split across consecutive revisions,
 * each applied like any other delta. One that cannot be split small enough (a
 * single item over the limit) is replaced by a `resync` delta.
 */
export interface SyncedCollectionDelta<T> {
  epoch: string;
  revision: number;
  /** True when the collection was replaced wholesale; `upserts` then holds every item. */
  reset?: boolean;
  /**
   * True when the changes at this revision could not be pushed (too large):
   * `removes` and `upserts` are empty, and a view holding an older revision
   * pulls a fresh snapshot instead of applying it.
   */
  resync?: boolean;
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
  /**
   * Largest delta sent in one push, estimated as JSON length. Default 512 KiB,
   * half the host's 1 MiB push cap (`PLUGIN_PUSH_MAX_PAYLOAD_BYTES` in the
   * host's `shared/config/pluginBudgets.ts`), leaving room for multi-byte text
   * the estimate undercounts. Larger change sets are split across consecutive
   * revisions; an item that alone exceeds it makes views resync instead.
   */
  maxDeltaBytes?: number;
}

// Half the host's `PLUGIN_PUSH_MAX_PAYLOAD_BYTES` (1 MiB, in the host's
// `shared/config/pluginBudgets.ts`), which the SDK cannot import.
const SYNCED_COLLECTION_MAX_DELTA_BYTES = 512 * 1024;

// The host's rejection for a push over its cap starts with this code.
const PAYLOAD_TOO_LARGE_PREFIX = "PLUGIN_PAYLOAD_TOO_LARGE:";

// Room for the envelope: epoch, revision, flags and the array brackets.
const DELTA_OVERHEAD_BYTES = 256;

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Not JSON-representable (a BigInt, a cycle): the host measures it; a
    // rejection still ends in a resync.
    return 0;
  }
}

function isPayloadTooLarge(error: unknown): boolean {
  // Duck-typed: a rejection relayed from another process may not be an Error.
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return message.startsWith(PAYLOAD_TOO_LARGE_PREFIX);
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
  const maxDeltaBytes = Math.max(1, options.maxDeltaBytes ?? SYNCED_COLLECTION_MAX_DELTA_BYTES);
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
  const clearPending = (): void => {
    pendingReset = false;
    pendingRemoves.clear();
    pendingUpserts.clear();
  };

  const resyncDelta = (at: number): SyncedCollectionDelta<T> => ({
    epoch,
    revision: at,
    resync: true,
    removes: [],
    upserts: [],
  });

  /**
   * The pending changes as deltas under the push limit, applied in order to
   * the same effect as one. `null` when an item alone is over it.
   */
  const chunkPending = (): Array<Omit<SyncedCollectionDelta<T>, "epoch" | "revision">> | null => {
    type Chunk = Omit<SyncedCollectionDelta<T>, "epoch" | "revision">;
    const chunks: Chunk[] = [];
    let current: Chunk = { removes: [], upserts: [] };
    if (pendingReset) current.reset = true;
    let bytes = DELTA_OVERHEAD_BYTES;
    const room = (cost: number): void => {
      if (bytes + cost <= maxDeltaBytes) return;
      if (current.removes.length === 0 && current.upserts.length === 0 && !current.reset) return;
      chunks.push(current);
      current = { removes: [], upserts: [] };
      bytes = DELTA_OVERHEAD_BYTES;
    };
    if (!pendingReset) {
      for (const k of pendingRemoves) {
        const cost = jsonLength(k) + 1;
        if (DELTA_OVERHEAD_BYTES + cost > maxDeltaBytes) return null;
        room(cost);
        current.removes.push(k);
        bytes += cost;
      }
    }
    for (const entry of pendingUpserts) {
      const cost = jsonLength(entry) + 1;
      if (DELTA_OVERHEAD_BYTES + cost > maxDeltaBytes) return null;
      room(cost);
      current.upserts.push(entry);
      bytes += cost;
    }
    chunks.push(current);
    return chunks;
  };

  const flushNow = (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!dirty()) return lastPost;
    // Before the first pull no view can be holding a snapshot to apply this
    // to: a view subscribes, then pulls, and drops every delta at or below the
    // revision it pulled. The revision still advances.
    if (!pulled || disposed) {
      revision++;
      clearPending();
      return lastPost;
    }
    const chunks = chunkPending();
    clearPending();
    if (chunks === null) {
      revision++;
      lastPost = send(resyncDelta(revision), 0);
      return lastPost;
    }
    const sends = chunks.map((chunk) => {
      revision++;
      return send({ epoch, revision, ...chunk }, 0);
    });
    lastPost = Promise.all(sends).then(() => {});
    return lastPost;
  };

  // A lost delta with nothing after it would leave views stale with no gap to
  // notice, so the newest one is retried. Once a later delta exists, that one
  // carries the gap and the view resyncs on it. A delta the host refused as too
  // large would be refused again, so it is replaced by a resync delta instead.
  const send = (delta: SyncedCollectionDelta<T>, attempt: number): Promise<void> =>
    host.postToPanel(channel, delta).catch((error: unknown) => {
      if (!warned) {
        warned = true;
        console.warn(`[synced-collection] pushing "${channel}" failed.`, error);
      }
      if (disposed) return;
      if (isPayloadTooLarge(error)) {
        if (delta.resync || revision !== delta.revision) return;
        revision++;
        lastPost = send(resyncDelta(revision), 0);
        return;
      }
      if (attempt >= 3) return;
      setTimeout(
        () => {
          if (!disposed && revision === delta.revision) void send(delta, attempt + 1);
        },
        1000 * 2 ** attempt
      );
    });

  const touch = (): void => {
    if (disposed) {
      clearPending();
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
      clearPending();
    },
  };
}
