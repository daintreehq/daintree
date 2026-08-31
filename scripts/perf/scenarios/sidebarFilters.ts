import { performance } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import { percentile } from "../lib/stats";
import {
  buildStepMatrix,
  getSidebarDerivationFixture,
  gradeDerivationSweep,
  runDerivationSweep,
  SIDEBAR_NEEDLE,
} from "../lib/sidebarDerivationFixture";

/**
 * Sidebar list derivation (PERF-400..402).
 *
 * `SidebarContent` re-runs `matchesFilters`, `sortWorktreesByRelevance`,
 * `groupByType` and `computeChipCounts` over the WHOLE worktree set on every
 * render and every filter keystroke. PERF-140/141 measure the store apply that
 * produces that set; this family measures what the component then does with it.
 *
 * The sweep is progressive typing (0 to 5 characters of a planted needle)
 * crossed with three facet levels (0, 2 and 5 active filter groups) — 18
 * derivation passes per iteration. Each pass runs the operations in the
 * component's own order and prices them separately, and `groupByType` runs only
 * on the browse passes, because grouped mode is skipped while a query is
 * active.
 *
 * All four subjects load with a plain import: they are pure and reach nothing
 * renderer-only, so no esbuild bundle or stub plugin is involved.
 *
 * **What `durationMs` contains.** The bracket wraps `runDerivationSweep` and
 * nothing else, and that call runs the four subjects and appends what they
 * returned. The corpus is built once and cached, the step matrix — including
 * each step's resolved `FilterState` — is built before the clock starts, and
 * every oracle runs in `gradeDerivationSweep` after it stops. Until #12093 the
 * grader ran inside the loop, so `durationMs` was subject plus oracle while the
 * comment here claimed otherwise.
 *
 * Four predicates, one per operation. A single aggregate could not tell which
 * of the four went missing, and three of the four are cheaper to skip than to
 * perform — dropping `computeChipCounts`'s six group-excluded base sets for one
 * shared base set is a ~6x saving that `keptMisses` alone would call free.
 * Every expectation is arithmetic over the generator's own plant records; no
 * oracle here calls a `worktreeFilters` export.
 */

const SMALL_PROJECT_WORKTREES = 50;
const LARGE_PROJECT_WORKTREES = 200;

function sweepMetrics(size: number): { durationMs: number; metrics: Record<string, number> } {
  const fixture = getSidebarDerivationFixture(size);
  const steps = buildStepMatrix();

  const start = performance.now();
  const passes = runDerivationSweep(fixture, steps);
  const durationMs = performance.now() - start;

  const result = gradeDerivationSweep(fixture, passes);

  return {
    durationMs,
    metrics: {
      passCount: result.passCount,
      keptRowCount: result.keptRowCount,
      worktreeCount: fixture.size,
      avgPassMs: result.perPassMs.reduce((sum, ms) => sum + ms, 0) / result.passCount,
      p95PassMs: percentile(result.perPassMs, 95),
      worstPassMs: Math.max(...result.perPassMs),
      keptMisses: result.misses.keptMisses,
      chipCountMisses: result.misses.chipCountMisses,
      sortMisses: result.misses.sortMisses,
      groupMisses: result.misses.groupMisses,
    },
  };
}

const SWEEP_CORRECTNESS = ["keptMisses", "chipCountMisses", "sortMisses", "groupMisses"] as const;

export const sidebarFilterScenarios: PerfScenario[] = [
  {
    id: "PERF-400",
    name: "Sidebar Derivation - 50 Worktrees",
    description:
      "The four sidebar derivation functions over a 50-worktree project: filter, relevance sort, " +
      "type grouping and chip-count recompute, run 18 times per iteration across progressive " +
      `typing of "${SIDEBAR_NEEDLE}" (0-5 characters) crossed with 0, 2 and 5 active filter ` +
      "groups. durationMs is the whole sweep with the oracle outside it; worstPassMs is the " +
      "single keystroke a user feels.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    correctness: SWEEP_CORRECTNESS,
    run() {
      return sweepMetrics(SMALL_PROJECT_WORKTREES);
    },
  },
  {
    id: "PERF-401",
    name: "Sidebar Derivation - 200 Worktrees",
    description:
      "PERF-400's sweep against a 200-worktree project — the fleet size where the per-keystroke " +
      "recompute stops being free. Same 18 passes, same predicates; read against PERF-400 on the " +
      "same machine to see how the derivation scales with worktree count.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    correctness: SWEEP_CORRECTNESS,
    run() {
      return sweepMetrics(LARGE_PROJECT_WORKTREES);
    },
  },
  {
    id: "PERF-402",
    name: "Sidebar Derivation - Per-Operation Breakdown",
    description:
      "The same 200-worktree sweep, reported per operation rather than per pass: the row filter, " +
      "the relevance sort, the type grouping and the chip-count recompute each get their own " +
      "bracket. computeChipCounts is six more full matchesFilters sweeps (one per facet group " +
      "with that group's own filters lifted), so this is where the cost of the filter bar's live " +
      "counts is visible against the cost of the list itself.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    correctness: SWEEP_CORRECTNESS,
    run() {
      const fixture = getSidebarDerivationFixture(LARGE_PROJECT_WORKTREES);
      const steps = buildStepMatrix();

      const start = performance.now();
      const passes = runDerivationSweep(fixture, steps);
      const durationMs = performance.now() - start;

      const result = gradeDerivationSweep(fixture, passes);

      return {
        durationMs,
        metrics: {
          passCount: result.passCount,
          keptRowCount: result.keptRowCount,
          worktreeCount: fixture.size,
          matchesFiltersMs: result.matchesFiltersMs,
          sortMs: result.sortMs,
          groupMs: result.groupMs,
          chipCountsMs: result.chipCountsMs,
          keptMisses: result.misses.keptMisses,
          chipCountMisses: result.misses.chipCountMisses,
          sortMisses: result.misses.sortMisses,
          groupMisses: result.misses.groupMisses,
        },
      };
    },
  },
];
