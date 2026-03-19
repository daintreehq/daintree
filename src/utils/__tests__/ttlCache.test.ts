import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "../ttlCache";

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves values", () => {
    const cache = new TtlCache<string, number>(10, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.size).toBe(2);
  });

  it("returns undefined for missing keys", () => {
    const cache = new TtlCache<string, number>(10, 60_000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const cache = new TtlCache<string, number>(10, 5_000);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);

    vi.advanceTimersByTime(5_001);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts oldest entry when at capacity (FIFO)", () => {
    const cache = new TtlCache<string, number>(3, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(3);

    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("d")).toBe(4);
  });

  it("updates existing key without changing eviction order", () => {
    const cache = new TtlCache<string, number>(3, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    // Update "a" — should NOT move it to the end
    cache.set("a", 10);
    expect(cache.get("a")).toBe(10);
    expect(cache.size).toBe(3);

    // Adding a new key should evict "a" (still oldest in insertion order)
    cache.set("d", 4);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });

  it("clears all entries", () => {
    const cache = new TtlCache<string, number>(10, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("does not count expired entries toward capacity", () => {
    const cache = new TtlCache<string, number>(2, 5_000);
    cache.set("a", 1);
    cache.set("b", 2);

    vi.advanceTimersByTime(5_001);

    // Both entries are expired but still in the map
    // Adding new entries should evict expired ones via FIFO, not block
    cache.set("c", 3);
    cache.set("d", 4);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
    expect(cache.size).toBe(2);
  });
});
