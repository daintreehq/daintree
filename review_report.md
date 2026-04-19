## Review Report

### Summary

Reviewed performance harness changes for Issue #5410 (real cold-start scenario with A/B comparison). Found 5 critical issues that must be fixed before merging, 2 minor issues, and several test gaps. The implementation partially meets requirements but has severe bugs in the comparison path and measurement logic.

### Findings

**Critical (must fix)**:

1. `/Users/gpriday/Projects/canopy-worktrees/perf-issue-5410-real-cold-start-scenario/scripts/perf/run.ts:283-300` — `comparisonAggregates` variable used before declaration (temporal dead zone). The script will crash with a ReferenceError when writing the report before the compare branch.
2. `/Users/gpriday/Projects/canopy-worktrees/perf-issue-5410-real-cold-start-scenario/scripts/perf/run.ts:145-172` and `/Users/gpriday/Projects/canopy-worktrees/perf-issue-5410-real-cold-start-scenario/scripts/perf/scenarios/startup.ts:119-122` — The harness discards `sample.durationMs` (the NDJSON boot interval) and instead records `performance.now() - start` (wrapper overhead). This means PERF-004 measures Playwright launch + polling + settle sleep + close time, not the intended APP_BOOT_START → RENDERER_READY interval.
3. `/Users/gpriday/Projects/canopy-worktrees/perf-issue-5410-real-cold-start-scenario/scripts/perf/lib/packagedLaunch.ts:237-249` — Missing instrumentation is silently replaced with wall‑clock fallback without a warning note. When the NDJSON file lacks the required marks, `durationMs` becomes `wallClockMs` (positive), the note check (`result.durationMs < 0`) never triggers, and the invalid sample is included in aggregates.
4. `/Users/gpriday/Projects/canopy-worktrees/perf-issue-5410-real-cold-start-scenario/scripts/perf/run.ts:366-382` — The `--compare` flag is stubbed: `runBaselineArm()` returns an empty array, so no baseline arm is executed. The A/B comparison feature (core issue requirement) is non‑functional.
5. `/Users/gpriday/Projects/canopy-worktrees/perf-issue-5410-real-cold-start-scenario/scripts/perf/run.ts:385-405` — Statistical comparison uses singleton arrays `[headAgg.meanMs]` and `[baseAgg.meanMs]`. With `nA = nB = 1`, pooled standard deviation denominator becomes zero (`NaN`), effect size is `NaN`, and the Mann‑Whitney U p‑value is always 1, making regression detection impossible.

**Minor (fix if quick)**:

1. `/Users/gpriday/Projects/canopy-worktrees/perf-issue-5410-real-cold-start-scenario/scripts/perf/lib/packagedLaunch.ts:67-92` — Fallback executable scan hardcodes `PRODUCT_NAME = "Daintree"` instead of respecting `BUILD_VARIANT`. If the primary lookup fails, the scan will miss a `Canopy` variant packaged binary.
2. `/Users/gpriday/Projects/canopy-worktrees/perf-issue-5410-real-cold-start-scenario/scripts/perf/lib/comparison.ts:167-171` — The exact Mann‑Whitney DP branch assumes untied ranks; tied small‑sample timings will produce inaccurate p‑values in the exact regime.

**Invalid (Codex flagged, not a real issue)**:
None – all flagged issues are genuine.

### Suggested test additions

From the tests review, the highest‑value additions are:

1. **Singleton comparison** in `comparison.test.ts`: test `compareSamples()` with `[200]` vs `[100]` and `[100]` vs `[100]` to expose `NaN` effect size and degenerate p‑values.
2. **Threshold‑edge cases** in `comparison.test.ts`: verify inclusive semantics when `pValue === maxPValue` and `effectSize === minEffectSize`.
3. **Exact‑vs‑approximation branch** in `comparison.test.ts`: test sample‑size boundaries (20/21, 29/30) with and without ties.
4. **Concrete mode‑membership** in `scenarioMatrix.test.ts`: assert specific scenario IDs per mode (e.g., `PERF-080` is in `ci` and `nightly` but not `smoke`).
5. **Repeated‑run invariance** for `PERF-080` in `scenarioMatrix.test.ts`: run twice and check metric stability, no mutation leakage.

### Fix priorities

1. **Fix TDZ bug first** (`comparisonAggregates` declaration must precede its use). Move the `let comparisonAggregates = [];` before the report writes.
2. **Fix measurement bug**: In `run.ts`, replace `durationMs = performance.now() - start` with `durationMs = sample.durationMs >= 0 ? sample.durationMs : performance.now() - start`. Ensure PERF‑004 returns the NDJSON interval.
3. **Fix missing‑instrumentation detection**: In `launchPackagedAndMeasure`, propagate a note when falling back to wall‑clock time, and ensure `startup.ts` can attach a note even when `durationMs` is positive.
4. **Fix singleton‑array comparison**: Store raw per‑iteration durations in `aggregateById` and pass them to `compareSamples`. Modify `computeComparisons` to use raw duration arrays instead of means.
5. **Implement baseline arm** (or at least document that the feature is stubbed). Since this is a major missing piece, either implement a minimal worktree‑build flow or gate the `--compare` flag with a clear error.
6. **Minor fixes**: Update fallback scan to respect variant product name; consider handling ties in exact DP or switch to approximation for tied small samples.

The fixes are interdependent: the TDZ bug must be fixed first to allow any run; the measurement bug must be fixed to get valid PERF‑004 data; the singleton‑array fix depends on storing raw durations; the baseline arm is a separate feature. Prioritize fixes 1‑4 for the existing scenario to work correctly, then decide whether to implement baseline arm now or defer.
