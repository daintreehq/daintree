import { describe, expect, it } from "vitest";
import {
  ReviewPointSchema,
  reviewPointPathBytes,
  reviewPointPathKey,
  type ReviewPoint,
} from "../reviewPoint.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

function point(overrides: Partial<ReviewPoint> = {}): ReviewPoint {
  return {
    version: 1,
    capturedAt: 1,
    worktreePath: "/repo",
    gitDir: "/repo/.git",
    commonDir: "/repo/.git",
    objectFormat: "sha1",
    head: { kind: "branch", branch: "topic", commit: A },
    base: {
      requested: { kind: "branch", branch: "main" },
      ref: "refs/heads/main",
      tip: B,
      mergeBases: [B],
    },
    entries: [
      {
        path: "a.txt",
        head: { mode: "100644", oid: A },
        index: { kind: "entry", mode: "100644", oid: A },
        worktree: { kind: "file", mode: "100644", oid: B, size: 2 },
      },
      {
        path: "b.txt",
        head: null,
        index: { kind: "absent" },
        worktree: { kind: "unverifiable", reason: "file-too-large" },
      },
    ],
    incomplete: {
      reasons: ["file-too-large"],
      uncovered: [{ path: "b.txt", reason: "file-too-large" }],
      uncoveredCount: 1,
    },
    ...overrides,
  };
}

const valid = point();

describe("ReviewPointSchema", () => {
  it("accepts what a capture produces", () => {
    expect(ReviewPointSchema.safeParse(valid).success).toBe(true);
  });

  it.each<[string, ReviewPoint]>([
    ["an uncovered entry in a complete point", point({ incomplete: null })],
    ["an object id of the wrong format", point({ objectFormat: "sha256" })],
    ["a base tip with no ref", point({ base: { ...valid.base, ref: null } })],
    ["merge bases with no tip", point({ base: { ...valid.base, ref: null, tip: null } })],
    ["entries out of byte order", point({ entries: [...valid.entries].reverse() })],
    ["the same path twice", point({ entries: [valid.entries[0], valid.entries[0]] })],
    [
      "a count below the listed paths",
      point({ incomplete: { ...valid.incomplete!, uncoveredCount: 0 } }),
    ],
    [
      "a gap whose reason isn't listed",
      point({ incomplete: { ...valid.incomplete!, reasons: ["path-limit"] } }),
    ],
    [
      "an unborn branch with merge bases",
      point({ head: { kind: "unborn", branch: "main" }, entries: [], incomplete: null }),
    ],
    [
      "a path that climbs out of the worktree",
      point({ entries: [{ ...valid.entries[0], path: "../a.txt" }], incomplete: null }),
    ],
    [
      "a base ref read as an option",
      point({ base: { ...valid.base, requested: { kind: "ref", ref: "refs/heads/a..b" } } }),
    ],
  ])("refuses %s", (_label, candidate) => {
    expect(ReviewPointSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("review point paths", () => {
  it("carries bytes only for names that aren't valid UTF-8, in one spelling", () => {
    const bytes = Uint8Array.from([0x62, 0xff]);
    const pathBytes = btoa(String.fromCharCode(...bytes));
    const display = new TextDecoder().decode(bytes);
    expect(reviewPointPathBytes({ path: display, pathBytes })).toEqual(bytes);
    // Valid UTF-8 carried as bytes would give the same path two keys.
    expect(reviewPointPathBytes({ path: "a", pathBytes: btoa("a") })).toBeNull();
    expect(reviewPointPathBytes({ path: "other", pathBytes })).toBeNull();
    expect(reviewPointPathBytes({ path: display, pathBytes: "Yv8" })).toBeNull();
    expect(reviewPointPathBytes({ path: "lone\uD800" })).toBeNull();
  });

  it("keys two names that display alike apart", () => {
    const first = { path: "b�", pathBytes: btoa("b\xff") };
    const second = { path: "b�", pathBytes: btoa("b\xfe") };
    expect(reviewPointPathKey(first)).not.toBe(reviewPointPathKey(second));
    expect(reviewPointPathKey({ path: "b�" })).not.toBe(reviewPointPathKey(first));
  });
});
