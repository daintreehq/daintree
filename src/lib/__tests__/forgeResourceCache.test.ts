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
    it("produces a deterministic provider-scoped key", () => {
      expect(buildCacheKey("acme.gitea", "acme", "widgets", "issue", "open", "created")).toBe(
        "acme.gitea:acme:widgets:issue:open:created"
      );
    });

    it("different providers produce different keys for the same repo identity", () => {
      const a = buildCacheKey("p.github", "acme", "widgets", "issue", "open", "created");
      const b = buildCacheKey("q.gitea", "acme", "widgets", "issue", "open", "created");
      expect(a).not.toBe(b);
    });

    it("different repos produce different keys", () => {
      const a = buildCacheKey("p", "acme", "widgets", "issue", "open", "created");
      const b = buildCacheKey("p", "acme", "gadgets", "issue", "open", "created");
      expect(a).not.toBe(b);
    });

    it("type, filter, and sort each disambiguate the key", () => {
      const base = buildCacheKey("p", "o", "r", "issue", "open", "created");
      expect(base).not.toBe(buildCacheKey("p", "o", "r", "pr", "open", "created"));
      expect(base).not.toBe(buildCacheKey("p", "o", "r", "issue", "closed", "created"));
      expect(base).not.toBe(buildCacheKey("p", "o", "r", "issue", "open", "updated"));
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
      providerId: string,
      owner: string,
      repo: string,
      type: string,
      filter: string,
      sort: string,
      items: Issue[]
    ): string => {
      const key = buildCacheKey(providerId, owner, repo, type, filter, sort);
      setCache(key, entry(items));
      return key;
    };

    it("applies the transform across every (filter, sort) slot for the matching tuple", () => {
      const openCreated = seed("p", "o", "r", "issue", "open", "created", [
        makeIssue(1),
        makeIssue(2),
      ]);
      const closedCreated = seed("p", "o", "r", "issue", "closed", "created", [makeIssue(3)]);
      const openUpdated = seed("p", "o", "r", "issue", "open", "updated", [
        makeIssue(1),
        makeIssue(2),
      ]);

      mutateCacheEntries("p", "o", "r", "issue", (e) => ({
        ...e,
        items: e.items.filter((i) => i.number !== 2),
      }));

      expect(getCache(openCreated)?.items.map((i) => i.number)).toEqual([1]);
      expect(getCache(closedCreated)?.items.map((i) => i.number)).toEqual([3]);
      expect(getCache(openUpdated)?.items.map((i) => i.number)).toEqual([1]);
    });

    it("does not touch slots from a different provider for the same repo", () => {
      const githubSlot = seed("gh", "o", "r", "issue", "open", "created", [makeIssue(1)]);
      const giteaSlot = seed("gt", "o", "r", "issue", "open", "created", [makeIssue(1)]);

      mutateCacheEntries("gh", "o", "r", "issue", (e) => ({ ...e, items: [] }));

      expect(getCache(githubSlot)?.items).toEqual([]);
      expect(getCache(giteaSlot)?.items.map((i) => i.number)).toEqual([1]);
    });

    it("does not touch slots from a different resource type", () => {
      const issueSlot = seed("p", "o", "r", "issue", "open", "created", [makeIssue(1)]);
      const prSlot = seed("p", "o", "r", "pr", "open", "created", [makeIssue(1)]);

      mutateCacheEntries("p", "o", "r", "issue", (e) => ({ ...e, items: [] }));

      expect(getCache(issueSlot)?.items).toEqual([]);
      expect(getCache(prSlot)?.items.map((i) => i.number)).toEqual([1]);
    });

    it("bumps the generation counter only for changed slots", () => {
      const changed = seed("p", "o", "r", "issue", "open", "created", [makeIssue(1)]);
      const skipped = seed("p", "o", "r", "issue", "closed", "created", [makeIssue(3)]);
      const changedBefore = getGeneration(changed);
      const skippedBefore = getGeneration(skipped);

      mutateCacheEntries("p", "o", "r", "issue", (e) =>
        e.items.some((i) => i.number === 1) ? { ...e, items: [] } : null
      );

      expect(getGeneration(changed)).toBe(changedBefore + 1);
      expect(getGeneration(skipped)).toBe(skippedBefore);
    });

    it("is a no-op on an empty cache", () => {
      expect(() =>
        mutateCacheEntries("p", "o", "r", "issue", (e) => ({ ...e, items: [] }))
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
