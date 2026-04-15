/**
 * Generic TTL-aware LRU cache with memory limits
 * Migrated from Daintree CLI for Electron main process.
 */

export interface CacheOptions {
  maxSize?: number;
  defaultTTL?: number;
  onEvict?: (key: unknown, value: unknown) => void;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  lastAccessed: number;
}

export class Cache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly defaultTTL: number;
  private readonly onEvict?: (key: K, value: V) => void;
  private hits: number = 0;
  private misses: number = 0;

  constructor(options: CacheOptions = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.defaultTTL = options.defaultTTL ?? 5000; // 5 seconds default
    this.onEvict = options.onEvict as ((key: K, value: V) => void) | undefined;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.invalidate(key);
      this.misses++;
      return undefined;
    }

    this.hits++;
    entry.lastAccessed = Date.now();
    return entry.value;
  }

  getHitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  getStats(): { hits: number; misses: number; hitRate: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: this.getHitRate(),
      size: this.cache.size,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  set(key: K, value: V, ttl?: number): void {
    const expiresAt = Date.now() + (ttl ?? this.defaultTTL);

    this.cache.set(key, {
      value,
      expiresAt,
      lastAccessed: Date.now(),
    });

    if (this.cache.size > this.maxSize) {
      this.evictLRU();
    }
  }

  invalidate(key: K): void {
    const entry = this.cache.get(key);
    if (entry && this.onEvict) {
      this.onEvict(key, entry.value);
    }
    this.cache.delete(key);
  }

  clear(): void {
    if (this.onEvict) {
      for (const [key, entry] of this.cache) {
        this.onEvict(key, entry.value);
      }
    }
    this.cache.clear();
    this.resetStats();
  }

  size(): number {
    return this.cache.size;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  forEach(callback: (value: V, key: K) => void): void {
    const now = Date.now();
    const snapshot = Array.from(this.cache.entries());
    for (const [key, entry] of snapshot) {
      if (now <= entry.expiresAt) {
        callback(entry.value, key);
      }
    }
  }

  // Call this periodically to prevent memory leaks
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.invalidate(key);
      }
    }
  }

  private evictLRU(): void {
    let oldestKey: K | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.invalidate(oldestKey);
    }
  }
}
