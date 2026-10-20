interface Entry<T> {
  value: T;
  at: number;
}

export interface BoundedCacheOptions {
  /** Most entries held at once; the least recently used goes first. */
  maxEntries: number;
  /**
   * How long an entry stays resident after it was written. Freshness is
   * decided per read; this only bounds how long an entry can be kept for
   * {@link BoundedCache.peek} or a later fresh read.
   */
  retainMs: number;
}

/**
 * A string-keyed cache with a hard entry cap and a residency bound. Expired
 * entries are released by {@link BoundedCache.sweep} without their own key
 * being read again. `undefined` is a miss; `null` is a value, so negative
 * results stay cacheable.
 */
export class BoundedCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly options: BoundedCacheOptions) {}

  get size(): number {
    return this.entries.size;
  }

  /** The value if it was written within `freshMs`, bumping its recency. */
  get(key: string, freshMs: number, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const age = now - entry.at;
    if (age > this.options.retainMs) {
      this.entries.delete(key);
      return undefined;
    }
    if (age > freshMs) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** The value regardless of freshness, as long as it is still resident. */
  peek(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.at > this.options.retainMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: now });
    if (this.entries.size <= this.options.maxEntries) return;
    this.sweep(now);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.options.maxEntries) break;
      this.entries.delete(oldest);
    }
  }

  /** Release every entry past its residency bound. */
  sweep(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at > this.options.retainMs) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
