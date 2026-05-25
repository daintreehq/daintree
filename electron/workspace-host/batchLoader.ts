/**
 * Host-side request coalescer for the workspace-host UtilityProcess.
 *
 * The CodeForge migration routed every provider call through {@link
 * ForgeBridge}, which removed the per-call dedup the old single-file GitHub
 * path had. `BatchLoader` restores it: `load(key)` calls made within one
 * event-loop tick are gathered into a single `batchLoadFn` invocation, and a
 * key already in flight from a prior tick shares the pending promise rather
 * than firing a second call (single-flight). There is no persistent value
 * cache — `PullRequestService` is a polling service, so a settled key is
 * evicted immediately and the next poll re-fetches.
 *
 * Scheduling uses a microtask → `process.nextTick` hybrid: the microtask
 * drains every synchronously-enqueued `load()` (and any awaited siblings in
 * the same chain) before the batch dispatches on the nextTick phase. Bare
 * `process.nextTick` fires before sibling promises resolve and would fragment
 * a fan-out across async chains; `queueMicrotask` alone fires too eagerly.
 *
 * Caller trap: `await load(a); await load(b)` never coalesces — the first
 * await drains the microtask queue and dispatches before `b` is enqueued.
 * Callers that want coalescing must enqueue synchronously (a fire-and-forget
 * `for` loop) or use `Promise.all([load(a), load(b)])`.
 */

const DEFAULT_MAX_BATCH_SIZE = 100;

/**
 * Resolves a batch of keys to a 1:1 result array. The function must always
 * resolve, never reject as a whole — return an `Error` in a slot to reject
 * just that key while the others resolve. A thrown/rejected batch function is
 * treated as a failure of every key in the chunk.
 */
export type BatchLoadFn<K, V> = (keys: readonly K[]) => Promise<ReadonlyArray<V | Error>>;

export interface BatchLoaderOptions<K> {
  /**
   * Maps a key to its dedup string. Defaults to `String(key)`, which is
   * correct for primitive keys (numbers, strings). Object keys need an
   * explicit deterministic builder — never `JSON.stringify` (property order
   * is not guaranteed).
   */
  cacheKeyFn?: (key: K) => string;
  /** Maximum keys per `batchLoadFn` call. Larger batches chunk into concurrent calls. Default 100. */
  maxBatchSize?: number;
}

interface Deferred<V> {
  resolve: (value: V) => void;
  reject: (error: Error) => void;
}

interface QueueEntry<K> {
  key: K;
  cacheKey: string;
}

export class BatchLoader<K, V> {
  private readonly cacheKeyFn: (key: K) => string;
  private readonly maxBatchSize: number;
  private queue: QueueEntry<K>[] = [];
  // In-flight single-flight map: a key present here has a pending promise that
  // later `load()` calls reuse. Evicted on settle so the next poll re-fetches.
  private readonly inFlight = new Map<string, Promise<V>>();
  private readonly pending = new Map<string, Deferred<V>>();
  private dispatchQueued = false;
  private isDisposed = false;

  constructor(
    private readonly batchLoadFn: BatchLoadFn<K, V>,
    options: BatchLoaderOptions<K> = {}
  ) {
    this.cacheKeyFn = options.cacheKeyFn ?? ((key) => String(key));
    const size = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxBatchSize = size > 0 ? size : DEFAULT_MAX_BATCH_SIZE;
  }

  load(key: K): Promise<V> {
    if (this.isDisposed) {
      return Promise.reject(new Error("BatchLoader disposed"));
    }

    const cacheKey = this.cacheKeyFn(key);
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    let resolveFn!: (value: V) => void;
    let rejectFn!: (error: Error) => void;
    const promise = new Promise<V>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this.inFlight.set(cacheKey, promise);
    this.pending.set(cacheKey, { resolve: resolveFn, reject: rejectFn });
    this.queue.push({ key, cacheKey });
    // Set the reentrancy guard synchronously (lesson #4703) so a second load()
    // in the same stack frame doesn't schedule a duplicate dispatch.
    this.scheduleDispatch();
    return promise;
  }

  /** Cancel everything. Pending loads reject; later loads reject synchronously. */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    const error = new Error("BatchLoader disposed");
    for (const deferred of this.pending.values()) {
      deferred.reject(error);
    }
    this.pending.clear();
    this.inFlight.clear();
    this.queue = [];
  }

  private scheduleDispatch(): void {
    if (this.dispatchQueued) return;
    this.dispatchQueued = true;
    void Promise.resolve().then(() => {
      process.nextTick(() => this.dispatch());
    });
  }

  private dispatch(): void {
    this.dispatchQueued = false;
    if (this.isDisposed || this.queue.length === 0) return;

    const batch = this.queue;
    this.queue = [];

    // Chunk synchronously at dispatch time: an over-sized batch fans out into
    // concurrent batchLoadFn calls rather than deferring the overflow.
    for (let i = 0; i < batch.length; i += this.maxBatchSize) {
      this.dispatchChunk(batch.slice(i, i + this.maxBatchSize));
    }
  }

  private dispatchChunk(chunk: QueueEntry<K>[]): void {
    const keys = chunk.map((entry) => entry.key);
    this.batchLoadFn(keys).then(
      (results) => {
        if (this.isDisposed) return;
        if (results.length !== chunk.length) {
          const error = new Error(
            `BatchLoader batch function returned ${results.length} results for ${chunk.length} keys`
          );
          for (const entry of chunk) this.settleReject(entry.cacheKey, error);
          return;
        }
        for (let i = 0; i < chunk.length; i++) {
          const result = results[i];
          if (result instanceof Error) {
            this.settleReject(chunk[i].cacheKey, result);
          } else {
            this.settleResolve(chunk[i].cacheKey, result as V);
          }
        }
      },
      (error: unknown) => {
        if (this.isDisposed) return;
        const wrapped = error instanceof Error ? error : new Error(String(error));
        for (const entry of chunk) this.settleReject(entry.cacheKey, wrapped);
      }
    );
  }

  private settleResolve(cacheKey: string, value: V): void {
    this.inFlight.delete(cacheKey);
    const deferred = this.pending.get(cacheKey);
    if (!deferred) return;
    this.pending.delete(cacheKey);
    deferred.resolve(value);
  }

  private settleReject(cacheKey: string, error: Error): void {
    this.inFlight.delete(cacheKey);
    const deferred = this.pending.get(cacheKey);
    if (!deferred) return;
    this.pending.delete(cacheKey);
    deferred.reject(error);
  }
}
