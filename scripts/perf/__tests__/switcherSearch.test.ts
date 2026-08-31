import { describe, expect, it } from "vitest";
import {
  correctionPathSteps,
  getSwitcherFixture,
  gradeSwitcherSession,
  progressiveTypingSteps,
  REAL_SWITCHER_SUBJECTS,
  runSwitcherSession,
  SWITCHER_NEEDLE,
  type SwitcherSubjects,
} from "../lib/switcherSearchFixture";
import { allScenarios } from "../scenarios";

/**
 * The four accumulators PERF-403/404 declare, watched failing.
 *
 * Every arm breaks ONE subject at the module boundary — no product file is
 * touched — and asserts that exactly the matching predicate goes non-zero. The
 * two directions the brief calls out are separate arms: a ranker that returns
 * NOTHING and one that returns EVERYTHING in an arbitrary order have to fail
 * for different reasons, and both have to fail.
 */

const PROJECTS = 240;
const SCRATCHES = 60;

function typingMisses(subjects?: SwitcherSubjects) {
  const fixture = getSwitcherFixture(PROJECTS, SCRATCHES);
  const run = runSwitcherSession(fixture, progressiveTypingSteps(), subjects);
  return gradeSwitcherSession(fixture, run).misses;
}

describe("switcher search fixture", () => {
  it("plants a corpus the needle selects cleanly", () => {
    const fixture = getSwitcherFixture(PROJECTS, SCRATCHES);
    expect(fixture.needleInNameCount).toBeGreaterThan(0);
    expect(fixture.needleInPathOnlyCount).toBeGreaterThan(0);
    expect(fixture.needleInNameCount).toBeLessThan(fixture.rowCount);

    // Every prefix of the needle is an exact selector only while its first
    // character appears nowhere else in the corpus.
    const marker = SWITCHER_NEEDLE[0];
    for (const project of fixture.projects) {
      const planted = fixture.plantedById.get(project.id)!;
      expect(project.name.includes(marker)).toBe(planted.needleInName);
      expect(project.path.includes(marker)).toBe(planted.needleInPath);
    }
    for (const scratch of fixture.scratches) {
      const planted = fixture.plantedById.get(scratch.id)!;
      expect(scratch.name.includes(marker)).toBe(planted.needleInName);
    }
  });

  it("clears every predicate on the real subjects, on both paths", () => {
    const clean = {
      rankMisses: 0,
      scoreMisses: 0,
      filterMatchMisses: 0,
      pathFilterMatchMisses: 0,
      activityMisses: 0,
    };
    expect(typingMisses()).toEqual(clean);
    const fixture = getSwitcherFixture(PROJECTS, SCRATCHES);
    expect(
      gradeSwitcherSession(fixture, runSwitcherSession(fixture, correctionPathSteps())).misses
    ).toEqual(clean);
  });

  it("records the ranker's own result array by reference rather than copying it", () => {
    // Projecting result ids inside the bracket would put O(rows) of oracle prep
    // back into durationMs, which is the defect this split exists to close.
    const fixture = getSwitcherFixture(PROJECTS, SCRATCHES);
    const sentinel: ReturnType<SwitcherSubjects["rankSwitcherMatches"]> = [];
    const run = runSwitcherSession(fixture, progressiveTypingSteps(), {
      ...REAL_SWITCHER_SUBJECTS,
      rankSwitcherMatches: () => sentinel,
    });
    expect(run.keystrokes.length).toBe(SWITCHER_NEEDLE.length);
    for (const keystroke of run.keystrokes) {
      expect(keystroke.results).toBe(sentinel);
    }
  });

  it("degrades and recovers across the one-edit correction", () => {
    const fixture = getSwitcherFixture(PROJECTS, SCRATCHES);
    const result = runSwitcherSession(fixture, correctionPathSteps());
    const typo = result.keystrokes.filter((k) => k.step.kind === "typo");
    const clean = result.keystrokes.filter((k) => k.step.kind === "clean");
    expect(typo.length).toBeGreaterThan(0);
    // The typo tier keeps the name matches and loses the path-only ones — the
    // point of the tier is that the list narrows rather than emptying.
    const typoRows = typo[0].results.length;
    const cleanRows = clean[clean.length - 1].results.length;
    expect(typoRows).toBeGreaterThan(0);
    expect(typoRows).toBeLessThan(cleanRows);
    // And the last keystroke is back on the clean path.
    expect(clean[clean.length - 1].results[0].id).toBe(fixture.exactProjectId);
  });
});

describe("switcher search predicates", () => {
  it("scores a ranker that matched nothing", () => {
    const misses = typingMisses({ ...REAL_SWITCHER_SUBJECTS, rankSwitcherMatches: () => [] });
    expect(misses.rankMisses).toBeGreaterThan(0);
    expect(misses.scoreMisses).toBe(0);
    expect(misses.activityMisses).toBe(0);
  });

  it("scores a ranker that returned everything in an arbitrary order", () => {
    const misses = typingMisses({
      ...REAL_SWITCHER_SUBJECTS,
      rankSwitcherMatches: (_query, projects, scratches) => [
        ...scratches.map((scratch) => ({ kind: "scratch" as const, ...scratch })),
        ...projects.map((project) => ({ kind: "project" as const, ...project })),
      ],
    });
    expect(misses.rankMisses).toBeGreaterThan(0);
  });

  it("scores a scorer that returned zero for everything", () => {
    const misses = typingMisses({ ...REAL_SWITCHER_SUBJECTS, scoreProjectQuery: () => 0 });
    expect(misses.scoreMisses).toBeGreaterThan(0);
    expect(misses.filterMatchMisses).toBe(0);
  });

  it("scores a scorer that returned a positive constant for everything", () => {
    const misses = typingMisses({ ...REAL_SWITCHER_SUBJECTS, scoreProjectQuery: () => 1 });
    expect(misses.scoreMisses).toBeGreaterThan(0);
  });

  it("scores a filter matcher stuck open, and one stuck shut", () => {
    const open = typingMisses({ ...REAL_SWITCHER_SUBJECTS, isFilterMatch: () => true });
    expect(open.filterMatchMisses).toBeGreaterThan(0);
    expect(open.pathFilterMatchMisses).toBeGreaterThan(0);
    const shut = typingMisses({ ...REAL_SWITCHER_SUBJECTS, isFilterMatch: () => false });
    expect(shut.filterMatchMisses).toBeGreaterThan(0);
    expect(shut.pathFilterMatchMisses).toBeGreaterThan(0);
  });

  it("scores the display-path filter call being dropped, and only that term", () => {
    // The stub experiment the display-path term exists for: every per-project
    // isFilterMatch over displayPath returns false, which is what deleting the
    // call outright would record. The name term stays clean, so a single
    // aggregate would have called the deletion free.
    const misses = typingMisses({
      ...REAL_SWITCHER_SUBJECTS,
      isFilterMatch: (query, field) =>
        field.startsWith("~/") ? false : REAL_SWITCHER_SUBJECTS.isFilterMatch(query, field),
    });
    expect(misses.pathFilterMatchMisses).toBeGreaterThan(0);
    expect(misses.filterMatchMisses).toBe(0);
    expect(misses.rankMisses).toBe(0);
    expect(misses.scoreMisses).toBe(0);
  });

  it("scores the name filter call being dropped, and only that term", () => {
    const misses = typingMisses({
      ...REAL_SWITCHER_SUBJECTS,
      isFilterMatch: (query, field) =>
        field.startsWith("~/") ? REAL_SWITCHER_SUBJECTS.isFilterMatch(query, field) : false,
    });
    expect(misses.filterMatchMisses).toBeGreaterThan(0);
    expect(misses.pathFilterMatchMisses).toBe(0);
  });

  it("scores an activity classifier that returned a constant", () => {
    const misses = typingMisses({
      ...REAL_SWITCHER_SUBJECTS,
      computeSearchActivityKey: () => ({ activityClass: 0, activityVolume: 0 }),
    });
    expect(misses.activityMisses).toBeGreaterThan(0);
    expect(misses.rankMisses).toBe(0);
  });

  it("scores an activity classifier that kept its tiers but dropped its volumes", () => {
    // Tier ordering alone would pass this — the volume term is what catches a
    // classifier that stopped reading the counts.
    const misses = typingMisses({
      ...REAL_SWITCHER_SUBJECTS,
      computeSearchActivityKey: (workspace) => ({
        activityClass: REAL_SWITCHER_SUBJECTS.computeSearchActivityKey(workspace).activityClass,
        activityVolume: 0,
      }),
    });
    expect(misses.activityMisses).toBeGreaterThan(0);
  });
});

describe("PERF-403/404", () => {
  const context = { mode: "smoke" as const, now: () => performance.now() };

  it("PERF-403 re-ranks once per keystroke at both corpus sizes", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-403")!;
    const metrics = (await scenario.run(context)).metrics!;
    // Seven characters of the needle, typed against two corpora.
    expect(metrics.keystrokeCount).toBe(SWITCHER_NEEDLE.length * 2);
    expect(metrics.largeRowCount).toBeGreaterThan(metrics.smallRowCount);
    expect(metrics.resultRowCount).toBeGreaterThan(0);
    expect(metrics.rankMisses).toBe(0);
    expect(metrics.scoreMisses).toBe(0);
    expect(metrics.filterMatchMisses).toBe(0);
    expect(metrics.pathFilterMatchMisses).toBe(0);
    expect(metrics.activityMisses).toBe(0);
  });

  it("PERF-404 walks the typo and the correction on one run", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-404")!;
    const metrics = (await scenario.run(context)).metrics!;
    expect(metrics.keystrokeCount).toBe(13);
    expect(metrics.degradedKeystrokeCount).toBeGreaterThan(0);
    expect(metrics.cleanKeystrokeCount).toBeGreaterThan(0);
    // Per keystroke, the degraded tier returns strictly fewer rows.
    const degradedPerKeystroke = metrics.degradedResultRowCount / metrics.degradedKeystrokeCount;
    const cleanPerKeystroke = metrics.cleanResultRowCount / metrics.cleanKeystrokeCount;
    expect(degradedPerKeystroke).toBeGreaterThan(0);
    expect(degradedPerKeystroke).toBeLessThan(cleanPerKeystroke);
    expect(metrics.rankMisses).toBe(0);
    expect(metrics.scoreMisses).toBe(0);
    expect(metrics.filterMatchMisses).toBe(0);
    expect(metrics.pathFilterMatchMisses).toBe(0);
    expect(metrics.activityMisses).toBe(0);
  });
});
