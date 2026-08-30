import type { PerfScenario, ScenarioContext } from "../types";
import {
  createPersistedLayout,
  simulateLayoutHydration,
  simulateProjectSwitchCycle,
  spinEventLoop,
  type PersistedLayout,
} from "../lib/workloads";
import { findPackagedExecutable, launchPackagedAndMeasure } from "../lib/packagedLaunch";

/**
 * Panels and tab groups the hydration was handed but did not restore.
 *
 * The expectation comes from the layout that went IN, so no change to
 * `simulateLayoutHydration` can satisfy it without actually rebuilding the
 * workspace: a hydration reduced to `return { restoredPanels: 0 }` is the
 * fastest one possible, and `restoredPanels`/`restoredGroups` on their own
 * report that as the best sample the harness has recorded.
 */
function hydrationMissesFor(
  layout: PersistedLayout,
  hydrated: { restoredPanels: number; restoredGroups: number }
): number {
  return (
    Math.abs(layout.panels.length - hydrated.restoredPanels) +
    Math.abs(layout.tabGroups.length - hydrated.restoredGroups)
  );
}

const EMPTY_LAYOUT = createPersistedLayout(10, 2, 101);
const HEAVY_LAYOUT = createPersistedLayout(260, 16, 202);
const HEAVY_LAYOUT_SERIALIZED = JSON.stringify(HEAVY_LAYOUT);

export const startupScenarios: PerfScenario[] = [
  {
    id: "PERF-001",
    name: "Startup Simulation - Empty Project",
    description:
      "In-process hydration of a near-empty layout (NOT a real binary launch — see PERF-004 for real cold start).",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 30 },
    warmups: 2,
    correctness: ["hydrationMisses"],
    async run() {
      const payload = JSON.stringify(EMPTY_LAYOUT);
      const parsed = JSON.parse(payload) as ReturnType<typeof createPersistedLayout>;
      const hydrated = simulateLayoutHydration(parsed);
      await spinEventLoop(1);

      return {
        durationMs: 0,
        metrics: {
          restoredPanels: hydrated.restoredPanels,
          restoredGroups: hydrated.restoredGroups,
          checksum: hydrated.checksum,
          hydrationMisses: hydrationMissesFor(parsed, hydrated),
        },
      };
    },
  },
  {
    id: "PERF-002",
    name: "Startup Simulation - Heavy Layout",
    description:
      "In-process deserialize + hydration of a high-density panel/tab-group workspace (NOT a real binary launch — see PERF-004).",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["hydrationMisses"],
    async run() {
      const parsed = JSON.parse(HEAVY_LAYOUT_SERIALIZED) as ReturnType<
        typeof createPersistedLayout
      >;
      const hydrated = simulateLayoutHydration(parsed);

      const switchResult = simulateProjectSwitchCycle({
        outgoingStateSize: 120,
        incomingLayout: parsed,
        iterations: 1,
      });

      await spinEventLoop(2);

      return {
        durationMs: 0,
        metrics: {
          restoredPanels: hydrated.restoredPanels,
          restoredGroups: hydrated.restoredGroups,
          checksum: hydrated.checksum + switchResult.checksum,
          hydrationMisses: hydrationMissesFor(parsed, hydrated),
        },
      };
    },
  },
  {
    id: "PERF-003",
    name: "Warm Start",
    description: "Re-hydrate from already-loaded state to simulate rapid close/re-open behavior.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 15, ci: 25, nightly: 35 },
    warmups: 3,
    correctness: ["hydrationMisses"],
    async run() {
      const hydrated = simulateLayoutHydration(HEAVY_LAYOUT);
      await spinEventLoop(0.5);
      return {
        durationMs: 0,
        metrics: {
          restoredPanels: hydrated.restoredPanels,
          restoredGroups: hydrated.restoredGroups,
          checksum: hydrated.checksum,
          hydrationMisses: hydrationMissesFor(HEAVY_LAYOUT, hydrated),
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
    async run(context: ScenarioContext) {
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
