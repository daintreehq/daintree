import { describe, expect, it } from "vitest";
import { scoreProjectQuery, rankProjectMatches } from "../projectSwitcherSearch";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

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
    activeAgentCount: 0,
    waitingAgentCount: 0,
    processCount: 0,
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
    const nameMatch = scoreProjectQuery("canopy", "my-canopy-app", "/some/path");
    const pathMatch = scoreProjectQuery("canopy", "other", "/long/path/to/canopy/stuff");
    expect(nameMatch).toBeGreaterThan(pathMatch);
  });

  it("gives word boundary bonus: 'cp' matching canopy-project beats mid-word", () => {
    const boundaryMatch = scoreProjectQuery("cp", "canopy-project", "/path");
    const midWordMatch = scoreProjectQuery("cp", "script-producer", "/path");
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

describe("rankProjectMatches", () => {
  const projects = [
    makeProject({ id: "1", name: "canopy-app", path: "/repos/canopy-app", lastOpened: 100 }),
    makeProject({ id: "2", name: "other-project", path: "/repos/other", lastOpened: 200 }),
    makeProject({ id: "3", name: "my-canopy", path: "/repos/my-canopy", lastOpened: 50 }),
  ];

  it("returns empty for empty query", () => {
    expect(rankProjectMatches("", projects)).toEqual([]);
    expect(rankProjectMatches("  ", projects)).toEqual([]);
  });

  it("filters out non-matching projects", () => {
    const results = rankProjectMatches("xyz", projects);
    expect(results).toHaveLength(0);
  });

  it("ranks exact name substring matches first", () => {
    const results = rankProjectMatches("canopy", projects);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].name).toContain("canopy");
  });

  it("uses lastOpened as tiebreaker for equal scores", () => {
    const tieProjects = [
      makeProject({ id: "a", name: "alpha-test", path: "/repos/a", lastOpened: 100 }),
      makeProject({ id: "b", name: "alpha-test", path: "/repos/b", lastOpened: 200 }),
    ];
    const results = rankProjectMatches("alpha", tieProjects);
    expect(results[0].id).toBe("b"); // higher lastOpened wins
  });

  it("trims whitespace from query before matching", () => {
    const results = rankProjectMatches("  canopy  ", projects);
    const resultsClean = rankProjectMatches("canopy", projects);
    expect(results).toHaveLength(resultsClean.length);
    expect(results.map((r) => r.id)).toEqual(resultsClean.map((r) => r.id));
  });

  it("returns all matching projects, not just top N", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeProject({ id: `p${i}`, name: `project-${i}`, path: `/repos/p${i}`, lastOpened: i })
    );
    const results = rankProjectMatches("project", many);
    expect(results).toHaveLength(20);
  });
});
