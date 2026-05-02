import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildCacheKey,
  getCache,
  setCache,
  nextGeneration,
  getGeneration,
  mutateCacheEntries,
  _resetForTests,
} from "../githubResourceCache";
import type { GitHubIssue } from "@shared/types/github";

const makeIssue = (n: number, state: "OPEN" | "CLOSED" = "OPEN"): GitHubIssue => ({
  number: n,
  title: `Issue #${n}`,
  url: `https://example.test/${n}`,
  state,
  updatedAt: "",
  author: { login: "u", avatarUrl: "" },
  assignees: [],
  commentCount: 0,
});

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

      vi.advanceTimersByTime(44 * 1000);
      expect(getCache("key1")).toBeDefined();
    });

    it("evicts entries after 45-second TTL", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      setCache("key1", { items: [], endCursor: null, hasNextPage: false, timestamp: 1 });

      vi.advanceTimersByTime(45 * 1000 + 1);
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

  describe("mutateCacheEntries", () => {
    const seedSlot = (
      projectPath: string,
      type: string,
      filter: string,
      sort: string,
      items: GitHubIssue[]
    ): string => {
      const key = buildCacheKey(projectPath, type, filter, sort);
      setCache(key, {
        items,
        endCursor: null,
        hasNextPage: false,
        timestamp: 1,
      });
      return key;
    };

    it("applies the transform across every (filter, sort) slot for the matching project + type", () => {
      const openCreated = seedSlot("/proj", "issue", "open", "created", [
        makeIssue(1),
        makeIssue(2),
      ]);
      const closedCreated = seedSlot("/proj", "issue", "closed", "created", [makeIssue(3)]);
      const openUpdated = seedSlot("/proj", "issue", "open", "updated", [
        makeIssue(1),
        makeIssue(2),
      ]);

      mutateCacheEntries("/proj", "issue", (entry) => ({
        ...entry,
        items: entry.items.filter((item) => item.number !== 2),
      }));

      expect(getCache(openCreated)?.items.map((i) => i.number)).toEqual([1]);
      expect(getCache(closedCreated)?.items.map((i) => i.number)).toEqual([3]);
      expect(getCache(openUpdated)?.items.map((i) => i.number)).toEqual([1]);
    });

    it("does not touch slots from a different project", () => {
      const sameProj = seedSlot("/proj-a", "issue", "open", "created", [makeIssue(1)]);
      const otherProj = seedSlot("/proj-b", "issue", "open", "created", [makeIssue(1)]);

      mutateCacheEntries("/proj-a", "issue", (entry) => ({
        ...entry,
        items: [],
      }));

      expect(getCache(sameProj)?.items).toEqual([]);
      expect(getCache(otherProj)?.items.map((i) => i.number)).toEqual([1]);
    });

    it("does not touch slots from a different resource type", () => {
      const issueSlot = seedSlot("/proj", "issue", "open", "created", [makeIssue(1)]);
      const prSlot = seedSlot("/proj", "pr", "open", "created", [makeIssue(1)]);

      mutateCacheEntries("/proj", "issue", (entry) => ({ ...entry, items: [] }));

      expect(getCache(issueSlot)?.items).toEqual([]);
      expect(getCache(prSlot)?.items.map((i) => i.number)).toEqual([1]);
    });

    it("bumps the generation counter only for changed slots", () => {
      const changedKey = seedSlot("/proj", "issue", "open", "created", [
        makeIssue(1),
        makeIssue(2),
      ]);
      const skippedKey = seedSlot("/proj", "issue", "closed", "created", [makeIssue(3)]);
      const changedGenBefore = getGeneration(changedKey);
      const skippedGenBefore = getGeneration(skippedKey);

      mutateCacheEntries("/proj", "issue", (entry) => {
        if (entry.items.some((item) => item.number === 1)) {
          return { ...entry, items: entry.items.filter((item) => item.number !== 1) };
        }
        return null;
      });

      expect(getGeneration(changedKey)).toBe(changedGenBefore + 1);
      expect(getGeneration(skippedKey)).toBe(skippedGenBefore);
    });

    it("is a no-op on an empty cache", () => {
      expect(() =>
        mutateCacheEntries("/proj", "issue", (entry) => ({ ...entry, items: [] }))
      ).not.toThrow();
    });

    it("handles project paths that contain colons (Windows-style)", () => {
      const windowsKey = seedSlot("C:\\projects\\repo", "issue", "open", "created", [
        makeIssue(10),
      ]);
      const otherKey = seedSlot("C:\\projects\\other", "issue", "open", "created", [makeIssue(10)]);

      mutateCacheEntries("C:\\projects\\repo", "issue", (entry) => ({
        ...entry,
        items: [],
      }));

      expect(getCache(windowsKey)?.items).toEqual([]);
      expect(getCache(otherKey)?.items.map((i) => i.number)).toEqual([10]);
    });
  });
});
