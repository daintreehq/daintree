import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { getPluginHostBridge } from "./hostBridge.js";

export interface CachedHostChannelOptions {
  /**
   * How long a cached result counts as fresh, in ms. A fresh entry is painted
   * without revalidating; a stale one is painted and then revalidated. Default
   * 0: always revalidate on mount, but never wait for it to paint.
   */
  staleMs?: number;
  /**
   * Cache key for `args`. Omitted, `args` is encoded with sorted object keys,
   * which requires plain data (primitives, arrays, plain objects); pass a key
   * when they are not, or when a cheaper identity is at hand.
   */
  cacheKey?: string;
  /**
   * The view's `disposeSignal` (or a {@link ViewScope}'s `signal`). Once it
   * aborts the hook starts no further requests and `revalidate()` resolves
   * `undefined`. A request already sent still completes and fills the cache for
   * the next mount — the host bridge has no cancellation.
   */
  signal?: AbortSignal;
  /** False skips fetching (the cached value, if any, is still returned). Default true. */
  enabled?: boolean;
  /**
   * A push channel (`host.postToPanel(channel, …)` broadcast) that means "this
   * result is stale", or several of them. Each push on any of them marks the
   * cached result stale and schedules a refetch; a burst of them within
   * `debounceMs` of each other, across every listed channel, costs one. The
   * mark outlives the view: if every view unmounts before the refetch runs, the
   * next mount refetches regardless of `staleMs`. The payload is ignored. An
   * array is compared by its contents, so an inline literal does not
   * resubscribe on every render.
   */
  invalidateOn?: string | readonly string[];
  /**
   * Quiet time after the last invalidation before refetching, in ms. Default
   * 100. An invalidation that lands while a request is in flight queues one
   * more request after it rather than superseding it, so a continuous stream of
   * changes still settles on fresh data without abandoning every answer.
   */
  debounceMs?: number;
}

export interface CachedHostChannelResult<TResult> {
  /** The latest successful result, cached or fresh; `undefined` until the first one lands. */
  data: TResult | undefined;
  /** The latest failure. `data` keeps the last good result alongside it. */
  error: Error | null;
  /** True while a request for this key is in flight, including background revalidation. */
  validating: boolean;
  /** When `data` was fetched (epoch ms), or 0 if never. */
  updatedAt: number;
  /**
   * Fetch now, superseding any request in flight for this key (use after a
   * mutation). Resolves the new result, or `undefined` if it failed, was
   * superseded, or the signal had aborted.
   */
  revalidate: () => Promise<TResult | undefined>;
}

interface CacheState {
  readonly data: unknown;
  readonly error: Error | null;
  readonly validating: boolean;
  readonly updatedAt: number;
}

interface InFlight {
  readonly seq: number;
  readonly promise: Promise<unknown>;
}

/**
 * Entries kept once no view is subscribed to them. Entries a mounted view is
 * showing, or with a request in flight, are kept on top of this.
 */
export const HOST_CHANNEL_CACHE_LIMIT = 50;

// Marked pure so a view that never calls the hook tree-shakes it away.
const EMPTY: CacheState = /* @__PURE__ */ Object.freeze({
  data: undefined,
  error: null,
  validating: false,
  updatedAt: 0,
});

// Map insertion order doubles as recency: a read re-inserts the key.
const states = new Map<string, CacheState>();
const listeners = new Map<string, Set<() => void>>();
const inFlight = new Map<string, InFlight>();
// Keys an invalidation has marked stale, with the sequence number it drew.
// Kept apart from views and timers: a view that unmounts before its debounced
// refetch fires cancels the refetch, not the mark, so the next mount refetches
// whatever its `staleMs`. Only a request started after the mark clears it.
const staleMarks = new Map<string, number>();
let nextSeq = 0;

interface InvalidationSubscriber {
  refetch: () => Promise<unknown>;
}

interface Invalidation {
  timer: ReturnType<typeof setTimeout> | null;
  queued: boolean;
  /** Views on this key still listening: mounted, enabled, signal not aborted. */
  subscribers: Set<InvalidationSubscriber>;
}

// One per cache key, shared by every mounted view showing it, so two views on
// the same key and channel refetch once per burst, not once each.
const invalidations = new Map<string, Invalidation>();

function invalidationFor(key: string): Invalidation {
  let entry = invalidations.get(key);
  if (!entry) {
    entry = { timer: null, queued: false, subscribers: new Set() };
    invalidations.set(key, entry);
  }
  return entry;
}

/** Refetch through a view still listening; none left means nobody wants it. */
function runInvalidation(key: string, entry: Invalidation): void {
  const [subscriber] = entry.subscribers;
  if (!subscriber || invalidations.get(key) !== entry) return;
  void subscriber.refetch();
}

function invalidate(key: string, debounceMs: number): void {
  staleMarks.set(key, ++nextSeq);
  const entry = invalidations.get(key);
  if (!entry) return;
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const busy = inFlight.get(key);
    if (!busy) {
      runInvalidation(key, entry);
      return;
    }
    // One follow-up behind the request in flight, which covers every push up
    // to the moment it starts — including ones whose own timer is still armed.
    if (entry.queued) return;
    entry.queued = true;
    void busy.promise.finally(() => {
      entry.queued = false;
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
      runInvalidation(key, entry);
    });
  }, debounceMs);
}

function leaveInvalidation(key: string, subscriber: InvalidationSubscriber): void {
  const entry = invalidations.get(key);
  if (!entry) return;
  entry.subscribers.delete(subscriber);
  if (entry.subscribers.size > 0) return;
  if (entry.timer !== null) clearTimeout(entry.timer);
  invalidations.delete(key);
}

function touch(key: string): CacheState | undefined {
  const state = states.get(key);
  if (state) {
    states.delete(key);
    states.set(key, state);
  }
  return state;
}

function evict(): void {
  // Oldest first. A key a mounted view is showing, or one with a request in
  // flight, is never dropped — its view would keep painting data the cache no
  // longer tracks — so the bound applies to entries nobody is using.
  for (const key of states.keys()) {
    if (states.size <= HOST_CHANNEL_CACHE_LIMIT) return;
    if (!listeners.has(key) && !inFlight.has(key)) {
      states.delete(key);
      staleMarks.delete(key);
    }
  }
}

function write(key: string, next: CacheState): void {
  states.delete(key);
  states.set(key, next);
  evict();
  const subs = listeners.get(key);
  if (subs) for (const notify of [...subs]) notify();
}

function subscribeKey(key: string, notify: () => void): () => void {
  let subs = listeners.get(key);
  if (!subs) listeners.set(key, (subs = new Set()));
  subs.add(notify);
  return () => {
    subs.delete(notify);
    if (subs.size === 0 && listeners.get(key) === subs) listeners.delete(key);
    evict();
  };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function request(
  key: string,
  pluginId: string,
  channel: string,
  args: unknown,
  supersede: boolean
): Promise<unknown> {
  const current = inFlight.get(key);
  // A request sent before the latest invalidation cannot answer it.
  const mark = staleMarks.get(key);
  if (current && !supersede && (mark === undefined || mark < current.seq)) return current.promise;
  const seq = ++nextSeq;
  const prev = states.get(key) ?? EMPTY;
  if (!prev.validating) write(key, { ...prev, validating: true });
  // Deferred through a microtask so a bridge that throws synchronously (no
  // `window.electron`) lands in the rejection path like any host error.
  const promise = Promise.resolve()
    .then(() => getPluginHostBridge().invoke(pluginId, channel, args))
    .then(
      (data) => {
        if (inFlight.get(key)?.seq !== seq) return undefined;
        inFlight.delete(key);
        const marked = staleMarks.get(key);
        if (marked !== undefined && marked < seq) staleMarks.delete(key);
        write(key, { data, error: null, validating: false, updatedAt: Date.now() });
        return data;
      },
      (err: unknown) => {
        if (inFlight.get(key)?.seq !== seq) return undefined;
        inFlight.delete(key);
        const base = states.get(key) ?? EMPTY;
        write(key, { ...base, error: toError(err), validating: false });
        return undefined;
      }
    );
  inFlight.set(key, { seq, promise });
  return promise;
}

// Tagged so values the host tells apart never share a key: `{ a: undefined }`
// vs `{}`, `NaN` vs `null`, `-0` vs `0`, `"1"` vs `1`. Anything beyond plain
// data (a Date, a Map, a class instance, a cycle) throws and asks for a key.
function encodeArgs(value: unknown, seen: Set<object>): string {
  switch (typeof value) {
    case "undefined":
      return "u";
    case "boolean":
      return value ? "t" : "f";
    case "number":
      return Object.is(value, -0) ? "n-0" : `n${String(value)}`;
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (value === null) return "z";
      if (seen.has(value)) throw new TypeError("cyclic args");
      seen.add(value);
      let out: string;
      if (Array.isArray(value)) {
        out = `[${value.map((v) => encodeArgs(v, seen)).join(",")}]`;
      } else {
        const proto = Object.getPrototypeOf(value) as unknown;
        if (proto !== Object.prototype && proto !== null) throw new TypeError("non-plain args");
        const record = value as Record<string, unknown>;
        out = `{${Object.keys(record)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${encodeArgs(record[k], seen)}`)
          .join(",")}}`;
      }
      seen.delete(value);
      return out;
    }
    default:
      throw new TypeError("unserialisable args");
  }
}

function cacheKeyFor(pluginId: string, channel: string, args: unknown, cacheKey?: string): string {
  let argsKey = cacheKey;
  if (argsKey === undefined) {
    try {
      argsKey = encodeArgs(args, new Set());
    } catch {
      throw new Error(
        `@daintreehq/plugin-sdk/react: useCachedHostChannel could not serialise the args for "${channel}"; pass options.cacheKey.`
      );
    }
  }
  return JSON.stringify([pluginId, channel, argsKey]);
}

/** The listed push channels, deduplicated, as a string that changes only with them. */
function invalidationChannelsKey(invalidateOn: unknown): string {
  const list: unknown[] =
    typeof invalidateOn === "string"
      ? [invalidateOn]
      : Array.isArray(invalidateOn)
        ? invalidateOn
        : [];
  const channels = [
    ...new Set(list.filter((c): c is string => typeof c === "string" && c.length > 0)),
  ];
  return channels.length > 0 ? JSON.stringify(channels) : "";
}

/**
 * Paint-first companion to {@link useHostChannel}: returns the cached result
 * for `(pluginId, channel, args)` immediately and revalidates it in the
 * background, so reopening a view shows its last data in the first frame
 * instead of a spinner.
 *
 * The cache is module-level, shared by every view in the bundle, and bounded:
 * beyond the entries mounted views are showing, at most
 * {@link HOST_CHANNEL_CACHE_LIMIT}, least recently used evicted first. Concurrent mounts of the same key share
 * one request. Results are structured-clone copies from the host, shared by
 * reference between views — treat them as immutable.
 *
 * ```tsx
 * const { data, error, validating } = useCachedHostChannel<{ repo: string }, Pr[]>(
 *   pluginId, "list-prs", { repo }, { staleMs: 30_000, signal: disposeSignal },
 * );
 * ```
 *
 * With `invalidateOn`, a push on that channel marks the result stale and a
 * burst of pushes refetches once — the shape for a database `onDidChange` the
 * worker forwards as `host.postToPanel("notes-changed", null)`:
 *
 * ```tsx
 * const { data: notes } = useCachedHostChannel<null, Note[]>(pluginId, "list-notes", null, {
 *   invalidateOn: "notes-changed",
 *   debounceMs: 100,
 * });
 * ```
 *
 * A result that more than one change makes stale lists every channel, and a
 * burst across them still costs one refetch:
 *
 * ```tsx
 * useCachedHostChannel<null, Summary>(pluginId, "summary", null, {
 *   invalidateOn: ["entries-changed", "accounts-changed"],
 * });
 * ```
 */
export function useCachedHostChannel<TArgs = unknown, TResult = unknown>(
  pluginId: string,
  channel: string,
  args: TArgs,
  options: CachedHostChannelOptions = {}
): CachedHostChannelResult<TResult> {
  const { staleMs = 0, cacheKey, signal, enabled = true, invalidateOn, debounceMs = 100 } = options;
  const key = cacheKeyFor(pluginId, channel, args, cacheKey);
  const invalidateKey = invalidationChannelsKey(invalidateOn);

  const subscribe = useCallback((notify: () => void) => subscribeKey(key, notify), [key]);
  const getSnapshot = useCallback(() => states.get(key) ?? EMPTY, [key]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // `args` travels through a ref and the effects are keyed by `key`, so a
  // fresh-but-equal args object each render neither refetches nor re-runs them.
  const argsRef = useRef(args);
  useEffect(() => {
    argsRef.current = args;
  });

  useEffect(() => {
    if (!enabled || signal?.aborted) return;
    const cached = touch(key);
    const fresh =
      cached !== undefined &&
      cached.updatedAt > 0 &&
      Date.now() - cached.updatedAt < staleMs &&
      !staleMarks.has(key);
    if (fresh) return;
    void request(key, pluginId, channel, argsRef.current, false);
  }, [key, enabled, staleMs, signal, pluginId, channel]);

  useEffect(() => {
    if (!invalidateKey || !enabled || signal?.aborted) return;
    const wait = Math.max(0, debounceMs);
    const args = argsRef;
    const subscriber: InvalidationSubscriber = {
      refetch: () => request(key, pluginId, channel, args.current, true),
    };
    invalidationFor(key).subscribers.add(subscriber);
    const bridge = getPluginHostBridge();
    const offs = (JSON.parse(invalidateKey) as string[]).map((pushChannel) =>
      bridge.on(pluginId, pushChannel, () => {
        if (signal?.aborted) return;
        invalidate(key, wait);
      })
    );
    // An aborted view stops counting at once, so a refetch it scheduled runs
    // only if a sibling on the same key is still listening.
    const leave = (): void => leaveInvalidation(key, subscriber);
    signal?.addEventListener("abort", leave, { once: true });
    return () => {
      for (const off of offs) off();
      signal?.removeEventListener("abort", leave);
      leave();
    };
  }, [invalidateKey, enabled, signal, debounceMs, key, pluginId, channel]);

  const revalidate = useCallback(async (): Promise<TResult | undefined> => {
    if (signal?.aborted) return undefined;
    return (await request(key, pluginId, channel, argsRef.current, true)) as TResult | undefined;
  }, [key, signal, pluginId, channel]);

  return {
    data: state.data as TResult | undefined,
    error: state.error,
    validating: state.validating,
    updatedAt: state.updatedAt,
    revalidate,
  };
}

/**
 * Drop every cached result, in-flight request, stale mark and scheduled
 * refetch. For tests: the cache is module-global, shared by every view in the
 * bundle, so without a reset in `beforeEach` one test's results paint first in
 * the next. A view still mounted re-renders with no data and keeps its
 * subscriptions; it fetches again on `revalidate()`, an invalidation or its
 * next mount. A response to a request dropped here is discarded.
 */
export function resetHostChannelCache(): void {
  states.clear();
  inFlight.clear();
  staleMarks.clear();
  // A fresh entry per key, with the same views listening: a follow-up queued
  // behind a dropped request checks its entry is current and finds it is not.
  for (const [key, entry] of [...invalidations]) {
    if (entry.timer !== null) clearTimeout(entry.timer);
    invalidations.set(key, { timer: null, queued: false, subscribers: entry.subscribers });
  }
  for (const subs of [...listeners.values()]) for (const notify of [...subs]) notify();
}
