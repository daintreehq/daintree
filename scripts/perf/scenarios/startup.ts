import type { PerfScenario, ScenarioContext } from "../types";
import {
  createPersistedLayout,
  simulateLayoutHydration,
  simulateProjectSwitchCycle,
  spinEventLoop,
} from "../lib/workloads";
import { findPackagedExecutable, launchPackagedAndMeasure } from "../lib/packagedLaunch";

const EMPTY_LAYOUT = createPersistedLayout(10, 2, 101);
const HEAVY_LAYOUT = createPersistedLayout(260, 16, 202);
const HEAVY_LAYOUT_SERIALIZED = JSON.stringify(HEAVY_LAYOUT);

export const startupScenarios: PerfScenario[] = [
  {
    id: "PERF-001",
    name: "Cold Start - Empty Project",
    description: "Approximate cold startup bootstrap path with minimal persisted state.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 30 },
    warmups: 2,
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
        },
      };
    },
  },
  {
    id: "PERF-002",
    name: "Cold Start - Heavy Persisted Layout",
    description: "Deserialize and hydrate a high-density panel/tab-group workspace state.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 8, nightly: 12 },
    warmups: 1,
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
    async run() {
      const hydrated = simulateLayoutHydration(HEAVY_LAYOUT);
      await spinEventLoop(0.5);
      return {
        durationMs: 0,
        metrics: {
          restoredPanels: hydrated.restoredPanels,
          restoredGroups: hydrated.restoredGroups,
          checksum: hydrated.checksum,
        },
      };
    },
  },
  {
    id: "PERF-004",
    name: "Real Cold Start - Packaged Binary",
    description:
      "Launch the packaged Electron binary via Playwright, capture APP_BOOT_START to RENDERER_READY via NDJSON pipeline.",
    tier: "heavy",
    modes: ["nightly"],
    iterations: { nightly: 30 },
    warmups: 2,
    async run(context: ScenarioContext) {
      const projectRoot = process.cwd();
      const executablePath = findPackagedExecutable(projectRoot);

      if (!executablePath) {
        return {
          durationMs: -1,
          metrics: {},
          notes: "Packaged binary not found — run `npm run package` first",
        };
      }

      const iteration = Math.floor(Math.random() * 100_000);
      const result = await launchPackagedAndMeasure(executablePath, iteration, {
        projectRoot,
        timeoutMs: 45_000,
      });

      return {
        durationMs: result.durationMs,
        metrics: result.metrics,
        notes: result.notes,
      };
    },
  },
];
