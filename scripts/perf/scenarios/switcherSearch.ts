import { performance } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import { percentile } from "../lib/stats";
import {
  correctionPathSteps,
  getSwitcherFixture,
  progressiveTypingSteps,
  runSwitcherSession,
  SWITCHER_NEEDLE,
  SWITCHER_TYPO,
  type SwitcherSessionResult,
} from "../lib/switcherSearchFixture";

/**
 * Project-switcher ranking (PERF-403/404).
 *
 * ⌘P re-ranks the whole workspace list on every keystroke, which makes this the
 * most frequently executed search path in the app. PERF-170/171 measure
 * `actionPaletteSearch` — a different scorer over the action catalog, with no
 * typo tier, no activity keys and no two-kind row model — so this is new
 * coverage rather than a second reading of the same code.
 *
 * Both scenarios drive four subjects and grade each with its own accumulator:
 * `rankSwitcherMatches` (the re-rank), `scoreProjectQuery` (its inner per-row
 * scoring loop), `isFilterMatch` (the same module's filter-only matcher, whose
 * production caller is the Pilot overview's `filterPilotGroups`), and
 * `computeSearchActivityKey` (the palette session's activity freeze, taken once
 * per open). A single aggregate could not tell which of the four went missing.
 *
 * All four load with a plain import — the module is pure and its only value
 * import is `classifyAssistantActivity`, which is pure too. No esbuild bundle
 * and no stubs are involved.
 *
 * Scope: this is ranking cost with the renderer removed. No React, no
 * virtualised list, no paint — a regression in how the palette RE-RENDERS its
 * rows is invisible here.
 */

const SMALL_PROJECTS = 60;
const SMALL_SCRATCHES = 20;
const LARGE_PROJECTS = 240;
const LARGE_SCRATCHES = 60;

const SWITCHER_CORRECTNESS = [
  "rankMisses",
  "scoreMisses",
  "filterMatchMisses",
  "activityMisses",
] as const;

function missMetrics(...results: SwitcherSessionResult[]): Record<string, number> {
  let rankMisses = 0;
  let scoreMisses = 0;
  let filterMatchMisses = 0;
  let activityMisses = 0;
  for (const result of results) {
    rankMisses += result.misses.rankMisses;
    scoreMisses += result.misses.scoreMisses;
    filterMatchMisses += result.misses.filterMatchMisses;
    activityMisses += result.misses.activityMisses;
  }
  return { rankMisses, scoreMisses, filterMatchMisses, activityMisses };
}

export const switcherSearchScenarios: PerfScenario[] = [
  {
    id: "PERF-403",
    name: "Project Switcher - Progressive Typing",
    description:
      `Type "${SWITCHER_NEEDLE}" one character at a time in the ⌘P switcher, once against ` +
      `${SMALL_PROJECTS} projects + ${SMALL_SCRATCHES} scratches and once against ` +
      `${LARGE_PROJECTS} + ${LARGE_SCRATCHES}. Every prefix is a full re-rank of the whole ` +
      "workspace list, plus the Pilot filter pass and the per-row scoring loop over the same " +
      "corpus; the activity snapshot is frozen once per session, as the palette does it. " +
      "worstKeystrokeMs is the single re-rank a user feels and must stay well inside a frame.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    correctness: SWITCHER_CORRECTNESS,
    run() {
      const small = getSwitcherFixture(SMALL_PROJECTS, SMALL_SCRATCHES);
      const large = getSwitcherFixture(LARGE_PROJECTS, LARGE_SCRATCHES);
      const steps = progressiveTypingSteps();

      const start = performance.now();
      const smallResult = runSwitcherSession(small, steps);
      const largeResult = runSwitcherSession(large, steps);
      const durationMs = performance.now() - start;

      return {
        durationMs,
        metrics: {
          keystrokeCount: smallResult.keystrokeCount + largeResult.keystrokeCount,
          smallRowCount: small.rowCount,
          largeRowCount: large.rowCount,
          resultRowCount: smallResult.resultRowCount + largeResult.resultRowCount,
          worstKeystrokeMsSmall: Math.max(...smallResult.perKeystrokeMs),
          worstKeystrokeMsLarge: Math.max(...largeResult.perKeystrokeMs),
          p95KeystrokeMsLarge: percentile(largeResult.perKeystrokeMs, 95),
          rankMs: largeResult.rankMs,
          filterMs: largeResult.filterMs,
          scoreMs: largeResult.scoreMs,
          freezeMs: largeResult.freezeMs,
          ...missMetrics(smallResult, largeResult),
        },
      };
    },
  },
  {
    id: "PERF-404",
    name: "Project Switcher - One-Edit Correction",
    description:
      `The typo-and-backspace path (#11924): type "${SWITCHER_TYPO}" — an adjacent transposition ` +
      `of "${SWITCHER_NEEDLE}" — notice, backspace to the last good prefix, then type the rest ` +
      "correctly. 13 re-ranks against " +
      `${LARGE_PROJECTS} projects + ${LARGE_SCRATCHES} scratches. The middle of the sequence is ` +
      "the terminal typo tier, where every clean scorer returns 0 and rows reach the list only " +
      "through the one-edit matcher, so this prices the path that would otherwise empty the " +
      "list. degradedResultRowCount against cleanResultRowCount is how much of the list a " +
      "single fat-fingered character costs.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    correctness: SWITCHER_CORRECTNESS,
    run() {
      const fixture = getSwitcherFixture(LARGE_PROJECTS, LARGE_SCRATCHES);
      const steps = correctionPathSteps();

      const start = performance.now();
      const result = runSwitcherSession(fixture, steps);
      const durationMs = performance.now() - start;

      let degradedResultRowCount = 0;
      let degradedKeystrokes = 0;
      let cleanResultRowCount = 0;
      let cleanKeystrokes = 0;
      const degradedMs: number[] = [];
      const cleanMs: number[] = [];
      for (let i = 0; i < result.keystrokes.length; i += 1) {
        const observation = result.keystrokes[i];
        const elapsed = result.perKeystrokeMs[i];
        if (observation.step.kind === "typo") {
          degradedResultRowCount += observation.resultIds.length;
          degradedKeystrokes += 1;
          degradedMs.push(elapsed);
        } else {
          cleanResultRowCount += observation.resultIds.length;
          cleanKeystrokes += 1;
          cleanMs.push(elapsed);
        }
      }

      return {
        durationMs,
        metrics: {
          keystrokeCount: result.keystrokeCount,
          rowCount: fixture.rowCount,
          resultRowCount: result.resultRowCount,
          degradedResultRowCount,
          degradedKeystrokeCount: degradedKeystrokes,
          cleanResultRowCount,
          cleanKeystrokeCount: cleanKeystrokes,
          worstKeystrokeMs: Math.max(...result.perKeystrokeMs),
          worstDegradedKeystrokeMs: Math.max(...degradedMs),
          worstCleanKeystrokeMs: Math.max(...cleanMs),
          rankMs: result.rankMs,
          filterMs: result.filterMs,
          scoreMs: result.scoreMs,
          freezeMs: result.freezeMs,
          ...missMetrics(result),
        },
      };
    },
  },
];
