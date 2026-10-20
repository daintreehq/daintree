import { describe, expect, it } from "vitest";
import { BoundedCache } from "../boundedCache.js";

describe("BoundedCache", () => {
  it("never holds more than its cap across many unique keys", () => {
    const cache = new BoundedCache<number>({ maxEntries: 5, retainMs: 60_000 });
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, i, 0);
    expect(cache.size).toBe(5);
    expect(cache.get("k99", 1_000, 0)).toBe(99);
    expect(cache.get("k0", 1_000, 0)).toBeUndefined();
  });

  it("evicts the least recently read entry, not the oldest written", () => {
    const cache = new BoundedCache<string>({ maxEntries: 2, retainMs: 60_000 });
    cache.set("a", "A", 0);
    cache.set("b", "B", 0);
    expect(cache.get("a", 1_000, 0)).toBe("A");
    cache.set("c", "C", 0);
    expect(cache.get("a", 1_000, 0)).toBe("A");
    expect(cache.get("b", 1_000, 0)).toBeUndefined();
  });

  it("drops expired entries before evicting live ones", () => {
    const cache = new BoundedCache<string>({ maxEntries: 2, retainMs: 100 });
    cache.set("old", "O", 0);
    cache.set("live", "L", 60);
    // "old" becomes most recently used, leaving the live entry as the LRU.
    expect(cache.get("old", 100, 70)).toBe("O");
    cache.set("new", "N", 150);
    expect(cache.size).toBe(2);
    expect(cache.get("live", 1_000, 150)).toBe("L");
    expect(cache.get("new", 1_000, 150)).toBe("N");
  });

  it("treats a stale read as a miss but keeps the entry for peek until retention ends", () => {
    const cache = new BoundedCache<string>({ maxEntries: 10, retainMs: 300 });
    cache.set("k", "V", 0);
    expect(cache.get("k", 100, 200)).toBeUndefined();
    expect(cache.peek("k", 200)).toBe("V");
    expect(cache.peek("k", 301)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("does not extend retention on a hit or a peek", () => {
    const cache = new BoundedCache<string>({ maxEntries: 10, retainMs: 100 });
    cache.set("k", "V", 0);
    expect(cache.get("k", 100, 90)).toBe("V");
    expect(cache.peek("k", 95)).toBe("V");
    cache.sweep(101);
    expect(cache.size).toBe(0);
  });

  it("caches null as a value distinct from a miss", () => {
    const cache = new BoundedCache<string | null>({ maxEntries: 10, retainMs: 100 });
    cache.set("neg", null, 0);
    expect(cache.get("neg", 100, 50)).toBeNull();
    expect(cache.get("absent", 100, 50)).toBeUndefined();
  });

  it("sweep releases expired entries without reading their keys", () => {
    const cache = new BoundedCache<number>({ maxEntries: 2_000, retainMs: 100 });
    for (let i = 0; i < 1_000; i++) cache.set(`k${i}`, i, 0);
    cache.set("fresh", 1, 90);
    cache.sweep(150);
    expect(cache.size).toBe(1);
    expect(cache.get("fresh", 100, 150)).toBe(1);
  });

  it("clear empties the cache", () => {
    const cache = new BoundedCache<number>({ maxEntries: 10, retainMs: 100 });
    cache.set("a", 1, 0);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.peek("a", 0)).toBeUndefined();
  });
});
