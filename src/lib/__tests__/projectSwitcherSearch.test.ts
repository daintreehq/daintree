import { describe, expect, it } from "vitest";
import {
  scoreProjectQuery,
  scoreScratchQuery,
  rankSwitcherMatches,
} from "../projectSwitcherSearch";
import type { SearchableProject, SearchableScratch } from "@/hooks/useProjectSwitcherPalette";

function makeScratch(
  overrides: Partial<SearchableScratch> & { id: string; name: string }
): SearchableScratch {
  return {
    path: `/userData/scratch/${overrides.id}`,
    createdAt: 0,
    lastOpened: 0,
    isActive: false,
    ...overrides,
  };
}

function makeProject(
  overrides: Partial<SearchableProject> & { id: string; name: string; path: string }
): SearchableProject {
  return {
    emoji: "🌲",
    lastOpened: 0,
    status: "active",
    isActive: false,
    isBackground: false,
    isMissing: false,
    isPinned: false,
    frecencyScore: 3.0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    processCount: 0,
    section: "other",
    displayPath: overrides.path.split("/").filter(Boolean).pop() ?? overrides.path,
    ...overrides,
  };
}

describe("scoreProjectQuery", () => {
  it("returns 0 for empty query", () => {
    expect(scoreProjectQuery("", "project", "/path")).toBe(0);
  });

  it("returns 0 when query has no subsequence match", () => {
    expect(scoreProjectQuery("xyz", "project", "/repo/app")).toBe(0);
  });

  it("scores exact name substring higher than path-only match", () => {
    const nameMatch = scoreProjectQuery("daintree", "my-daintree-app", "/some/path");
    const pathMatch = scoreProjectQuery("daintree", "other", "/long/path/to/daintree/stuff");
    expect(nameMatch).toBeGreaterThan(pathMatch);
  });

  it("gives word boundary bonus: 'dp' at boundary beats mid-word", () => {
    const boundaryMatch = scoreProjectQuery("dp", "app-dplant", "/path");
    const midWordMatch = scoreProjectQuery("dp", "xdplant", "/path");
    expect(boundaryMatch).toBeGreaterThan(midWordMatch);
  });

  it("gives consecutive run bonus: 'pro' prefix beats scattered", () => {
    const prefix = scoreProjectQuery("pro", "project", "/path");
    const scattered = scoreProjectQuery("pro", "p-random-on", "/path");
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("detects camelCase boundaries", () => {
    const camelMatch = scoreProjectQuery("mC", "myCoolApp", "/path");
    expect(camelMatch).toBeGreaterThan(0);
    // The C in CoolApp should get a boundary bonus
    const midMatch = scoreProjectQuery("mC", "micron", "/path");
    // mC doesn't match micron (no uppercase C)
    // Actually lowercase matching: "mc" vs "mi" - 'c' won't match in micron
    expect(camelMatch).toBeGreaterThan(midMatch);
  });

  it("weights name 4x over path", () => {
    const nameHit = scoreProjectQuery("foo", "foo-app", "/other/path");
    const pathHit = scoreProjectQuery("foo", "other-app", "/some/foo/path");
    expect(nameHit).toBeGreaterThan(pathHit);
  });

  it("handles backslash as path boundary", () => {
    const score = scoreProjectQuery("fb", "app", "C:\\foo\\bar");
    expect(score).toBeGreaterThan(0);
  });

  it("does not drop matches due to negative field scores (long gap clamping)", () => {
    const longName = "a" + "x".repeat(50) + "b" + "x".repeat(50) + "c";
    const score = scoreProjectQuery("abc", longName, "/repos/abc");
    expect(score).toBeGreaterThan(0);
  });
});

describe("scoreScratchQuery", () => {
  it("returns 0 for empty query", () => {
    expect(scoreScratchQuery("", "scratch")).toBe(0);
  });

  it("returns 0 when query has no subsequence match", () => {
    expect(scoreScratchQuery("xyz", "auth-notes")).toBe(0);
  });

  it("scores name identically to a project whose path contributes nothing", () => {
    // The two scales have to be directly comparable for the mixed ranker's
    // score-first ordering to mean anything.
    expect(scoreScratchQuery("auth", "auth-notes")).toBe(
      scoreProjectQuery("auth", "auth-notes", "zzz")
    );
  });

  it("ignores the path, which for a scratch is a UUID directory", () => {
    const scratch = makeScratch({ id: "9f8e7d6c", name: "notes" });
    // A query lifted straight out of the scratch's own folder name must not
    // surface it — that path is machine-generated, not something a user typed.
    expect(scoreScratchQuery("9f8e7d6c", scratch.name)).toBe(0);
    expect(scoreProjectQuery("9f8e7d6c", scratch.name, scratch.path)).toBeGreaterThan(0);
  });
});

describe("rankSwitcherMatches", () => {
  const projects = [
    makeProject({ id: "1", name: "daintree-app", path: "/repos/daintree-app", lastOpened: 100 }),
    makeProject({ id: "2", name: "other-project", path: "/repos/other", lastOpened: 200 }),
    makeProject({ id: "3", name: "my-daintree", path: "/repos/my-daintree", lastOpened: 50 }),
  ];

  it("returns empty for empty query", () => {
    expect(rankSwitcherMatches("", projects, [])).toEqual([]);
    expect(rankSwitcherMatches("  ", projects, [])).toEqual([]);
  });

  it("filters out non-matching projects", () => {
    const results = rankSwitcherMatches("xyz", projects, []);
    expect(results).toHaveLength(0);
  });

  it("ranks exact name substring matches first", () => {
    const results = rankSwitcherMatches("daintree", projects, []);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.name).toContain("daintree");
  });

  it("uses frecencyScore as tiebreaker for equal text scores", () => {
    const tieProjects = [
      makeProject({
        id: "a",
        name: "alpha-test",
        path: "/repos/a",
        frecencyScore: 2.0,
      }),
      makeProject({
        id: "b",
        name: "alpha-test",
        path: "/repos/b",
        frecencyScore: 5.0,
      }),
    ];
    const results = rankSwitcherMatches("alpha", tieProjects, []);
    expect(results[0]!.id).toBe("b"); // higher frecencyScore wins
  });

  it("trims whitespace from query before matching", () => {
    const results = rankSwitcherMatches("  daintree  ", projects, []);
    const resultsClean = rankSwitcherMatches("daintree", projects, []);
    expect(results).toHaveLength(resultsClean.length);
    expect(results.map((r) => r.id)).toEqual(resultsClean.map((r) => r.id));
  });

  it("returns all matching projects, not just top N", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeProject({ id: `p${i}`, name: `project-${i}`, path: `/repos/p${i}`, lastOpened: i })
    );
    const results = rankSwitcherMatches("project", many, []);
    expect(results).toHaveLength(20);
  });

  it("leaves project ordering untouched when scratches are added to the pool", () => {
    // Merging scratches must not reshuffle the projects around them, or search
    // order would shift under a user who never asked for one.
    const scratches = [
      makeScratch({ id: "s1", name: "daintree-scratch" }),
      makeScratch({ id: "s2", name: "unrelated" }),
    ];
    const projectOnly = rankSwitcherMatches("daintree", projects, []).map((r) => r.id);
    const mixed = rankSwitcherMatches("daintree", projects, scratches);
    expect(mixed.filter((r) => r.kind === "project").map((r) => r.id)).toEqual(projectOnly);
  });

  it("tags every row with its kind", () => {
    const results = rankSwitcherMatches(
      "alpha",
      [makeProject({ id: "p", name: "alpha-app", path: "/repos/alpha" })],
      [makeScratch({ id: "s", name: "alpha-notes" })]
    );
    expect(results.map((r) => r.kind).sort()).toEqual(["project", "scratch"]);
  });

  it("filters scratches by the query rather than listing them all", () => {
    const scratches = [
      makeScratch({ id: "s1", name: "auth-notes" }),
      makeScratch({ id: "s2", name: "billing-spike" }),
    ];
    const results = rankSwitcherMatches("auth", [], scratches);
    expect(results.map((r) => r.id)).toEqual(["s1"]);
  });

  it("puts the project first when a project and a scratch match a name equally", () => {
    const results = rankSwitcherMatches(
      "release",
      [makeProject({ id: "p", name: "release", path: "/repos/release" })],
      [makeScratch({ id: "s", name: "release" })]
    );
    expect(results.map((r) => r.id)).toEqual(["p", "s"]);
  });

  it("ranks a scratch whose name contains the query above a loosely matching project", () => {
    // The whole point of the merge: typing a scratch's name has to reach it,
    // not a project that happened to share the letters in order.
    const results = rankSwitcherMatches(
      "auth",
      [makeProject({ id: "p", name: "a-u-t-h-elper", path: "/repos/auth-adjacent" })],
      [makeScratch({ id: "s", name: "auth-notes" })]
    );
    expect(results[0]!.id).toBe("s");
  });

  it("breaks scratch-vs-scratch ties on recency", () => {
    const results = rankSwitcherMatches(
      "notes",
      [],
      [
        makeScratch({ id: "old", name: "notes", lastOpened: 100 }),
        makeScratch({ id: "new", name: "notes", lastOpened: 900 }),
      ]
    );
    expect(results.map((r) => r.id)).toEqual(["new", "old"]);
  });
});
