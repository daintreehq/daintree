import type { PerfScenario } from "../types";
import {
  buildHydrationPlan,
  hydrationPassMisses,
  hydrationRoundTripMisses,
  loadStatePatcherModule,
  parseHydrationPanels,
  runHydrationPass,
  serializeHydrationPanels,
  withParsedPanels,
  type HydrationPlan,
} from "../lib/hydrationFixture";
import { findPackagedExecutable, launchPackagedAndMeasure } from "../lib/packagedLaunch";

/**
 * PERF-001..003 — the real renderer hydration path, in process.
 *
 * These three used to call `simulateLayoutHydration`, a `Map.set` plus a
 * string-length checksum over a synthetic layout. Nothing in
 * `src/utils/stateHydration/` was reached, so the numbers described the
 * benchmark's own loop.
 *
 * They now drive the production argument builders in
 * `src/utils/stateHydration/statePatcher.ts` over a saved layout that exercises
 * every restore route hydration has — a live backend PTY, a reconnect fallback,
 * a respawn that replays its saved session, a respawn whose session is withheld
 * because a sibling owns it, the four non-PTY kinds through their real
 * deserializers, and orphan adoption. `lib/hydrationFixture.ts` states exactly
 * where the real code stops.
 *
 * PERF-001/002 deserialize first, and the parsed panels are what hydration
 * consumes — `withParsedPanels` rebuilds the plan around them. The two used to
 * time a `JSON.parse` and discard the result while hydrating the in-memory
 * plan, which made deleting the parse a free speedup; `parseMisses` grades the
 * round trip against the plan's own arithmetic, including the key shape only a
 * real JSON round trip produces.
 *
 * WHAT THESE ARE NOT. Not a binary launch — PERF-004 below is the only real
 * cold start here. And not wall-clock restore: `restorePanelsPhase` awaits a
 * terminal-instance attach per panel against a real DOM and a live PTY host,
 * and none of that can run in a plain Node process. These price the CPU
 * hydration spends deciding what to restore, which is the part that scales with
 * panel count.
 */

const EMPTY_PLAN = buildHydrationPlan("empty", 10, 2);
const HEAVY_PLAN = buildHydrationPlan("heavy", 260, 16);
/** PERF-002's payload is already on disk when the app starts, so it is built once. */
const HEAVY_PLAN_SERIALIZED = serializeHydrationPanels(HEAVY_PLAN);

/** Metric names for one graded hydration pass, flattened for the report. */
function hydrationMetrics(plan: HydrationPlan, observed: ReturnType<typeof runHydrationPass>) {
  const misses = hydrationPassMisses(plan, observed);
  return {
    restoredPanels: observed.builtPanelCount,
    backendRestoreCount: observed.backendCount,
    reconnectRestoreCount: observed.reconnectedCount,
    respawnResumeCount: observed.respawnResumeCount,
    respawnWithheldCount: observed.respawnWithheldCount,
    nonPtyRestoreCount: observed.nonPtyCount,
    orphanAdoptionCount: observed.orphanCount,
    ...misses,
  };
}

const HYDRATION_CORRECTNESS = [
  "kindInferenceMisses",
  "backendRestoreMisses",
  "reconnectRestoreMisses",
  "respawnResumeMisses",
  "resumeSuppressionMisses",
  "nonPtyRestoreMisses",
  "sanitizerMisses",
  "orphanMisses",
  "routeCoverageMisses",
] as const;

/**
 * PERF-001/002 additionally deserialize, and PERF-003 deliberately does not.
 *
 * `parseMisses` is the term that makes the round trip load-bearing. Before it,
 * the parse ran inside the timed bracket and its result was discarded —
 * hydration read the in-memory plan — so deleting `JSON.parse` was a free
 * speedup that moved nothing.
 */
const HYDRATION_WITH_PARSE_CORRECTNESS = [...HYDRATION_CORRECTNESS, "parseMisses"] as const;

export const startupScenarios: PerfScenario[] = [
  {
    id: "PERF-001",
    name: "Startup Hydration - Empty Project",
    description:
      "Deserialize a near-empty saved layout and run the real statePatcher restore builders over the panels the parse produced (NOT a binary launch — see PERF-004; and NOT wall-clock restore, since the per-panel terminal attach needs a DOM).",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 30 },
    warmups: 2,
    correctness: HYDRATION_WITH_PARSE_CORRECTNESS,
    async run() {
      const mod = await loadStatePatcherModule();
      // The on-disk round trip a cold start actually pays before hydration —
      // and the panels it produces are the ONLY panels hydrated below, so
      // deleting either half breaks the pass rather than speeding it up.
      const parseStartedAt = performance.now();
      const payload = serializeHydrationPanels(EMPTY_PLAN);
      const parsed = parseHydrationPanels(payload);
      const parseMs = performance.now() - parseStartedAt;

      // Untimed: rewiring the plan around the parsed snapshots is fixture
      // bookkeeping, not deserialize cost.
      const observed = runHydrationPass(mod, withParsedPanels(EMPTY_PLAN, parsed));

      return {
        durationMs: parseMs + observed.elapsedMs,
        metrics: {
          parseMs,
          hydrateMs: observed.elapsedMs,
          payloadBytes: payload.length,
          // Graded against the ORIGINAL plan, not the parsed one: the
          // expectations are the fixture's own arithmetic, and the subject
          // consumed the deserialized copies.
          parseMisses: hydrationRoundTripMisses(EMPTY_PLAN, parsed),
          ...hydrationMetrics(EMPTY_PLAN, observed),
        },
      };
    },
  },
  {
    id: "PERF-002",
    name: "Startup Hydration - Heavy Layout",
    description:
      "Deserialize a 260-panel, 16-worktree saved layout and run the real statePatcher restore builders over the panels the parse produced, including the agent preset/flag/resume resolution each agent pane pays (NOT a binary launch — see PERF-004).",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 8, nightly: 12 },
    warmups: 1,
    correctness: HYDRATION_WITH_PARSE_CORRECTNESS,
    async run() {
      const mod = await loadStatePatcherModule();
      const parseStartedAt = performance.now();
      const parsed = parseHydrationPanels(HEAVY_PLAN_SERIALIZED);
      const parseMs = performance.now() - parseStartedAt;

      const observed = runHydrationPass(mod, withParsedPanels(HEAVY_PLAN, parsed));

      return {
        durationMs: parseMs + observed.elapsedMs,
        metrics: {
          parseMs,
          hydrateMs: observed.elapsedMs,
          payloadBytes: HEAVY_PLAN_SERIALIZED.length,
          parseMisses: hydrationRoundTripMisses(HEAVY_PLAN, parsed),
          ...hydrationMetrics(HEAVY_PLAN, observed),
        },
      };
    },
  },
  {
    id: "PERF-003",
    name: "Warm Start",
    description:
      "Re-run the real statePatcher restore builders over an already-parsed heavy layout — the rapid close/re-open path, with the deserialize cost removed so the per-panel decision cost stands alone.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 15, ci: 25, nightly: 35 },
    warmups: 3,
    correctness: HYDRATION_CORRECTNESS,
    async run() {
      const mod = await loadStatePatcherModule();
      const observed = runHydrationPass(mod, HEAVY_PLAN);

      return {
        durationMs: observed.elapsedMs,
        metrics: {
          hydrateMs: observed.elapsedMs,
          ...hydrationMetrics(HEAVY_PLAN, observed),
        },
      };
    },
  },
  {
    id: "PERF-004",
    name: "Real Cold Start - Packaged Binary",
    description:
      "Launch the packaged Electron binary directly and capture APP_BOOT_START to RENDERER_FIRST_INTERACTIVE via NDJSON pipeline.",
    tier: "heavy",
    modes: ["nightly"],
    iterations: { nightly: 30 },
    warmups: 2,
    // Every reading here is a mark-to-mark duration, and a boot that stops
    // emitting a mark drops the metric rather than worsening it — the row
    // simply disappears from the report. `bootMarkMisses` is the count of
    // canonical marks the launch failed to leave behind.
    correctness: ["bootMarkMisses"],
    async run() {
      const projectRoot = process.cwd();
      const executablePath = findPackagedExecutable(projectRoot);

      if (!executablePath) {
        // Fail closed: returning a sentinel here let run.ts substitute
        // wall-clock (~0ms) and report PASS without ever launching the
        // binary (#10068).
        throw new Error(
          "PERF-004: packaged binary not found under release/ — build one first " +
            "(`npm run build && npx electron-builder --config electron-builder.config.cjs --dir --publish never`, " +
            "or `npm run package` locally)"
        );
      }

      const iteration = Math.floor(Math.random() * 100_000);
      const result = await launchPackagedAndMeasure(executablePath, iteration, {
        projectRoot,
        timeoutMs: 45_000,
      });

      if (result.degraded) {
        // Same fail-closed rationale as the missing-binary case: a wall-clock
        // fallback means the NDJSON mark pipeline never produced
        // APP_BOOT_START → RENDERER_READY, so the number is not the
        // mark-to-mark cold start this scenario exists to measure.
        throw new Error(
          `PERF-004: launch succeeded but boot marks were not captured (${result.notes ?? "no notes"}) — instrumentation pipeline broken`
        );
      }

      return {
        durationMs: result.durationMs,
        metrics: result.metrics,
        notes: result.notes,
      };
    },
  },
];
