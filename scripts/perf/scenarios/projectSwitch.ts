import type { PerfScenario } from "../types";
import {
  createPersistedLayout,
  simulateProjectSwitchPhased,
  spinEventLoop,
} from "../lib/workloads";

const SMALL_LAYOUT = createPersistedLayout(60, 6, 310);
const MEDIUM_LAYOUT = createPersistedLayout(90, 6, 311);
const LARGE_LAYOUT = createPersistedLayout(140, 10, 312);

export const projectSwitchScenarios: PerfScenario[] = [
  {
    id: "PERF-070",
    name: "Project Switch Phases - Small",
    description: "Phase-instrumented project switch with a small layout (60 panels, 6 worktrees).",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 28 },
    warmups: 2,
    async run() {
      const result = simulateProjectSwitchPhased({
        outgoingStateSize: 40,
        incomingLayout: SMALL_LAYOUT,
      });
      await spinEventLoop(0.5);

      return {
        durationMs: 0,
        metrics: { ...result.phases, checksum: result.checksum },
      };
    },
  },
  {
    id: "PERF-071",
    name: "Project Switch Phases - Medium",
    description: "Phase-instrumented project switch with a medium layout (90 panels, 6 worktrees).",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 28 },
    warmups: 2,
    async run() {
      const result = simulateProjectSwitchPhased({
        outgoingStateSize: 80,
        incomingLayout: MEDIUM_LAYOUT,
      });
      await spinEventLoop(0.5);

      return {
        durationMs: 0,
        metrics: { ...result.phases, checksum: result.checksum },
      };
    },
  },
  {
    id: "PERF-072",
    name: "Project Switch Phases - Large",
    description:
      "Phase-instrumented project switch with a large layout (140 panels, 10 worktrees).",
    tier: "fast",
    modes: ["ci", "nightly"],
    iterations: { ci: 16, nightly: 24 },
    warmups: 2,
    async run() {
      const result = simulateProjectSwitchPhased({
        outgoingStateSize: 150,
        incomingLayout: LARGE_LAYOUT,
      });
      await spinEventLoop(0.5);

      return {
        durationMs: 0,
        metrics: { ...result.phases, checksum: result.checksum },
      };
    },
  },
  {
    id: "PERF-073",
    name: "Project Switch Phase Regression - Serialize Heavy",
    description:
      "Varies outgoing state size across iterations to detect O(n^2) serialize regressions.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    async run() {
      const sizes = [50, 100, 200];
      let checksum = 0;
      let serializeTotalMs = 0;
      let totalSwitchWorkMs = 0;

      for (const size of sizes) {
        const result = simulateProjectSwitchPhased({
          outgoingStateSize: size,
          incomingLayout: MEDIUM_LAYOUT,
        });
        checksum += result.checksum;
        serializeTotalMs += result.phases.serializeMs;
        totalSwitchWorkMs += result.phases.totalMs;
      }

      await spinEventLoop(1);

      return {
        durationMs: 0,
        metrics: {
          checksum,
          serializeTotalMs,
          totalSwitchWorkMs,
        },
      };
    },
  },
];
