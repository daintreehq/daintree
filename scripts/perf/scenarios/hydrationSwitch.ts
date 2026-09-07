import type { PerfScenario } from "../types";
import {
  buildHydrationPlan,
  hydrationPassMisses,
  loadStatePatcherModule,
  runHydrationPass,
} from "../lib/hydrationFixture";
import {
  addLayoutMergeMisses,
  buildLayoutMergePlan,
  layoutMergeMisses,
  runLayoutMergePass,
  zeroLayoutMergeMisses,
  type LayoutMergePlan,
} from "../lib/layoutMergeFixture";
import {
  buildWorktreeScopePlan,
  runWorktreeScopePass,
  worktreeScopeMisses,
} from "../lib/worktreeScopeFixture";

/**
 * PERF-010..013 — hydration and project switching against the real subjects.
 *
 * All four previously ran `simulateLayoutHydration` /
 * `simulateProjectSwitchCycle` from `lib/workloads.ts`: a `Map.set` loop, a
 * string-length checksum and a `JSON.stringify` of synthetic objects. No
 * product code was reached.
 *
 * - PERF-010 drives the real per-panel restore builders
 *   (`src/utils/stateHydration/statePatcher.ts`).
 * - PERF-011/012 drive the real concurrent-layout merge
 *   (`shared/utils/layoutMerge.ts`) exactly as a project switch does:
 *   `computeIdArrayDelta` with `deepEqualIgnoringUndefined` on the renderer
 *   side, `mergeIdArray` / `mergeRecord` on Main's
 *   (`electron/ipc/handlers/projectCrud/switch.ts` 373/391/423).
 * - PERF-013 drives the real per-worktree panel index and scope predicate
 *   (`src/store/slices/panelRegistry/worktreeIndex.ts`).
 *
 * Each fixture header states what stays out of frame.
 */

const MIXED_HYDRATION_PLAN = buildHydrationPlan("mixed", 120, 8);

const SWITCH_PLAN_A = buildLayoutMergePlan("A", 90, 302);
const SWITCH_PLAN_B = buildLayoutMergePlan("B", 110, 303);
const SWITCH_PLAN_C = buildLayoutMergePlan("C", 140, 304);

const LARGE_WORKTREE_SCOPE_PLAN = buildWorktreeScopePlan("large", 190, 12);

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

const MERGE_CORRECTNESS = [
  "terminalDeltaMisses",
  "tabGroupDeltaMisses",
  "draftDeltaMisses",
  "payloadMisses",
  "terminalMergeMisses",
  "tabGroupMergeMisses",
  "draftMergeMisses",
  "identicalPassMisses",
  "singleChangeMisses",
  "equalityProbeMisses",
] as const;

/** Run one switch's merge pipeline and fold its readings into an accumulator. */
function accumulateSwitch(
  plan: LayoutMergePlan,
  totals: {
    captureMs: number;
    mergeMs: number;
    probeMs: number;
    payloadBytes: number;
    deepEqualCalls: number;
    changedEntries: number;
    removedEntries: number;
    mergedEntries: number;
  }
) {
  const observed = runLayoutMergePass(plan);
  totals.captureMs += observed.captureMs;
  totals.mergeMs += observed.mergeMs;
  totals.probeMs += observed.probeMs;
  totals.payloadBytes += observed.payloadBytes;
  totals.deepEqualCalls += observed.deepEqualCalls;
  totals.changedEntries += observed.terminalDelta.changedIds.length;
  totals.removedEntries += observed.terminalDelta.removedIds.length;
  totals.mergedEntries += observed.mergedTerminals.length;
  return layoutMergeMisses(plan, observed);
}

export const hydrationSwitchScenarios: PerfScenario[] = [
  {
    id: "PERF-010",
    name: "Hydration - Mixed Panels",
    description:
      "Run the real statePatcher restore builders over a 120-panel saved layout spanning every restore route (live backend, reconnect fallback, session respawn, withheld respawn, the four non-PTY kinds, orphan adoption). Decision cost only — the per-panel terminal attach needs a DOM.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 12, ci: 24, nightly: 30 },
    warmups: 2,
    correctness: HYDRATION_CORRECTNESS,
    async run() {
      const mod = await loadStatePatcherModule();
      const observed = runHydrationPass(mod, MIXED_HYDRATION_PLAN);
      const misses = hydrationPassMisses(MIXED_HYDRATION_PLAN, observed);

      return {
        durationMs: observed.elapsedMs,
        metrics: {
          restoredPanels: observed.builtPanelCount,
          backendRestoreCount: observed.backendCount,
          reconnectRestoreCount: observed.reconnectedCount,
          respawnResumeCount: observed.respawnResumeCount,
          respawnWithheldCount: observed.respawnWithheldCount,
          nonPtyRestoreCount: observed.nonPtyCount,
          orphanAdoptionCount: observed.orphanCount,
          ...misses,
        },
      };
    },
  },
  {
    id: "PERF-011",
    name: "Project Switch A->B (Medium)",
    description:
      "Two real switch merges (90- and 110-panel projects): the renderer's outgoing delta over deepEqualIgnoringUndefined, then Main's three-way merge of panels, tab groups and draft inputs with the agentSessionId field-authority rule.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 28 },
    warmups: 2,
    correctness: MERGE_CORRECTNESS,
    async run() {
      const totals = {
        captureMs: 0,
        mergeMs: 0,
        probeMs: 0,
        payloadBytes: 0,
        deepEqualCalls: 0,
        changedEntries: 0,
        removedEntries: 0,
        mergedEntries: 0,
      };
      let misses = zeroLayoutMergeMisses();
      for (const plan of [SWITCH_PLAN_A, SWITCH_PLAN_B]) {
        misses = addLayoutMergeMisses(misses, accumulateSwitch(plan, totals));
      }

      return {
        durationMs: totals.captureMs + totals.mergeMs,
        metrics: {
          captureMs: totals.captureMs,
          mergeMs: totals.mergeMs,
          correctnessProbeMs: totals.probeMs,
          payloadBytes: totals.payloadBytes,
          deepEqualCalls: totals.deepEqualCalls,
          changedEntries: totals.changedEntries,
          removedEntries: totals.removedEntries,
          mergedEntries: totals.mergedEntries,
          ...misses,
        },
      };
    },
  },
  {
    id: "PERF-012",
    name: "Rapid Project Switch Loop A<->B<->C",
    description:
      "Twelve successive real switch merges across three projects, so the delta and three-way merge run back to back the way a rapid A/B/C rotation drives them.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    correctness: MERGE_CORRECTNESS,
    async run() {
      const plans = [SWITCH_PLAN_A, SWITCH_PLAN_B, SWITCH_PLAN_C];
      const totals = {
        captureMs: 0,
        mergeMs: 0,
        probeMs: 0,
        payloadBytes: 0,
        deepEqualCalls: 0,
        changedEntries: 0,
        removedEntries: 0,
        mergedEntries: 0,
      };
      let misses = zeroLayoutMergeMisses();
      let switchCount = 0;

      for (let i = 0; i < 12; i += 1) {
        misses = addLayoutMergeMisses(misses, accumulateSwitch(plans[i % plans.length], totals));
        switchCount += 1;
      }

      return {
        durationMs: totals.captureMs + totals.mergeMs,
        metrics: {
          switchCount,
          captureMs: totals.captureMs,
          mergeMs: totals.mergeMs,
          correctnessProbeMs: totals.probeMs,
          payloadBytes: totals.payloadBytes,
          deepEqualCalls: totals.deepEqualCalls,
          changedEntries: totals.changedEntries,
          removedEntries: totals.removedEntries,
          mergedEntries: totals.mergedEntries,
          ...misses,
        },
      };
    },
  },
  {
    id: "PERF-013",
    name: "Worktree Switch with 15+ Panels",
    description:
      "Re-scope 190 panels onto an incoming worktree through the real panel index: full rebuild, the eager spawn-batch adds a group re-derive must still see (#9649), the shared grid/dock scope predicate (#11289), the move/close maintenance, and the bucket reference-stability invariant the per-row selectors depend on.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 28 },
    warmups: 2,
    correctness: [
      "indexBuildMisses",
      "pendingIndexMisses",
      "candidateMisses",
      "gridScopeMisses",
      "dockScopeMisses",
      "mutationMisses",
      "referenceStabilityMisses",
      "scopeProbeMisses",
    ],
    async run() {
      const observed = runWorktreeScopePass(LARGE_WORKTREE_SCOPE_PLAN);
      const misses = worktreeScopeMisses(LARGE_WORKTREE_SCOPE_PLAN, observed);

      return {
        durationMs: observed.elapsedMs,
        metrics: {
          visiblePanels: observed.visiblePanels,
          visibleDockPanels: observed.visibleDockPanels,
          candidatePanels: observed.candidateIds.length,
          scopeChecks: observed.scopeChecks,
          stableBucketCount: observed.stableBuckets,
          ...misses,
        },
      };
    },
  },
];
