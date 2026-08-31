import { describe, expect, it } from "vitest";
import {
  buildStepMatrix,
  describeFixtureCoverage,
  getSidebarDerivationFixture,
  gradeDerivationSweep,
  REAL_SIDEBAR_SUBJECTS,
  runDerivationSweep,
  SIDEBAR_NEEDLE,
  type SidebarDerivationSubjects,
} from "../lib/sidebarDerivationFixture";
import { allScenarios } from "../scenarios";

/**
 * The four accumulators PERF-400..402 declare, watched failing.
 *
 * Each arm below breaks ONE subject at the module boundary — no product file is
 * touched — and the test asserts that exactly the matching predicate goes
 * non-zero while the other three stay clean. A predicate nobody has watched
 * fail is untested, and cross-talk between them would mean the four are really
 * one aggregate wearing four names.
 */

const SIZE = 200;

function sweepWith(subjects?: SidebarDerivationSubjects) {
  const fixture = getSidebarDerivationFixture(SIZE);
  const passes = runDerivationSweep(fixture, buildStepMatrix(), subjects);
  return gradeDerivationSweep(fixture, passes).misses;
}

describe("sidebar derivation fixture", () => {
  it("plants a corpus the needle selects cleanly", () => {
    const fixture = getSidebarDerivationFixture(SIZE);
    expect(fixture.needleCount).toBeGreaterThan(0);
    expect(fixture.needleCount).toBeLessThan(fixture.size);
    // Every prefix of the needle must be an exact selector, which only holds
    // while its first character appears nowhere else in the corpus.
    const marker = SIDEBAR_NEEDLE[0];
    for (const planted of fixture.planted) {
      const carriesMarker =
        planted.worktree.name.includes(marker) ||
        (planted.worktree.branch ?? "").includes(marker) ||
        (planted.worktree.issueTitle ?? "").includes(marker) ||
        (planted.worktree.linked?.pr?.title ?? "").includes(marker);
      expect(carriesMarker).toBe(planted.relevance > 0);
    }
  });

  it("keeps the sweep off degenerate passes", () => {
    const coverage = describeFixtureCoverage(getSidebarDerivationFixture(SIZE));
    // Every facet level admits rows in browse mode, and the unfiltered query
    // sweep keeps a substantial fraction of the corpus.
    for (const row of coverage.filter((r) => r.queryLength === 0)) {
      expect(row.expectedKept).toBeGreaterThan(0);
    }
    const unfilteredQuery = coverage.find((r) => r.queryLength === 5 && r.activeGroups === 0);
    expect(unfilteredQuery?.expectedKept).toBeGreaterThan(10);
  });

  it("resolves each step's filter state before the bracket opens", () => {
    // A pass must not pay to assemble its own subject arguments.
    for (const step of buildStepMatrix()) {
      expect(step.filters.query).toBe(step.query);
      expect(step.query.length).toBe(step.queryLength);
    }
  });

  it("records the subjects' own arrays by reference rather than copying them", () => {
    // The recording a timed pass does has to be a pointer store: an id list
    // projected inside the bracket would put O(rows) of oracle prep back into
    // durationMs, which is the defect this split exists to close. A sort that
    // hands its input straight back proves it — the observation holds the very
    // array the subject returned.
    const fixture = getSidebarDerivationFixture(SIZE);
    const passes = runDerivationSweep(fixture, buildStepMatrix(), {
      ...REAL_SIDEBAR_SUBJECTS,
      sortWorktreesByRelevance: (worktrees) => worktrees,
    });
    expect(passes.length).toBe(18);
    for (const pass of passes) {
      expect(pass.sorted).toBe(pass.kept);
    }
  });

  it("clears every predicate on the real subjects", () => {
    expect(sweepWith()).toEqual({
      keptMisses: 0,
      chipCountMisses: 0,
      sortMisses: 0,
      groupMisses: 0,
    });
  });
});

describe("sidebar derivation predicates", () => {
  it("scores a filter that admits everything", () => {
    const misses = sweepWith({ ...REAL_SIDEBAR_SUBJECTS, matchesFilters: () => true });
    expect(misses.keptMisses).toBeGreaterThan(0);
    expect(misses.chipCountMisses).toBe(0);
  });

  it("scores a filter that admits nothing — the cheapest filter there is", () => {
    const misses = sweepWith({ ...REAL_SIDEBAR_SUBJECTS, matchesFilters: () => false });
    expect(misses.keptMisses).toBeGreaterThan(0);
  });

  it("scores a sort that returned its input untouched", () => {
    const misses = sweepWith({
      ...REAL_SIDEBAR_SUBJECTS,
      sortWorktreesByRelevance: (worktrees) => [...worktrees],
    });
    expect(misses.sortMisses).toBeGreaterThan(0);
    expect(misses.keptMisses).toBe(0);
    expect(misses.groupMisses).toBe(0);
  });

  it("scores a sort that dropped its rows", () => {
    const misses = sweepWith({ ...REAL_SIDEBAR_SUBJECTS, sortWorktreesByRelevance: () => [] });
    expect(misses.sortMisses).toBeGreaterThan(0);
  });

  it("scores grouping that produced no sections", () => {
    const misses = sweepWith({ ...REAL_SIDEBAR_SUBJECTS, groupByType: () => [] });
    expect(misses.groupMisses).toBeGreaterThan(0);
    expect(misses.sortMisses).toBe(0);
  });

  it("scores grouping that swept every row into one section", () => {
    const misses = sweepWith({
      ...REAL_SIDEBAR_SUBJECTS,
      groupByType: (worktrees) => [
        { type: "feature", displayName: "Features", worktrees: [...worktrees] },
      ],
    });
    expect(misses.groupMisses).toBeGreaterThan(0);
  });

  it("scores chip counts computed from ONE base set instead of six", () => {
    // The cheap wrong answer: skip the per-group filter variants and count the
    // fully-filtered set six times. It is ~6x faster and a kept-count predicate
    // alone would call it free.
    const misses = sweepWith({
      ...REAL_SIDEBAR_SUBJECTS,
      computeChipCounts: (worktrees, metaMap, activeId, filters, sessions) =>
        REAL_SIDEBAR_SUBJECTS.computeChipCounts(
          worktrees.filter((worktree) =>
            REAL_SIDEBAR_SUBJECTS.matchesFilters(
              worktree,
              filters,
              metaMap.get(worktree.id) ?? {
                terminalCount: 0,
                hasWorkingAgent: false,
                hasWaitingAgent: false,
                hasCompletedAgent: false,
                hasExitedAgent: false,
                hasMergeConflict: false,
                chipState: null,
              },
              worktree.id === activeId,
              sessions
            )
          ),
          metaMap,
          activeId,
          filters,
          sessions
        ),
    });
    expect(misses.chipCountMisses).toBeGreaterThan(0);
    expect(misses.keptMisses).toBe(0);
    expect(misses.sortMisses).toBe(0);
    expect(misses.groupMisses).toBe(0);
  });
});

describe("PERF-400..402", () => {
  const context = { mode: "smoke" as const, now: () => performance.now() };

  for (const id of ["PERF-400", "PERF-401", "PERF-402"]) {
    it(`${id} runs 18 graded derivation passes with a clean predicate`, async () => {
      const scenario = allScenarios.find((s) => s.id === id);
      expect(scenario).toBeDefined();
      const sample = await scenario!.run(context);
      const metrics = sample.metrics!;

      // 3 facet levels x 6 query lengths.
      expect(metrics.passCount).toBe(18);
      expect(metrics.keptRowCount).toBeGreaterThan(0);
      expect(metrics.keptMisses).toBe(0);
      expect(metrics.chipCountMisses).toBe(0);
      expect(metrics.sortMisses).toBe(0);
      expect(metrics.groupMisses).toBe(0);
      expect(Number.isFinite(sample.durationMs)).toBe(true);
    });
  }

  it("PERF-402 prices each operation separately", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-402")!;
    const metrics = (await scenario.run(context)).metrics!;
    for (const key of ["matchesFiltersMs", "sortMs", "groupMs", "chipCountsMs"]) {
      expect(metrics[key]).toBeGreaterThan(0);
    }
  });
});
