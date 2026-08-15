import { describe, expect, it } from "vitest";
import {
  isFilterMatch,
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
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    processCount: 0,
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
    snoozedAgentCount: 0,
    processCount: 0,
    section: "other",
    displayPath: overrides.path.split("/").filter(Boolean).pop() ?? overrides.path,
    ...overrides,
  };
}

describe("isFilterMatch", () => {
  const RESEARCH_TITLE = "Research file browser folder selection usability";

  it("rejects a blank query rather than matching every field", () => {
    // Whitespace is a substring of anything, so the substring bonus alone would
    // clear the floor.
    expect(isFilterMatch("", RESEARCH_TITLE)).toBe(false);
    expect(isFilterMatch("   ", RESEARCH_TITLE)).toBe(false);
  });

  it("rejects a subsequence whose characters are too far apart to pay for", () => {
    // The #11625 case: every character is present in order, none of them near
    // enough to the words they came from to read as a match.
    expect(isFilterMatch("rust", RESEARCH_TITLE)).toBe(false);
    expect(isFilterMatch("sv", "fleet snapshot service")).toBe(false);
    expect(isFilterMatch("ate", "Daintree")).toBe(false);
  });

  it("accepts an abbreviation anchored to the words it came from", () => {
    expect(isFilterMatch("fltsnp", "fleet snapshot service")).toBe(true);
    expect(isFilterMatch("fs", "fleet snapshot service")).toBe(true);
  });

  it("rejects a query spread across the words of a long title", () => {
    // Reading word initials instead of characters would let this through: the
    // initials spell "ctetsf1t2", and a query is free to skip as many words as
    // it likes on the way through them.
    expect(isFilterMatch("test", "cut the external tool surface from 100 to 24")).toBe(false);
    expect(isFilterMatch("ru", RESEARCH_TITLE)).toBe(false);
  });

  it("accepts anything typed contiguously, down to a single character", () => {
    // Incremental typing is always a substring, so the floor never interrupts
    // it — including a character sitting mid-word, which earns no boundary or
    // start bonus and survives on the substring short-circuit alone.
    expect(isFilterMatch("d", "Daintree")).toBe(true);
    expect(isFilterMatch("i", "Daintree")).toBe(true);
    expect(isFilterMatch("brow", RESEARCH_TITLE)).toBe(true);
  });

  it("accepts a contiguous match in a field long enough to outrun the score", () => {
    // Short fields hide the problem. The substring bonus feeds the same total
    // the gap penalties drain, so a short query far enough into a long field
    // scores under the floor even though it is literally the field's last word
    // — and agent-set titles, which this length is taken from, have no cap.
    const LONG_TITLE =
      "Reviewing the destructive-action safeguard audit and filing the missing confirm dialogs now";
    expect(LONG_TITLE.length).toBeGreaterThan(85);
    expect(isFilterMatch("now", LONG_TITLE)).toBe(true);
  });

  it("ignores whitespace the caller did not trim", () => {
    expect(isFilterMatch("  fltsnp  ", "fleet snapshot service")).toBe(true);
  });

  it("rejects a query whose characters are not all present", () => {
    expect(isFilterMatch("zzzz", "fleet snapshot service")).toBe(false);
  });
});

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

  it("leaves project ordering untouched when a scratch ranks between two projects", () => {
    // The scratch has to land BETWEEN the projects, or "append the scratches"
    // would satisfy this too. Frecency also opposes input order, so a ranker
    // that dropped the tiebreak while merging still fails.
    const strong = makeProject({ id: "strong", name: "alpha", path: "/repos/alpha" });
    const weak = makeProject({ id: "weak", name: "a-l-p-h-a", path: "/zzz", frecencyScore: 99 });
    const scratch = makeScratch({ id: "mid", name: "alpha-spike" });

    const mixed = rankSwitcherMatches("alpha", [weak, strong], [scratch]);

    expect(mixed.map((r) => r.id)).toEqual(["strong", "mid", "weak"]);
    // And the projects keep the order they had with no scratch in the pool.
    expect(mixed.filter((r) => r.kind === "project").map((r) => r.id)).toEqual(
      rankSwitcherMatches("alpha", [weak, strong], []).map((r) => r.id)
    );
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
    // The path scores 0, so the two land on an EXACT numeric tie and only the
    // kind tiebreak can order them. Give the project a matching path and it
    // wins on score instead, leaving the tiebreak untested.
    const project = makeProject({ id: "p", name: "release", path: "/zzz" });
    const scratch = makeScratch({ id: "s", name: "release" });
    expect(scoreProjectQuery("release", project.name, project.path)).toBe(
      scoreScratchQuery("release", scratch.name)
    );

    expect(rankSwitcherMatches("release", [project], [scratch]).map((r) => r.id)).toEqual([
      "p",
      "s",
    ]);
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
