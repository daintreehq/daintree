import { describe, expect, it } from "vitest";
import {
  buildListCacheKey,
  normalizeListDirection,
  normalizeListPerPage,
  normalizeListSortOrder,
} from "../GitHubPRs.js";

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

  it("preserves the repo prefix the cache sweeps by", () => {
    // GitHubCaches invalidates a repo's pages by prefix match, so nothing
    // repo-identifying may move behind another field.
    for (const key of [keyWith({}), keyWith({ perPage: 99, direction: "asc", cursor: "z" })]) {
      expect(key.startsWith("issue:daintreehq/daintree:")).toBe(true);
    }
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
