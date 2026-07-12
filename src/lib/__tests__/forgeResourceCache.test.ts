import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildCacheKey,
  getCache,
  setCache,
  nextGeneration,
  getGeneration,
  markCountStale,
  mutateCacheEntries,
  patchIssueAssigneeCache,
  _resetForTests,
} from "../forgeResourceCache";
import type { ForgeResourceCacheEntry } from "../forgeResourceCache";
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

  describe("markCountStale (count-as-cache-buster)", () => {
    function seedOpenSlot(countAtWrite?: number, stale?: boolean): string {
      const key = buildCacheKey("/proj", "issue", "open", "created");
      setCache(key, {
        items: [makeIssue(1), makeIssue(2)],
        nextCursor: null,
        hasMore: false,
        timestamp: Date.now(),
        ...(countAtWrite != null ? { countAtWrite } : {}),
        ...(stale ? { stale } : {}),
      });
      return key;
    }

    it("marks a diverged open slot stale without removing its rows, and bumps its generation", () => {
      const key = seedOpenSlot(2);
      const genBefore = getGeneration(key);

      markCountStale("/proj", "issue", 3);

      const cached = getCache(key);
      expect(cached?.stale).toBe(true);
      expect(cached?.items.map((i) => i.number)).toEqual([1, 2]);
      expect(getGeneration(key)).toBe(genBefore + 1);
    });

    it("leaves a slot alone when the count still matches", () => {
      const key = seedOpenSlot(2);
      const genBefore = getGeneration(key);

      markCountStale("/proj", "issue", 2);

      expect(getCache(key)?.stale).toBeUndefined();
      expect(getGeneration(key)).toBe(genBefore);
    });

    it("leaves a slot alone when it has no count fingerprint", () => {
      const key = seedOpenSlot(undefined);
      const genBefore = getGeneration(key);

      markCountStale("/proj", "issue", 3);

      expect(getCache(key)?.stale).toBeUndefined();
      expect(getGeneration(key)).toBe(genBefore);
    });

    it("does not re-bump the generation of an already-stale slot", () => {
      const key = seedOpenSlot(2, true);
      const genBefore = getGeneration(key);

      markCountStale("/proj", "issue", 5);

      expect(getCache(key)?.stale).toBe(true);
      expect(getGeneration(key)).toBe(genBefore);
    });

    it("only touches open-filter slots — closed/merged views have no count signal", () => {
      const closedKey = buildCacheKey("/proj", "issue", "closed", "created");
      setCache(closedKey, {
        items: [makeIssue(9)],
        nextCursor: null,
        hasMore: false,
        timestamp: Date.now(),
        countAtWrite: 2,
      });

      markCountStale("/proj", "issue", 7);

      expect(getCache(closedKey)?.stale).toBeUndefined();
    });

    it("is scoped to the given project and type", () => {
      const issueKey = seedOpenSlot(2);
      const prKey = buildCacheKey("/proj", "pr", "open", "created");
      const otherProjectKey = buildCacheKey("/other", "issue", "open", "created");
      const base = {
        items: [makeIssue(1)],
        nextCursor: null,
        hasMore: false,
        timestamp: Date.now(),
        countAtWrite: 2,
      };
      setCache(prKey, base);
      setCache(otherProjectKey, base);

      markCountStale("/proj", "issue", 4);

      expect(getCache(issueKey)?.stale).toBe(true);
      expect(getCache(prKey)?.stale).toBeUndefined();
      expect(getCache(otherProjectKey)?.stale).toBeUndefined();
    });
  });

  describe("patchIssueAssigneeCache (optimistic assign/unassign)", () => {
    const viewer = { login: "octocat", avatarUrl: "https://fake.test/octocat.png" };

    const seedSlot = (
      filter: string,
      sort: string,
      items: Issue[],
      overrides: Partial<ForgeResourceCacheEntry> = {}
    ): string => {
      const key = buildCacheKey("/proj", "issue", filter, sort);
      setCache(key, { ...entry(items), ...overrides });
      return key;
    };

    const withAssignee = (n: number, login: string): Issue => ({
      ...makeIssue(n),
      assignees: [{ login, avatarUrl: undefined, rawData: null }],
    });

    const loginsOn = (key: string, issueNumber: number): string[] | undefined => {
      const item = getCache(key)?.items.find((i) => i.number === issueNumber);
      return item && "assignees" in item ? item.assignees.map((a) => a.login) : undefined;
    };

    it("adds the user to the target issue across every filter/sort slot", () => {
      const openCreated = seedSlot("open", "created", [makeIssue(1), makeIssue(2)]);
      const openUpdated = seedSlot("open", "updated", [makeIssue(1)]);

      patchIssueAssigneeCache("/proj", 1, viewer, true);

      expect(loginsOn(openCreated, 1)).toEqual([viewer.login]);
      expect(loginsOn(openUpdated, 1)).toEqual([viewer.login]);
      // Sibling rows in the same slot are untouched.
      expect(loginsOn(openCreated, 2)).toEqual([]);
    });

    it("carries the avatar onto the optimistic assignee, and tolerates not having one", () => {
      const withAvatar = seedSlot("open", "created", [makeIssue(1)]);
      patchIssueAssigneeCache("/proj", 1, viewer, true);
      const added = getCache(withAvatar)?.items[0];
      expect(added && "assignees" in added ? added.assignees[0].avatarUrl : null).toBe(
        viewer.avatarUrl
      );

      _resetForTests();
      const noAvatar = seedSlot("open", "created", [makeIssue(1)]);
      patchIssueAssigneeCache("/proj", 1, { login: "someone-else" }, true);
      const addedBare = getCache(noAvatar)?.items[0];
      expect(addedBare && "assignees" in addedBare ? addedBare.assignees[0] : null).toMatchObject({
        login: "someone-else",
        avatarUrl: undefined,
      });
    });

    it("removes the user on unassign, leaving co-assignees in place", () => {
      const key = seedSlot("open", "created", [
        {
          ...makeIssue(1),
          assignees: [
            { login: "someone-else", avatarUrl: undefined, rawData: null },
            { login: viewer.login, avatarUrl: undefined, rawData: null },
          ],
        },
      ]);

      patchIssueAssigneeCache("/proj", 1, viewer, false);

      expect(loginsOn(key, 1)).toEqual(["someone-else"]);
    });

    it("marks the patched entry stale so the next revalidate cannot be downgraded to a cached read", () => {
      // An assignment never moves the open count, so `countAtWrite` still
      // matches and `planWarmRevalidate` would otherwise honor the backend's
      // own list cache and serve the pre-assignment page straight back.
      const key = seedSlot("open", "created", [makeIssue(1)], { countAtWrite: 5 });

      patchIssueAssigneeCache("/proj", 1, viewer, true);

      expect(getCache(key)?.stale).toBe(true);
      expect(getCache(key)?.countAtWrite).toBe(5);
    });

    it("advances the entry timestamp so an older stats broadcast cannot seed over the patch", () => {
      const key = seedSlot("open", "created", [makeIssue(1)], { timestamp: 1 });
      const before = getCache(key)?.timestamp ?? 0;

      patchIssueAssigneeCache("/proj", 1, viewer, true);

      expect(getCache(key)?.timestamp).toBeGreaterThan(before);
    });

    it("does not claim a fresh bypass — the rows are optimistic, not forge-fetched", () => {
      const key = seedSlot("open", "created", [makeIssue(1)]);

      patchIssueAssigneeCache("/proj", 1, viewer, true);

      expect(getCache(key)?.freshBypassAt).toBeUndefined();
    });

    it("preserves the entry's pagination metadata", () => {
      const key = buildCacheKey("/proj", "issue", "open", "created");
      setCache(key, {
        items: [makeIssue(1)],
        nextCursor: "cursor-abc",
        hasMore: true,
        timestamp: 1,
      });

      patchIssueAssigneeCache("/proj", 1, viewer, true);

      expect(getCache(key)).toMatchObject({ nextCursor: "cursor-abc", hasMore: true });
    });

    it("re-assigning an already-assigned user is a no-op that does not bump the generation", () => {
      const key = seedSlot("open", "created", [withAssignee(1, viewer.login)]);
      const genBefore = getGeneration(key);

      patchIssueAssigneeCache("/proj", 1, viewer, true);

      expect(loginsOn(key, 1)).toEqual([viewer.login]);
      expect(getGeneration(key)).toBe(genBefore);
      expect(getCache(key)?.stale).toBeUndefined();
    });

    it("unassigning a user who is not assigned is a no-op that does not bump the generation", () => {
      const key = seedSlot("open", "created", [makeIssue(1)]);
      const genBefore = getGeneration(key);

      patchIssueAssigneeCache("/proj", 1, viewer, false);

      expect(getGeneration(key)).toBe(genBefore);
      expect(getCache(key)?.stale).toBeUndefined();
    });

    it("bumps the generation of a changed slot so an in-flight fetch cannot commit over it", () => {
      const key = seedSlot("open", "created", [makeIssue(1)]);
      const genBefore = getGeneration(key);

      patchIssueAssigneeCache("/proj", 1, viewer, true);

      expect(getGeneration(key)).toBe(genBefore + 1);
    });

    it("leaves other projects, other resource types, and other issues untouched", () => {
      const target = seedSlot("open", "created", [makeIssue(1)]);
      const otherIssueSlot = buildCacheKey("/other", "issue", "open", "created");
      const prSlot = buildCacheKey("/proj", "pr", "open", "created");
      setCache(otherIssueSlot, entry([makeIssue(1)]));
      setCache(prSlot, entry([makeIssue(1)]));

      patchIssueAssigneeCache("/proj", 1, viewer, true);

      expect(loginsOn(target, 1)).toEqual([viewer.login]);
      expect(loginsOn(otherIssueSlot, 1)).toEqual([]);
      expect(loginsOn(prSlot, 1)).toEqual([]);
      expect(getCache(prSlot)?.stale).toBeUndefined();
    });

    it("is a no-op when the issue is not in any cached page", () => {
      const key = seedSlot("open", "created", [makeIssue(1)]);
      const genBefore = getGeneration(key);

      patchIssueAssigneeCache("/proj", 999, viewer, true);

      expect(loginsOn(key, 1)).toEqual([]);
      expect(getGeneration(key)).toBe(genBefore);
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
