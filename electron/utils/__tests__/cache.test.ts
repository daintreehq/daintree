import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cache } from "../cache.js";

describe("Cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks misses for unknown keys", () => {
    const cache = new Cache<string, string>();

    expect(cache.get("missing")).toBeUndefined();
    expect(cache.getStats()).toEqual({
      hits: 0,
      misses: 1,
      hitRate: 0,
      size: 0,
    });
  });

  it("stores and retrieves entries with hit accounting", () => {
    const cache = new Cache<string, string>();
    cache.set("k1", "v1");

    expect(cache.get("k1")).toBe("v1");
    expect(cache.get("k1")).toBe("v1");
    expect(cache.getStats()).toEqual({
      hits: 2,
      misses: 0,
      hitRate: 1,
      size: 1,
    });
  });

  it("expires entries using default TTL", () => {
    const cache = new Cache<string, string>({ defaultTTL: 100 });
    cache.set("k1", "v1");

    vi.advanceTimersByTime(101);

    expect(cache.get("k1")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("supports per-entry TTL overrides", () => {
    const cache = new Cache<string, string>({ defaultTTL: 1000 });
    cache.set("fast", "v1", 10);
    cache.set("slow", "v2", 5000);

    vi.advanceTimersByTime(11);

    expect(cache.get("fast")).toBeUndefined();
    expect(cache.get("slow")).toBe("v2");
  });

  it("evicts least recently used entry when max size is exceeded", () => {
    const cache = new Cache<string, string>({ maxSize: 2, defaultTTL: 10000 });
    cache.set("a", "1");
    cache.set("b", "2");

    vi.advanceTimersByTime(1);
    expect(cache.get("a")).toBe("1");
    cache.set("c", "3");

    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });

  it("calls onEvict when entries expire during get", () => {
    const onEvict = vi.fn();
    const cache = new Cache<string, string>({ defaultTTL: 50, onEvict });
    cache.set("k1", "v1");

    vi.advanceTimersByTime(51);
    expect(cache.get("k1")).toBeUndefined();

    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("k1", "v1");
  });

  it("calls onEvict for each entry during clear and resets stats", () => {
    const onEvict = vi.fn();
    const cache = new Cache<string, string>({ onEvict });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.get("a");
    cache.get("missing");

    cache.clear();

    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(cache.getStats()).toEqual({
      hits: 0,
      misses: 0,
      hitRate: 0,
      size: 0,
    });
  });

  it("invalidate removes key and invokes onEvict once", () => {
    const onEvict = vi.fn();
    const cache = new Cache<string, string>({ onEvict });
    cache.set("a", "1");

    cache.invalidate("a");
    cache.invalidate("a");

    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(cache.get("a")).toBeUndefined();
  });

  it("has returns false for expired entries and removes them", () => {
    const cache = new Cache<string, string>({ defaultTTL: 20 });
    cache.set("a", "1");
    vi.advanceTimersByTime(21);

    expect(cache.has("a")).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("forEach skips expired entries", () => {
    const cache = new Cache<string, string>();
    cache.set("expired", "x", 10);
    cache.set("live", "y", 1000);
    vi.advanceTimersByTime(11);

    const seen = new Map<string, string>();
    cache.forEach((value, key) => seen.set(key, value));

    expect(Array.from(seen.entries())).toEqual([["live", "y"]]);
  });

  it("cleanup removes expired entries and keeps live entries", () => {
    const onEvict = vi.fn();
    const cache = new Cache<string, string>({ onEvict });
    cache.set("expired", "x", 10);
    cache.set("live", "y", 1000);
    vi.advanceTimersByTime(11);

    cache.cleanup();

    expect(cache.get("expired")).toBeUndefined();
    expect(cache.get("live")).toBe("y");
    expect(onEvict).toHaveBeenCalledWith("expired", "x");
  });

  it("resetStats preserves cache contents", () => {
    const cache = new Cache<string, string>();
    cache.set("k", "v");
    cache.get("k");
    cache.get("missing");
    cache.resetStats();

    expect(cache.getStats()).toEqual({
      hits: 0,
      misses: 0,
      hitRate: 0,
      size: 1,
    });
    expect(cache.get("k")).toBe("v");
  });
});
