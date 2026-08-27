import { describe, expect, it } from "vitest";
import type { StagingFileEntry } from "@shared/types";
import {
  DEFAULT_SECTION_STATE,
  countNonDefaultView,
  isSortKey,
  readGitErrorFields,
  resolveBulkScope,
  sortFiles,
} from "../reviewHubUtils";

function file(
  path: string,
  overrides: Partial<Omit<StagingFileEntry, "path">> = {}
): StagingFileEntry {
  return {
    path,
    status: "modified",
    insertions: 0,
    deletions: 0,
    ...overrides,
  };
}

describe("readGitErrorFields", () => {
  it("decodes the preload's prefix when no own properties survive (post-contextBridge)", () => {
    // Simulates the renderer side of the bridge: only `message` and `stack`
    // crossed, custom Error properties were stripped. The doc comment claim
    // before #8567 said the properties survived — they did not. The fix is
    // that the prefix on `message` carries the discriminant.
    const err = new Error(
      "[GitError|push-rejected-outdated|deadbeef|feature%2Fmy-branch] rejected"
    );
    expect(readGitErrorFields(err)).toEqual({
      gitReason: "push-rejected-outdated",
      leaseSha: "deadbeef",
      branchName: "feature/my-branch",
    });
  });

  it("returns gitReason but no leaseSha/branchName when the slots are empty", () => {
    const err = new Error("[GitError|auth-failed||] auth refused");
    expect(readGitErrorFields(err)).toEqual({
      gitReason: "auth-failed",
      leaseSha: undefined,
      branchName: undefined,
    });
  });

  it("reads same-realm errors that already carry the fields as own properties", () => {
    // A test mock or main-process-side throw in the same realm — the properties
    // survive and isClientGitError's fallback recognises them.
    const err = Object.assign(new Error("rejected"), {
      name: "GitOperationError",
      gitReason: "push-rejected-outdated",
      leaseSha: "abc123",
      branchName: "main",
    });
    expect(readGitErrorFields(err)).toEqual({
      gitReason: "push-rejected-outdated",
      leaseSha: "abc123",
      branchName: "main",
    });
  });

  it("returns empty object for non-Error inputs", () => {
    expect(readGitErrorFields(null)).toEqual({});
    expect(readGitErrorFields(undefined)).toEqual({});
    expect(readGitErrorFields("oops")).toEqual({});
    expect(readGitErrorFields(42)).toEqual({});
    // Plain object with the right shape — still not an Error instance.
    // Tightening to instanceof Error keeps the surface area to actual thrown
    // errors and prevents accidental coercion of unrelated payloads.
    expect(readGitErrorFields({ gitReason: "push-rejected-outdated", leaseSha: "x" })).toEqual({});
  });

  it("returns empty object for a plain Error with no prefix and no own properties", () => {
    const err = new Error("just a message");
    expect(readGitErrorFields(err)).toEqual({
      gitReason: undefined,
      leaseSha: undefined,
      branchName: undefined,
    });
  });
});

describe("isSortKey", () => {
  it("accepts the three documented sort keys", () => {
    expect(isSortKey("path")).toBe(true);
    expect(isSortKey("status")).toBe(true);
    expect(isSortKey("churn")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isSortKey("")).toBe(false);
    expect(isSortKey("size")).toBe(false);
    expect(isSortKey("PATH")).toBe(false);
  });
});

describe("sortFiles", () => {
  it("sorts by path ascending alphabetically", () => {
    const files = [file("c.ts"), file("a.ts"), file("b.ts")];
    expect(sortFiles(files, "path", "asc").map((f) => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("sorts by path descending", () => {
    const files = [file("a.ts"), file("c.ts"), file("b.ts")];
    expect(sortFiles(files, "path", "desc").map((f) => f.path)).toEqual(["c.ts", "b.ts", "a.ts"]);
  });

  it("sorts by churn descending — highest total touches first", () => {
    const files = [
      file("small.ts", { insertions: 1, deletions: 1 }),
      file("big.ts", { insertions: 80, deletions: 20 }),
      file("medium.ts", { insertions: 10, deletions: 5 }),
    ];
    expect(sortFiles(files, "churn", "desc").map((f) => f.path)).toEqual([
      "big.ts",
      "medium.ts",
      "small.ts",
    ]);
  });

  it("sorts by churn ascending — lowest total first", () => {
    const files = [
      file("big.ts", { insertions: 80, deletions: 20 }),
      file("small.ts", { insertions: 1, deletions: 1 }),
      file("medium.ts", { insertions: 10, deletions: 5 }),
    ];
    expect(sortFiles(files, "churn", "asc").map((f) => f.path)).toEqual([
      "small.ts",
      "medium.ts",
      "big.ts",
    ]);
  });

  it("treats null insertions/deletions as zero churn", () => {
    const files = [
      file("real.ts", { insertions: 5, deletions: 5 }),
      file("unknown.ts", { insertions: null, deletions: null }),
      file("half.ts", { insertions: 3, deletions: null }),
    ];
    expect(sortFiles(files, "churn", "desc").map((f) => f.path)).toEqual([
      "real.ts",
      "half.ts",
      "unknown.ts",
    ]);
  });

  it("falls back to path when churn ties (ascending)", () => {
    const files = [
      file("zeta.ts", { insertions: 2, deletions: 2 }),
      file("alpha.ts", { insertions: 2, deletions: 2 }),
      file("mike.ts", { insertions: 2, deletions: 2 }),
    ];
    expect(sortFiles(files, "churn", "asc").map((f) => f.path)).toEqual([
      "alpha.ts",
      "mike.ts",
      "zeta.ts",
    ]);
  });

  it("reverses the path tiebreak under churn descending — uniform dir flip", () => {
    const files = [
      file("alpha.ts", { insertions: 2, deletions: 2 }),
      file("zeta.ts", { insertions: 2, deletions: 2 }),
      file("mike.ts", { insertions: 2, deletions: 2 }),
    ];
    expect(sortFiles(files, "churn", "desc").map((f) => f.path)).toEqual([
      "zeta.ts",
      "mike.ts",
      "alpha.ts",
    ]);
  });

  it("groups by status order when sorting by status", () => {
    const files = [
      file("a.ts", { status: "deleted" }),
      file("b.ts", { status: "modified" }),
      file("c.ts", { status: "added" }),
    ];
    expect(sortFiles(files, "status", "asc").map((f) => f.path)).toEqual(["b.ts", "c.ts", "a.ts"]);
  });

  it("pins generated files last when sorting by path ascending", () => {
    const files = [
      file("src/index.ts"),
      file("yarn.lock"),
      file("README.md"),
      file("src/foo.min.js"),
    ];
    expect(sortFiles(files, "path", "asc").map((f) => f.path)).toEqual([
      "README.md",
      "src/index.ts",
      "src/foo.min.js",
      "yarn.lock",
    ]);
  });

  it("pins generated files last when sorting by path descending — direction-independent", () => {
    const files = [
      file("src/index.ts"),
      file("yarn.lock"),
      file("README.md"),
      file("src/foo.min.js"),
    ];
    expect(sortFiles(files, "path", "desc").map((f) => f.path)).toEqual([
      "src/index.ts",
      "README.md",
      "yarn.lock",
      "src/foo.min.js",
    ]);
  });

  it("pins generated files last when sorting by churn even if they have higher churn", () => {
    const files = [
      file("src/app.ts", { insertions: 10, deletions: 2 }),
      file("yarn.lock", { insertions: 5000, deletions: 4000 }),
      file("src/util.ts", { insertions: 3, deletions: 1 }),
    ];
    expect(sortFiles(files, "churn", "desc").map((f) => f.path)).toEqual([
      "src/app.ts",
      "src/util.ts",
      "yarn.lock",
    ]);
  });

  it("pins generated files last when sorting by status", () => {
    const files = [
      file("src/a.ts", { status: "modified" }),
      file("dist/bundle.js", { status: "added" }),
      file("src/b.ts", { status: "added" }),
    ];
    expect(sortFiles(files, "status", "asc").map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "dist/bundle.js",
    ]);
  });

  it("pins generated files last when sorting by status descending — direction-independent", () => {
    const files = [
      file("src/a.ts", { status: "modified" }),
      file("dist/bundle.js", { status: "added" }),
      file("src/b.ts", { status: "added" }),
    ];
    expect(sortFiles(files, "status", "desc").map((f) => f.path)).toEqual([
      "src/b.ts",
      "src/a.ts",
      "dist/bundle.js",
    ]);
  });

  it("pins generated files last when sorting by churn ascending (default first-click direction)", () => {
    const files = [
      file("src/util.ts", { insertions: 1, deletions: 0 }),
      file("yarn.lock", { insertions: 0, deletions: 0 }),
      file("src/app.ts", { insertions: 5, deletions: 2 }),
    ];
    expect(sortFiles(files, "churn", "asc").map((f) => f.path)).toEqual([
      "src/util.ts",
      "src/app.ts",
      "yarn.lock",
    ]);
  });

  it("does not mutate the input array", () => {
    const files = [file("b.ts"), file("a.ts")];
    const before = files.map((f) => f.path);
    sortFiles(files, "path", "asc");
    expect(files.map((f) => f.path)).toEqual(before);
  });
});

describe("resolveBulkScope", () => {
  const view = (overrides: Partial<typeof DEFAULT_SECTION_STATE> = {}) => ({
    ...DEFAULT_SECTION_STATE,
    ...overrides,
  });

  it("reports 'shown' for every way a section can be narrowed, not just a query", () => {
    // The rule: if ANYTHING is hiding rows, the scope is 'shown'. The bug this
    // pins is a scope that considered only `filterQuery`, so hiding generated
    // files produced an "all" label over a shown-only action.
    const narrowed = [view({ filterQuery: "src" }), view({ showGenerated: false })];
    for (const v of narrowed) {
      expect(resolveBulkScope(v, false)).toBe("shown");
    }
  });

  it("only reports 'all' when nothing is narrowing the section", () => {
    expect(resolveBulkScope(view(), false)).toBe("all");
  });

  it("lets selection win over every narrowing cause", () => {
    const combos = [
      view(),
      view({ filterQuery: "src" }),
      view({ showGenerated: false }),
      view({ filterQuery: "src", showGenerated: false }),
    ];
    for (const v of combos) {
      expect(resolveBulkScope(v, true)).toBe("selection");
    }
  });

  it("never reports 'all' while any narrowing flag is set, across the whole state space", () => {
    for (const filterQuery of ["", "src"]) {
      for (const showGenerated of [true, false]) {
        const v = view({ filterQuery, showGenerated });
        const isNarrowed = filterQuery !== "" || !showGenerated;
        expect(resolveBulkScope(v, false) === "all").toBe(!isNarrowed);
      }
    }
  });
});

describe("countNonDefaultView", () => {
  it("returns zero for the defaults", () => {
    expect(countNonDefaultView(DEFAULT_SECTION_STATE)).toBe(0);
  });

  it("counts each diverging setting once, and sort key+direction as one", () => {
    const bump = (overrides: Partial<typeof DEFAULT_SECTION_STATE>) =>
      countNonDefaultView({ ...DEFAULT_SECTION_STATE, ...overrides });

    expect(bump({ sortKey: "churn" })).toBe(1);
    expect(bump({ sortDir: "desc" })).toBe(1);
    // Both halves of the same decision still count once.
    expect(bump({ sortKey: "churn", sortDir: "desc" })).toBe(1);
    expect(bump({ density: "compact" })).toBe(1);
    expect(bump({ showGenerated: false })).toBe(1);
    expect(bump({ sortKey: "churn", density: "compact", showGenerated: false })).toBe(3);
  });

  it("ignores the filter query, which has its own always-visible field", () => {
    expect(countNonDefaultView({ ...DEFAULT_SECTION_STATE, filterQuery: "src" })).toBe(0);
  });
});
