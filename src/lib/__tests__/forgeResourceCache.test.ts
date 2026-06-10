import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildCacheKey,
  getCache,
  setCache,
  nextGeneration,
  getGeneration,
  mutateCacheEntries,
  _resetForTests,
} from "../forgeResourceCache";
import type { Issue } from "@shared/types/forge";

const makeIssue = (n: number): Issue => ({
  number: n,
  title: `Issue #${n}`,
  body: "",
  state: "open",
  rawState: "opened",
  url: `https://fake.test/${n}`,
  assignees: [],
  labels: [],
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
});

const entry = (items: Issue[]) => ({
  items,
  nextCursor: null,
  hasMore: false,
  timestamp: 1,
});

describe("forgeResourceCache", () => {
  beforeEach(() => {
    _resetForTests();
  });

  describe("buildCacheKey", () => {
    it("produces a deterministic project-scoped key", () => {
      expect(buildCacheKey("/proj", "issue", "open", "created")).toBe("/proj:issue:open:created");
    });

    it("different projects produce different keys", () => {
      const a = buildCacheKey("/proj-a", "issue", "open", "created");
      const b = buildCacheKey("/proj-b", "issue", "open", "created");
      expect(a).not.toBe(b);
    });

    it("type, filter, and sort each disambiguate the key", () => {
      const base = buildCacheKey("/proj", "issue", "open", "created");
      expect(base).not.toBe(buildCacheKey("/proj", "pr", "open", "created"));
      expect(base).not.toBe(buildCacheKey("/proj", "issue", "closed", "created"));
      expect(base).not.toBe(buildCacheKey("/proj", "issue", "open", "updated"));
    });
  });

  describe("getCache / setCache", () => {
    it("returns undefined for an unknown key", () => {
      expect(getCache("missing")).toBeUndefined();
    });

    it("round-trips a cache entry", () => {
      const e = entry([makeIssue(1)]);
      setCache("k", e);
      expect(getCache("k")).toEqual(e);
    });

    it("overwrites an existing entry", () => {
      setCache("k", entry([makeIssue(1)]));
      setCache("k", entry([makeIssue(2)]));
      expect(getCache("k")?.items.map((i) => i.number)).toEqual([2]);
    });
  });

  describe("generation counter", () => {
    it("starts at 0 for an unknown key", () => {
      expect(getGeneration("new")).toBe(0);
    });

    it("increments on each nextGeneration call", () => {
      expect(nextGeneration("k")).toBe(1);
      expect(nextGeneration("k")).toBe(2);
    });

    it("keeps independent counters per key", () => {
      nextGeneration("a");
      nextGeneration("a");
      nextGeneration("b");
      expect(getGeneration("a")).toBe(2);
      expect(getGeneration("b")).toBe(1);
    });

    it("bounds the generation map so it cannot grow unbounded", () => {
      for (let i = 0; i < 20; i++) nextGeneration(`g-${i}`);
      expect(getGeneration("g-0")).toBe(1);
      nextGeneration("g-20");
      expect(getGeneration("g-0")).toBe(0);
      expect(getGeneration("g-20")).toBe(1);
    });
  });

  describe("LRU eviction", () => {
    it("evicts the oldest entry when capacity is exceeded", () => {
      for (let i = 0; i < 20; i++) {
        setCache(`key${i}`, entry([]));
      }
      expect(getCache("key0")).toBeDefined();

      setCache("key20", entry([]));

      expect(getCache("key0")).toBeUndefined();
      expect(getCache("key1")).toBeDefined();
      expect(getCache("key20")).toBeDefined();
    });
  });

  describe("TTL expiry", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns the entry before the 45s TTL elapses", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      setCache("k", entry([]));
      vi.advanceTimersByTime(44 * 1000);
      expect(getCache("k")).toBeDefined();
    });

    it("evicts the entry after the 45s TTL", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      setCache("k", entry([]));
      vi.advanceTimersByTime(45 * 1000 + 1);
      expect(getCache("k")).toBeUndefined();
    });
  });

  describe("mutateCacheEntries", () => {
    const seed = (
      projectPath: string,
      type: string,
      filter: string,
      sort: string,
      items: Issue[]
    ): string => {
      const key = buildCacheKey(projectPath, type, filter, sort);
      setCache(key, entry(items));
      return key;
    };

    it("applies the transform across every (filter, sort) slot for the matching project + type", () => {
      const openCreated = seed("/proj", "issue", "open", "created", [makeIssue(1), makeIssue(2)]);
      const closedCreated = seed("/proj", "issue", "closed", "created", [makeIssue(3)]);
      const openUpdated = seed("/proj", "issue", "open", "updated", [makeIssue(1), makeIssue(2)]);

      mutateCacheEntries("/proj", "issue", (e) => ({
        ...e,
        items: e.items.filter((i) => i.number !== 2),
      }));

      expect(getCache(openCreated)?.items.map((i) => i.number)).toEqual([1]);
      expect(getCache(closedCreated)?.items.map((i) => i.number)).toEqual([3]);
      expect(getCache(openUpdated)?.items.map((i) => i.number)).toEqual([1]);
    });

    it("does not touch slots from a different project", () => {
      const sameProj = seed("/proj-a", "issue", "open", "created", [makeIssue(1)]);
      const otherProj = seed("/proj-b", "issue", "open", "created", [makeIssue(1)]);

      mutateCacheEntries("/proj-a", "issue", (e) => ({ ...e, items: [] }));

      expect(getCache(sameProj)?.items).toEqual([]);
      expect(getCache(otherProj)?.items.map((i) => i.number)).toEqual([1]);
    });

    it("does not touch slots from a different resource type", () => {
      const issueSlot = seed("/proj", "issue", "open", "created", [makeIssue(1)]);
      const prSlot = seed("/proj", "pr", "open", "created", [makeIssue(1)]);

      mutateCacheEntries("/proj", "issue", (e) => ({ ...e, items: [] }));

      expect(getCache(issueSlot)?.items).toEqual([]);
      expect(getCache(prSlot)?.items.map((i) => i.number)).toEqual([1]);
    });

    it("passes the key remainder (filterState:sortOrder) to the transform", () => {
      seed("/proj", "issue", "open", "created", [makeIssue(1)]);
      seed("/proj", "issue", "closed", "updated", [makeIssue(2)]);
      const remainders: string[] = [];

      mutateCacheEntries("/proj", "issue", (_e, keyRemainder) => {
        remainders.push(keyRemainder);
        return null;
      });

      expect(remainders.sort()).toEqual(["closed:updated", "open:created"]);
    });

    it("handles project paths that contain colons (Windows-style)", () => {
      const windowsKey = seed("C:\\projects\\repo", "issue", "open", "created", [makeIssue(1)]);
      const otherKey = seed("C:\\projects\\other", "issue", "open", "created", [makeIssue(10)]);

      mutateCacheEntries("C:\\projects\\repo", "issue", (e) => ({ ...e, items: [] }));

      expect(getCache(windowsKey)?.items).toEqual([]);
      expect(getCache(otherKey)?.items.map((i) => i.number)).toEqual([10]);
    });

    it("bumps the generation counter only for changed slots", () => {
      const changed = seed("/proj", "issue", "open", "created", [makeIssue(1)]);
      const skipped = seed("/proj", "issue", "closed", "created", [makeIssue(3)]);
      const changedBefore = getGeneration(changed);
      const skippedBefore = getGeneration(skipped);

      mutateCacheEntries("/proj", "issue", (e) =>
        e.items.some((i) => i.number === 1) ? { ...e, items: [] } : null
      );

      expect(getGeneration(changed)).toBe(changedBefore + 1);
      expect(getGeneration(skipped)).toBe(skippedBefore);
    });

    it("is a no-op on an empty cache", () => {
      expect(() =>
        mutateCacheEntries("/proj", "issue", (e) => ({ ...e, items: [] }))
      ).not.toThrow();
    });
  });

  describe("_resetForTests", () => {
    it("clears both the cache and the generation map", () => {
      setCache("k", entry([]));
      nextGeneration("k");
      _resetForTests();
      expect(getCache("k")).toBeUndefined();
      expect(getGeneration("k")).toBe(0);
    });
  });
});
