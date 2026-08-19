import { describe, expect, it } from "vitest";
import {
  isFilterMatch,
  scoreProjectQuery,
  scoreScratchQuery,
  rankSwitcherMatches,
  QUIET_SEARCH_ACTIVITY,
  computeSearchActivityKey,
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
    expect(rankSwitcherMatches("", projects, [], null)).toEqual([]);
    expect(rankSwitcherMatches("  ", projects, [], null)).toEqual([]);
  });

  it("filters out non-matching projects", () => {
    const results = rankSwitcherMatches("xyz", projects, [], null);
    expect(results).toHaveLength(0);
  });

  it("ranks exact name substring matches first", () => {
    const results = rankSwitcherMatches("daintree", projects, [], null);
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
    const results = rankSwitcherMatches("alpha", tieProjects, [], null);
    expect(results[0]!.id).toBe("b"); // higher frecencyScore wins
  });

  it("trims whitespace from query before matching", () => {
    const results = rankSwitcherMatches("  daintree  ", projects, [], null);
    const resultsClean = rankSwitcherMatches("daintree", projects, [], null);
    expect(results).toHaveLength(resultsClean.length);
    expect(results.map((r) => r.id)).toEqual(resultsClean.map((r) => r.id));
  });

  it("returns all matching projects, not just top N", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeProject({ id: `p${i}`, name: `project-${i}`, path: `/repos/p${i}`, lastOpened: i })
    );
    const results = rankSwitcherMatches("project", many, [], null);
    expect(results).toHaveLength(20);
  });

  it("leaves project ordering untouched when a scratch ranks between two projects", () => {
    // The scratch has to land BETWEEN the projects, or "append the scratches"
    // would satisfy this too. Frecency also opposes input order, so a ranker
    // that dropped the tiebreak while merging still fails.
    const strong = makeProject({ id: "strong", name: "alpha", path: "/repos/alpha" });
    const weak = makeProject({ id: "weak", name: "a-l-p-h-a", path: "/zzz", frecencyScore: 99 });
    const scratch = makeScratch({ id: "mid", name: "alpha-spike" });

    const mixed = rankSwitcherMatches("alpha", [weak, strong], [scratch], null);

    expect(mixed.map((r) => r.id)).toEqual(["strong", "mid", "weak"]);
    // And the projects keep the order they had with no scratch in the pool.
    expect(mixed.filter((r) => r.kind === "project").map((r) => r.id)).toEqual(
      rankSwitcherMatches("alpha", [weak, strong], [], null).map((r) => r.id)
    );
  });

  it("tags every row with its kind", () => {
    const results = rankSwitcherMatches(
      "alpha",
      [makeProject({ id: "p", name: "alpha-app", path: "/repos/alpha" })],
      [makeScratch({ id: "s", name: "alpha-notes" })],
      null
    );
    expect(results.map((r) => r.kind).sort()).toEqual(["project", "scratch"]);
  });

  it("filters scratches by the query rather than listing them all", () => {
    const scratches = [
      makeScratch({ id: "s1", name: "auth-notes" }),
      makeScratch({ id: "s2", name: "billing-spike" }),
    ];
    const results = rankSwitcherMatches("auth", [], scratches, null);
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

    expect(rankSwitcherMatches("release", [project], [scratch], null).map((r) => r.id)).toEqual([
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
      [makeScratch({ id: "s", name: "auth-notes" })],
      null
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
      ],
      null
    );
    expect(results.map((r) => r.id)).toEqual(["new", "old"]);
  });
});

describe("rankSwitcherMatches activity ordering", () => {
  // The four real workspaces from #11861. Every name starts with "Daintree" and
  // every path sits under the same parent, which is what made all four score
  // identically at every prefix.
  const DAINTREE_ROOT = "/Users/gpriday/Projects/Daintree";

  function daintreeFixture(): SearchableProject[] {
    return [
      makeProject({
        id: "daintree",
        name: "Daintree",
        path: `${DAINTREE_ROOT}/daintree`,
        frecencyScore: 163.2,
        activeAgentCount: 1,
      }),
      makeProject({
        id: "backend",
        name: "Daintree Assistant Backend",
        path: `${DAINTREE_ROOT}/assistant-backend`,
        frecencyScore: 102.3,
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
      }),
      makeProject({
        id: "assistant",
        name: "Daintree Assistant",
        path: `${DAINTREE_ROOT}/assistant`,
        frecencyScore: 75.6,
        waitingAgentCount: 2,
      }),
      makeProject({
        id: "website",
        name: "Daintree Website",
        path: `${DAINTREE_ROOT}/website`,
        frecencyScore: 12.7,
        waitingAgentCount: 1,
        blockedAgentCount: 1,
      }),
    ];
  }

  it("keeps every shared-prefix name in one cohort, whatever trails the match", () => {
    // The suffixes differ in length and the paths differ in tail, but none of
    // that may split the cohort — a cohort that splits has activity ordering
    // rows that were never comparable in the first place.
    const projects = daintreeFixture();
    // Frecency runs the other way, so the comparator this replaces returns the
    // exact reverse of the expectation below at every one of these queries.
    expect(
      [...projects].sort((a, b) => b.frecencyScore - a.frecencyScore).map((p) => p.id)
    ).toEqual(["daintree", "backend", "assistant", "website"]);

    for (const query of ["d", "dai", "daint"]) {
      expect(rankSwitcherMatches(query, projects, [], null).map((r) => r.id)).toEqual([
        "website", // blocked
        "assistant", // waiting
        "backend", // unreviewed completion
        "daintree", // working
      ]);
    }
  });

  it("keeps a dormant exact name first against prefix matches that are on fire", () => {
    const projects = daintreeFixture().map((project) =>
      project.id === "daintree"
        ? makeProject({ ...project, frecencyScore: 0, lastOpened: 0, activeAgentCount: 0 })
        : makeProject({ ...project, waitingAgentCount: 40, blockedAgentCount: 40 })
    );

    expect(rankSwitcherMatches("daintree", projects, [], null)[0]!.id).toBe("daintree");
    // One character short of the full name it is merely a prefix match again,
    // so the tier is what is carrying it rather than anything about the row.
    expect(rankSwitcherMatches("daintre", projects, [], null)[0]!.id).not.toBe("daintree");
  });

  it("orders an equal-quality cohort by what it is asking, loudest first", () => {
    const projects = [
      makeProject({ id: "quiet", name: "alpha-quiet", path: "/repos/alpha" }),
      makeProject({
        id: "work-1",
        name: "alpha-work-1",
        path: "/repos/alpha",
        activeAgentCount: 1,
      }),
      makeProject({
        id: "work-3",
        name: "alpha-work-3",
        path: "/repos/alpha",
        activeAgentCount: 3,
      }),
      makeProject({
        id: "review",
        name: "alpha-review",
        path: "/repos/alpha",
        completedAgentCount: 2,
        unacknowledgedCompletedAgentCount: 2,
      }),
      makeProject({
        id: "wait-1",
        name: "alpha-wait-1",
        path: "/repos/alpha",
        waitingAgentCount: 1,
      }),
      makeProject({
        id: "wait-3",
        name: "alpha-wait-3",
        path: "/repos/alpha",
        waitingAgentCount: 3,
      }),
    ];

    expect(rankSwitcherMatches("alpha", projects, [], null).map((r) => r.id)).toEqual([
      "wait-3",
      "wait-1",
      "review",
      "work-3",
      "work-1",
      "quiet",
    ]);
  });

  it("never lets activity lift a row out of a weaker text tier", () => {
    // Forty blocked agents on a scattered subsequence and on a name that never
    // matched at all, against a prefix match asking for nothing.
    const projects = [
      makeProject({
        id: "loose",
        name: "a-l-p-h-a-x",
        path: "/repos/loose",
        waitingAgentCount: 40,
        blockedAgentCount: 40,
      }),
      makeProject({
        id: "path-only",
        name: "zeta",
        path: "/repos/alpha/zeta",
        waitingAgentCount: 40,
        blockedAgentCount: 40,
      }),
      makeProject({ id: "prefix", name: "alpha-core", path: "/repos/prefix" }),
    ];
    // Both decoys really do match, so they are being ordered rather than filtered.
    expect(scoreProjectQuery("alpha", "a-l-p-h-a-x", "/repos/loose")).toBeGreaterThan(0);
    expect(scoreProjectQuery("alpha", "zeta", "/repos/alpha/zeta")).toBeGreaterThan(0);

    expect(rankSwitcherMatches("alpha", projects, [], null).map((r) => r.id)).toEqual([
      "prefix",
      "loose",
      "path-only",
    ]);
  });

  it("does not let a shared path decide between two equally good names", () => {
    const decoy = makeProject({
      id: "decoy",
      name: "Daintree Website",
      path: `${DAINTREE_ROOT}/website`,
    });
    const busy = makeProject({
      id: "busy",
      name: "Daintree Assistant",
      path: "/opt/checkouts/assistant",
      waitingAgentCount: 1,
    });
    // The decoy's path really is worth more, so this proves the path term was
    // outranked rather than merely absent.
    expect(scoreProjectQuery("daint", decoy.name, decoy.path)).toBeGreaterThan(
      scoreProjectQuery("daint", busy.name, busy.path)
    );

    expect(rankSwitcherMatches("daint", [decoy, busy], [], null).map((r) => r.id)).toEqual([
      "busy",
      "decoy",
    ]);
  });

  it("ranks a busy scratch on its activity without giving it path relevance", () => {
    const project = makeProject({
      id: "p",
      name: "alpha-app",
      path: `${DAINTREE_ROOT}/alpha/alpha-app`,
    });
    const busyScratch = makeScratch({ id: "s", name: "alpha-notes", waitingAgentCount: 1 });
    // A scratch whose only claim on the query is its machine-generated folder,
    // and the busiest row in the pool.
    const uuidScratch = makeScratch({
      id: "alpha-9f8e7d6c",
      name: "unrelated",
      waitingAgentCount: 40,
      blockedAgentCount: 40,
    });
    expect(uuidScratch.path).toContain("alpha");

    expect(
      rankSwitcherMatches("alpha", [project], [busyScratch, uuidScratch], null).map((r) => r.id)
    ).toEqual(["s", "p"]);
  });

  it("orders the same rows the same way whatever order they arrive in", () => {
    // Rows alike on every key but their id, plus one that has to sort below all
    // of them. Any pair the comparator called equal would seat differently
    // across these orderings; an intransitive one would too.
    const projects = [
      makeProject({ id: "p-a", name: "alpha", path: "/repos/alpha" }),
      makeProject({ id: "p-b", name: "alpha", path: "/repos/alpha" }),
      makeProject({ id: "p-c", name: "alpha", path: "/repos/alpha" }),
      makeProject({
        id: "loose",
        name: "a-l-p-h-a-z",
        path: "/repos/loose",
        waitingAgentCount: 40,
        blockedAgentCount: 40,
        frecencyScore: 999,
      }),
    ];
    const scratches = [
      makeScratch({ id: "s-a", name: "alpha", lastOpened: 5 }),
      makeScratch({ id: "s-b", name: "alpha", lastOpened: 5 }),
      makeScratch({ id: "s-c", name: "alpha", lastOpened: 5 }),
    ];

    function permutations<T>(items: T[]): T[][] {
      if (items.length <= 1) return [items];
      return items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
          item,
          ...rest,
        ])
      );
    }

    // The ranker takes the two kinds as separate arrays, so this IS every
    // distinct input the palette can hand it for this fixture.
    const projectOrders = permutations(projects);
    const scratchOrders = permutations(scratches);
    expect(projectOrders.length * scratchOrders.length).toBe(144);

    const expected = ["p-a", "p-b", "p-c", "s-a", "s-b", "s-c", "loose"];
    for (const projectOrder of projectOrders) {
      for (const scratchOrder of scratchOrders) {
        const ids = rankSwitcherMatches("alpha", projectOrder, scratchOrder, null).map((r) => r.id);
        expect(ids).toEqual(expected);
      }
    }
  });

  it("leaves the filter's threshold to the filter, and the ranker without one", () => {
    // Both surfaces read the same raw `scoreField` output against different
    // bars. Rescaling it to a ratio would move both at once; each half of this
    // pins one side.
    const RESEARCH_TITLE = "Research file browser folder selection usability";
    expect(isFilterMatch("fltsnp", "fleet snapshot service")).toBe(true);
    expect(isFilterMatch("rust", RESEARCH_TITLE)).toBe(false);

    // The ranker has no floor, so the query the filter rejects still ranks —
    // it just sorts last, which is the backstop the filter does not have.
    const scattered = makeProject({ id: "scattered", name: RESEARCH_TITLE, path: "/repos/notes" });
    expect(rankSwitcherMatches("rust", [scattered], [], null).map((r) => r.id)).toEqual([
      "scattered",
    ]);
  });
});

describe("rankSwitcherMatches activity classification", () => {
  // One shared path so every row's text score is identical and only activity —
  // then, on an activity tie, the name — can order them.
  function row(id: string, overrides: Partial<SearchableProject> = {}): SearchableProject {
    return makeProject({ id, name: `alpha-${id}`, path: "/repos/alpha", ...overrides });
  }

  function rank(projects: SearchableProject[]): string[] {
    return rankSwitcherMatches("alpha", projects, [], null).map((r) => r.id);
  }

  it("puts a blocked agent above a larger pool of merely waiting ones", () => {
    expect(
      rank([
        row("waiting", { waitingAgentCount: 5 }),
        row("blocked", { waitingAgentCount: 1, blockedAgentCount: 1 }),
      ])
    ).toEqual(["blocked", "waiting"]);
  });

  it("sizes the blocked class by its own count, not by the waits it is a subset of", () => {
    // "a-fewer-blocked" has the bigger waiting pool and the smaller blocked one.
    // Summing the two would put it first; so would reading `waitingAgentCount`.
    // Its name also sorts first, so a tie would too — only the subset count
    // produces the expectation below.
    const fewerBlocked = row("a-fewer-blocked", { waitingAgentCount: 5, blockedAgentCount: 2 });
    const moreBlocked = row("z-more-blocked", { waitingAgentCount: 3, blockedAgentCount: 3 });
    expect(rank([fewerBlocked, moreBlocked])).toEqual(["z-more-blocked", "a-fewer-blocked"]);
  });

  it("lets an assistant escalate a row nothing else is asking about", () => {
    // Named so the name tie-break runs the OTHER way: with no assistant
    // classification at all these four are equally quiet and come back
    // alphabetically, which is the exact reverse of the expectation.
    expect(
      rank([
        row("a-dormant"),
        row("b-working", { assistantState: "working" }),
        row("c-unseen", {
          assistantState: "waiting",
          assistantStateSince: 500,
          lastOpened: 100,
        }),
        row("d-blocked", { assistantState: "waiting", assistantWaitingReason: "error" }),
      ])
    ).toEqual(["d-blocked", "c-unseen", "b-working", "a-dormant"]);
  });

  it("counts an escalated assistant as one presence, never as part of a worker tally", () => {
    // Three workers waiting plus an unseen assistant, against four workers
    // waiting. Folding the assistant into the tally makes the first row four as
    // well, and its name wins the tie — so that bug produces the reverse of this.
    const mixed = row("a-mixed", {
      waitingAgentCount: 3,
      assistantState: "waiting",
      assistantStateSince: 500,
      lastOpened: 100,
    });
    const workers = row("z-workers", { waitingAgentCount: 4 });
    expect(rank([mixed, workers])).toEqual(["z-workers", "a-mixed"]);
    expect(rank([workers, mixed])).toEqual(["z-workers", "a-mixed"]);
  });

  it("does not let an assistant re-tier a row a worker already spoke for", () => {
    // A worker waiting alongside an assistant that has failed. The row is a
    // wait — the tier its status line will also report — not a block. Letting
    // the assistant speak would tie the two in the blocked class, where the
    // name tie-break returns the reverse of this.
    const workerWait = row("a-worker-wait", {
      waitingAgentCount: 1,
      assistantState: "waiting",
      assistantWaitingReason: "error",
    });
    const workerBlocked = row("z-worker-blocked", { waitingAgentCount: 1, blockedAgentCount: 1 });
    expect(rank([workerWait, workerBlocked])).toEqual(["z-worker-blocked", "a-worker-wait"]);
  });

  it("treats a seen assistant wait, snoozed runs, acknowledged work and processes as quiet", () => {
    // Named so every one of these four sits BELOW where a promotion would put
    // it: the demanding row sorts last alphabetically and still leads, and
    // "y-acknowledged" sorts last of the quiet run, so a completion wrongly
    // read as unreviewed would jump it to second.
    const ranked = rank([
      row("b-seen-wait", { assistantState: "waiting", assistantStateSince: 100, lastOpened: 500 }),
      row("c-snoozed", { snoozedAgentCount: 4, nextSnoozeWakeAt: 999 }),
      row("y-acknowledged", { completedAgentCount: 4, unacknowledgedCompletedAgentCount: 0 }),
      row("a-processes", { processCount: 9 }),
      row("z-busy", { waitingAgentCount: 1 }),
    ]);

    expect(ranked).toEqual(["z-busy", "a-processes", "b-seen-wait", "c-snoozed", "y-acknowledged"]);
  });

  it("still reads a snoozed working run as working, exactly as browse does", () => {
    // Snooze withholds a run from the demanding tallies, not from the working
    // one — `activeAgentCount` keeps counting it, in main and in browse's
    // Running band alike. Search must not net it out on its own.
    expect(
      rank([row("dormant"), row("snoozed-worker", { activeAgentCount: 1, snoozedAgentCount: 1 })])
    ).toEqual(["snoozed-worker", "dormant"]);
  });
});

describe("rankSwitcherMatches frozen activity", () => {
  const busy = makeProject({
    id: "busy",
    name: "alpha-busy",
    path: "/repos/alpha",
    waitingAgentCount: 3,
  });
  const calm = makeProject({ id: "calm", name: "alpha-calm", path: "/repos/alpha" });
  // Taken from the helper rather than written out, so the fixture cannot drift
  // from — or quietly restate — how a key is encoded.
  const WAS_WAITING = computeSearchActivityKey(busy);

  it("ranks on the snapshot rather than on the rows' live counts", () => {
    // The snapshot says the calm row was the busy one when the palette opened.
    // The live counts say the opposite, and must not move anything.
    const snapshot = new Map([
      ["calm", WAS_WAITING],
      ["busy", QUIET_SEARCH_ACTIVITY],
    ]);
    expect(rankSwitcherMatches("alpha", [busy, calm], [], snapshot).map((r) => r.id)).toEqual([
      "calm",
      "busy",
    ]);
    // Without a snapshot the same rows rank the other way, so the fixture is
    // not quietly agreeing with itself.
    expect(rankSwitcherMatches("alpha", [busy, calm], [], null).map((r) => r.id)).toEqual([
      "busy",
      "calm",
    ]);
  });

  it("reads a row the snapshot never saw as quiet, not as whatever it is doing now", () => {
    // A row that registered mid-session. Falling back to its live counts would
    // put it back on the stats push the freeze exists to insulate it from.
    const snapshot = new Map([["calm", WAS_WAITING]]);
    expect(rankSwitcherMatches("alpha", [busy, calm], [], snapshot).map((r) => r.id)).toEqual([
      "calm",
      "busy",
    ]);
  });
});
