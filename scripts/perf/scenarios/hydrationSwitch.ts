import type { PerfScenario } from "../types";
import {
  createPersistedLayout,
  projectSwitchCycleMisses,
  simulateLayoutHydration,
  simulateProjectSwitchCycle,
  spinEventLoop,
  type PersistedLayout,
} from "../lib/workloads";

/**
 * Panels and tab groups the hydration was handed but did not restore. The
 * expectation comes from the layout that went IN, so a hydration reduced to a
 * no-op — the fastest one there is — cannot post a zero here.
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

const MIXED_LAYOUT = createPersistedLayout(120, 8, 301);
const SWITCH_LAYOUT_A = createPersistedLayout(90, 6, 302);
const SWITCH_LAYOUT_B = createPersistedLayout(110, 8, 303);
const SWITCH_LAYOUT_C = createPersistedLayout(140, 10, 304);
const LARGE_WORKTREE_LAYOUT = createPersistedLayout(190, 12, 305);

export const hydrationSwitchScenarios: PerfScenario[] = [
  {
    id: "PERF-010",
    name: "Hydration - Mixed Panels",
    description: "Hydrate a persisted project state with mixed panel kinds and tab groups.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 12, ci: 24, nightly: 30 },
    warmups: 2,
    correctness: ["hydrationMisses"],
    async run() {
      const hydrated = simulateLayoutHydration(MIXED_LAYOUT);
      await spinEventLoop(1);
      return {
        durationMs: 0,
        metrics: {
          restoredPanels: hydrated.restoredPanels,
          restoredGroups: hydrated.restoredGroups,
          checksum: hydrated.checksum,
          hydrationMisses: hydrationMissesFor(MIXED_LAYOUT, hydrated),
        },
      };
    },
  },
  {
    id: "PERF-011",
    name: "Project Switch A->B (Medium)",
    description: "Switch between medium complexity projects while preserving outgoing state.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 28 },
    warmups: 2,
    correctness: ["switchMisses"],
    async run() {
      const specA = { outgoingStateSize: 80, incomingLayout: SWITCH_LAYOUT_A, iterations: 1 };
      const specB = { outgoingStateSize: 90, incomingLayout: SWITCH_LAYOUT_B, iterations: 1 };
      const switchA = simulateProjectSwitchCycle(specA);
      const switchB = simulateProjectSwitchCycle(specB);
      await spinEventLoop(0.5);

      return {
        durationMs: 0,
        metrics: {
          checksum: switchA.checksum + switchB.checksum,
          switchWorkMs: switchA.elapsedMs + switchB.elapsedMs,
          switchMisses:
            projectSwitchCycleMisses(specA, switchA) + projectSwitchCycleMisses(specB, switchB),
        },
      };
    },
  },
  {
    id: "PERF-012",
    name: "Rapid Project Switch Loop A<->B<->C",
    description: "Stress rapid successive project switches to surface race-prone behavior.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    correctness: ["switchMisses"],
    async run() {
      const layouts = [SWITCH_LAYOUT_A, SWITCH_LAYOUT_B, SWITCH_LAYOUT_C];
      let checksum = 0;
      let elapsed = 0;
      let switchMisses = 0;

      for (let i = 0; i < 12; i += 1) {
        const spec = {
          outgoingStateSize: 100 + (i % 3) * 25,
          incomingLayout: layouts[i % layouts.length],
          iterations: 1,
        };
        const result = simulateProjectSwitchCycle(spec);
        checksum += result.checksum;
        elapsed += result.elapsedMs;
        switchMisses += projectSwitchCycleMisses(spec, result);
      }

      await spinEventLoop(2);

      return {
        durationMs: 0,
        metrics: {
          checksum,
          switchWorkMs: elapsed,
          switchMisses,
        },
      };
    },
  },
  {
    id: "PERF-013",
    name: "Worktree Switch with 15+ Panels",
    description: "Switch active worktree across large grouped panel state.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 28 },
    warmups: 2,
    correctness: ["selectionMisses"],
    async run() {
      const targetWorktreeId =
        LARGE_WORKTREE_LAYOUT.worktrees[4] ?? LARGE_WORKTREE_LAYOUT.worktrees[0];
      const visiblePanels = LARGE_WORKTREE_LAYOUT.panels.filter(
        (panel) => panel.worktreeId === targetWorktreeId || panel.worktreeId === null
      );

      const visibleIds = new Set(visiblePanels.map((panel) => panel.id));
      const visibleGroups = LARGE_WORKTREE_LAYOUT.tabGroups
        .map((group) => ({
          id: group.id,
          tabIds: group.tabIds.filter((tabId) => visibleIds.has(tabId)),
        }))
        .filter((group) => group.tabIds.length > 0);

      await spinEventLoop(0.75);

      // Validates the OUTPUT against the rule rather than re-running the
      // filter: every kept panel must belong to the target worktree or be
      // global, every kept group must still hold a tab, and the selection must
      // not be empty. A filter that kept nothing (the cheapest one) and a
      // filter that kept everything both score non-zero.
      const selectionMisses =
        visiblePanels.filter(
          (panel) => panel.worktreeId !== targetWorktreeId && panel.worktreeId !== null
        ).length +
        visibleGroups.filter((group) => group.tabIds.length === 0).length +
        (visiblePanels.length === 0 ? 1 : 0);

      return {
        durationMs: 0,
        metrics: {
          visiblePanels: visiblePanels.length,
          visibleGroups: visibleGroups.length,
          checksum: visiblePanels.length * 13 + visibleGroups.length * 7,
          selectionMisses,
        },
      };
    },
  },
];
