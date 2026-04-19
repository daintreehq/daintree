import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildCacheKey,
  getCache,
  setCache,
  nextGeneration,
  getGeneration,
  _resetForTests,
} from "../githubResourceCache";

describe("githubResourceCache", () => {
  beforeEach(() => {
    _resetForTests();
  });

  describe("buildCacheKey", () => {
    it("produces a deterministic key from components", () => {
      expect(buildCacheKey("/path/to/project", "issue", "open", "created")).toBe(
        "/path/to/project:issue:open:created"
      );
    });

    it("different filter states produce different keys", () => {
      const a = buildCacheKey("/proj", "issue", "open", "created");
      const b = buildCacheKey("/proj", "issue", "closed", "created");
      expect(a).not.toBe(b);
    });

    it("different types produce different keys", () => {
      const a = buildCacheKey("/proj", "issue", "open", "created");
      const b = buildCacheKey("/proj", "pr", "open", "created");
      expect(a).not.toBe(b);
    });

    it("different sort orders produce different keys", () => {
      const a = buildCacheKey("/proj", "issue", "open", "created");
      const b = buildCacheKey("/proj", "issue", "open", "updated");
      expect(a).not.toBe(b);
    });
  });

  describe("getCache / setCache", () => {
    it("returns undefined for unknown key", () => {
      expect(getCache("missing")).toBeUndefined();
    });

    it("round-trips a cache entry", () => {
      const entry = {
        items: [
          {
            number: 1,
            title: "Test",
            url: "",
            state: "OPEN" as const,
            updatedAt: "",
            author: { login: "u", avatarUrl: "" },
            assignees: [],
            commentCount: 0,
          },
        ],
        endCursor: "cursor1",
        hasNextPage: true,
        timestamp: Date.now(),
      };
      setCache("key1", entry);
      expect(getCache("key1")).toEqual(entry);
    });

    it("overwrites existing entry", () => {
      const entry1 = { items: [], endCursor: null, hasNextPage: false, timestamp: 1 };
      const entry2 = { items: [], endCursor: "c2", hasNextPage: true, timestamp: 2 };
      setCache("key1", entry1);
      setCache("key1", entry2);
      expect(getCache("key1")).toEqual(entry2);
    });
  });

  describe("generation counter", () => {
    it("starts at 0 for unknown key", () => {
      expect(getGeneration("new-key")).toBe(0);
    });

    it("increments on each nextGeneration call", () => {
      expect(nextGeneration("k")).toBe(1);
      expect(nextGeneration("k")).toBe(2);
      expect(nextGeneration("k")).toBe(3);
    });

    it("getGeneration returns current value", () => {
      nextGeneration("k");
      nextGeneration("k");
      expect(getGeneration("k")).toBe(2);
    });

    it("independent keys have independent counters", () => {
      nextGeneration("a");
      nextGeneration("a");
      nextGeneration("b");
      expect(getGeneration("a")).toBe(2);
      expect(getGeneration("b")).toBe(1);
    });
  });

  describe("_resetForTests", () => {
    it("clears both cache and generation maps", () => {
      setCache("key1", { items: [], endCursor: null, hasNextPage: false, timestamp: 1 });
      nextGeneration("key1");
      _resetForTests();
      expect(getCache("key1")).toBeUndefined();
      expect(getGeneration("key1")).toBe(0);
    });
  });

  describe("TTL expiry", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns cached entry before TTL elapses", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      setCache("key1", { items: [], endCursor: null, hasNextPage: false, timestamp: 1 });

      vi.advanceTimersByTime(4 * 60 * 1000);
      expect(getCache("key1")).toBeDefined();
    });

    it("evicts entries after 5 minute TTL", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      setCache("key1", { items: [], endCursor: null, hasNextPage: false, timestamp: 1 });

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(getCache("key1")).toBeUndefined();
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest entry when capacity is exceeded", () => {
      for (let i = 0; i < 20; i++) {
        setCache(`key${i}`, { items: [], endCursor: null, hasNextPage: false, timestamp: i });
      }
      expect(getCache("key0")).toBeDefined();

      setCache("key20", { items: [], endCursor: null, hasNextPage: false, timestamp: 20 });

      expect(getCache("key0")).toBeUndefined();
      expect(getCache("key1")).toBeDefined();
      expect(getCache("key20")).toBeDefined();
    });

    it("bounds the generation map so it cannot grow unbounded", () => {
      for (let i = 0; i < 20; i++) {
        nextGeneration(`gen-key-${i}`);
      }
      expect(getGeneration("gen-key-0")).toBe(1);

      nextGeneration("gen-key-20");
      expect(getGeneration("gen-key-0")).toBe(0);
      expect(getGeneration("gen-key-20")).toBe(1);
    });
  });
});
