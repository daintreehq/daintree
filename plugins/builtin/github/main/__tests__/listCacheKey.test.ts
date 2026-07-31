import { beforeEach, describe, expect, it } from "vitest";
import type { Issue, Page } from "../../../../../shared/types/forge.js";
import {
  buildListCacheKey,
  normalizeListDirection,
  normalizeListPerPage,
  normalizeListSortOrder,
} from "../GitHubPRs.js";
import {
  clearGitHubCaches,
  forgeIssueListCache,
  invalidateRepoListCachesForCountChange,
} from "../GitHubCaches.js";

beforeEach(() => clearGitHubCaches());

const base = {
  type: "issue",
  owner: "daintreehq",
  repo: "daintree",
  state: "open",
  search: "",
  sortOrder: "created",
  direction: "desc",
  perPage: 20,
  cursor: "",
} as const;

const keyWith = (overrides: Partial<typeof base>) => buildListCacheKey({ ...base, ...overrides });

describe("list cache identity", () => {
  /**
   * The bug class this guards: a key that omits a dimension lets a second
   * caller be handed the first caller's page off the shared in-flight promise.
   * Each option below changes what the provider actually asks GitHub for, so
   * each must split the key.
   */
  it.each([
    ["page size", { perPage: 50 }],
    ["direction", { direction: "asc" as const }],
    ["sort field", { sortOrder: "updated" }],
    ["state", { state: "closed" }],
    ["cursor", { cursor: "abc" }],
    ["search", { search: "no:assignee" }],
    ["repo", { repo: "other" }],
    ["owner", { owner: "someone" }],
    ["type", { type: "pr" as const }],
  ])("a different %s produces a different key", (_label, overrides) => {
    expect(keyWith(overrides)).not.toBe(keyWith({}));
  });

  it("keeps every distinct page size separate", () => {
    const keys = [1, 20, 50, 100].map((perPage) => keyWith({ perPage }));
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * Asserted through the real invalidator rather than by matching the key's
   * prefix literally: `invalidateRepoListCachesForCountChange` sweeps a repo's
   * pages by prefix, so what matters is that every key variant is still
   * reachable by that sweep — and that the sweep doesn't reach another repo.
   */
  it("keeps every key variant reachable by the repo-scoped invalidation sweep", () => {
    const variants = [
      keyWith({}),
      keyWith({ perPage: 99 }),
      keyWith({ direction: "asc" }),
      keyWith({ cursor: "z", sortOrder: "updated" }),
    ];
    const otherRepo = keyWith({ repo: "elsewhere" });
    const page: Page<Issue> = { items: [], nextCursor: null, hasMore: false };
    for (const key of [...variants, otherRepo]) forgeIssueListCache.set(key, page);

    invalidateRepoListCachesForCountChange("daintreehq", "daintree", {
      issues: true,
      prs: false,
    });

    for (const key of variants) expect(forgeIssueListCache.get(key)).toBeUndefined();
    expect(forgeIssueListCache.get(otherRepo)).toBeDefined();
  });
});

describe("list option normalization", () => {
  it("collapses an omitted page size onto the default so both share a cache entry", () => {
    expect(keyWith({ perPage: normalizeListPerPage(undefined) })).toBe(
      keyWith({ perPage: normalizeListPerPage(20) })
    );
  });

  it("collapses an omitted direction onto descending", () => {
    expect(normalizeListDirection(undefined)).toBe(normalizeListDirection("desc"));
    expect(normalizeListDirection("asc")).not.toBe(normalizeListDirection(undefined));
  });

  it("collapses an unrecognized sort onto creation order", () => {
    expect(normalizeListSortOrder("comments")).toBe(normalizeListSortOrder(undefined));
    expect(normalizeListSortOrder("updated")).not.toBe(normalizeListSortOrder(undefined));
  });

  it("clamps a page size into the range GitHub accepts", () => {
    expect(normalizeListPerPage(0)).toBeGreaterThanOrEqual(1);
    expect(normalizeListPerPage(-5)).toBeGreaterThanOrEqual(1);
    expect(normalizeListPerPage(1000)).toBeLessThanOrEqual(100);
  });

  it("coerces a fractional page size to a whole number of rows", () => {
    expect(Number.isInteger(normalizeListPerPage(12.7))).toBe(true);
  });

  it("survives a non-finite page size rather than keying on NaN", () => {
    expect(normalizeListPerPage(Number.NaN)).toBe(normalizeListPerPage(undefined));
    expect(normalizeListPerPage(Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(100);
  });
});
