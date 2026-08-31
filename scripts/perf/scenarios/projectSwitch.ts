import type { PerfScenario } from "../types";
import { countUnreachableSwitchPhases, unreachablePhaseMisses } from "../lib/workloads";
import {
  buildLayoutMergePlan,
  layoutMergeMisses,
  runLayoutMergePass,
  type LayoutMergePlan,
} from "../lib/layoutMergeFixture";
import {
  buildHydrationPlan,
  hydrationPassMisses,
  loadStatePatcherModule,
  runHydrationPass,
  type HydrationPlan,
} from "../lib/hydrationFixture";
import { ProjectViewHarness, flushImmediates } from "../lib/projectViewFixture";

/**
 * PERF-070..073 — the phase-instrumented project switch.
 *
 * These four used to run `simulateProjectSwitchPhased`, seven hand-written
 * loops that built objects and timed the transform. Three of the seven phases
 * now run the production code the phase names claim, and those three are the
 * ONLY phases any duration here covers:
 *
 * | Phase                | Subject                                                     |
 * | -------------------- | ----------------------------------------------------------- |
 * | `serializeMs`        | REAL — `computeIdArrayDelta` x2 + `computeRecordDelta` over  |
 * |                      | `deepEqualIgnoringUndefined`, then the outgoing JSON payload |
 * | `ptyHibernateMs`     | UNAVAILABLE — no pty-host, so no duration is reported        |
 * | `storeResetMs`       | UNAVAILABLE — no React, so no subscriber fan-out to price    |
 * | `projectLoadMs`      | REAL — `mergeIdArray` x2 + `mergeRecord`, Main's side of the |
 * |                      | switch (`projectCrud/switch.ts` 373/391/423)                 |
 * | `terminalRestoreMs`  | REAL — the `statePatcher` restore builders, per panel        |
 * | `ptyWarmupMs`        | UNAVAILABLE — no pty-host, so nothing spawns                 |
 * | `gitFetchMs`         | UNAVAILABLE — no git subprocess (PERF-100..104 measure that) |
 *
 * WHAT THE HEADLINE COVERS. `visibleMs` is the pre-swap real work (the
 * outgoing delta capture plus Main's three-way merge) and `hydrateMs` the
 * post-visible real work (the per-panel restore builders); `totalMs` is their
 * sum, and `durationMs` is `totalMs`. Nothing simulated is inside any of them.
 *
 * That is the fix for a defect worth naming, because the harness has been
 * caught by this shape before. The four unavailable phases used to be TIMED —
 * a `Map.set` loop, a fill-and-clear over 17 plain Maps, a descriptor
 * allocation and another `Map.set` loop — and their durations were added into
 * `visibleMs`, `hydrateMs` and `totalMs`. A reader optimising against the
 * headline was optimising partly against the benchmark's own loops, and
 * deleting one of those loops would have shown up as a faster project switch.
 * `countUnreachableSwitchPhases` now returns counts and no durations at all,
 * so no headline can sum one.
 *
 * The four phases still RUN, and each still reports the count only it can
 * post — `hibernatedTerminals`, `resetStores`, `ptyDescriptors`,
 * `fileStatuses` — graded by `unreachablePhaseMisses`. Those counts are the
 * whole of what this scenario can say about them: there is no latency figure
 * for PTY hibernate, store reset, PTY warmup or git fetch anywhere in this
 * file, and the four are unavailable rather than fast.
 */

const SMALL_MERGE_PLAN = buildLayoutMergePlan("small", 60, 310);
const MEDIUM_MERGE_PLAN = buildLayoutMergePlan("medium", 90, 311);
const LARGE_MERGE_PLAN = buildLayoutMergePlan("large", 140, 312);

const SMALL_HYDRATION_PLAN = buildHydrationPlan("small", 60, 6);
const MEDIUM_HYDRATION_PLAN = buildHydrationPlan("medium", 90, 6);
const LARGE_HYDRATION_PLAN = buildHydrationPlan("large", 140, 10);

const PHASE_CORRECTNESS = [
  // The real merge pipeline, one term per operation.
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
  // The real per-panel restore builders.
  "kindInferenceMisses",
  "backendRestoreMisses",
  "reconnectRestoreMisses",
  "respawnResumeMisses",
  "resumeSuppressionMisses",
  "nonPtyRestoreMisses",
  "sanitizerMisses",
  "orphanMisses",
  "routeCoverageMisses",
  // The four phases that are still simulations. They report NO duration, so
  // these counts are the only evidence they ran at all.
  "hibernateMisses",
  "storeResetMisses",
  "ptyWarmupMisses",
  "gitFetchMisses",
] as const;

interface PhasedSwitchSample {
  durationMs: number;
  metrics: Record<string, number>;
}

/**
 * One phased switch, in the order Main and the renderer run the phases.
 *
 * Every duration is measured around its own phase, and the two oracles are
 * evaluated afterwards so neither shows up in a phase it grades.
 */
async function runPhasedSwitch(
  mergePlan: LayoutMergePlan,
  hydrationPlan: HydrationPlan,
  outgoingTerminalCount: number
): Promise<PhasedSwitchSample> {
  const mod = await loadStatePatcherModule();
  const residualSpec = {
    outgoingTerminalCount,
    incomingPanelCount: hydrationPlan.panels.length,
    worktreeCount: 10,
  };

  const merge = runLayoutMergePass(mergePlan);
  // Runs between the two real halves, where the real switch runs it — and
  // contributes counts only. It has no clock around it and returns no
  // duration, so nothing it does can reach a headline below.
  const residual = countUnreachableSwitchPhases(residualSpec);
  const hydration = runHydrationPass(mod, hydrationPlan);

  const serializeMs = merge.captureMs;
  const projectLoadMs = merge.mergeMs;
  const terminalRestoreMs = hydration.elapsedMs;
  // Real work only. PTY hibernate and store reset sit between these two in a
  // real switch and are unavailable here, so `visibleMs` is a floor over the
  // two phases this process can actually run, not a switch's visible latency.
  const visibleMs = serializeMs + projectLoadMs;
  // Same rule: PTY warmup and the git fetch are unavailable, so this is the
  // restore-builder half alone.
  const hydrateMs = terminalRestoreMs;
  const totalMs = visibleMs + hydrateMs;

  return {
    durationMs: totalMs,
    metrics: {
      serializeMs,
      projectLoadMs,
      terminalRestoreMs,
      totalMs,
      visibleMs,
      hydrateMs,
      // Outside `totalMs`: the null/unit merge probes are this scenario's own
      // oracle, not part of the switch it describes.
      correctnessProbeMs: merge.probeMs,
      payloadBytes: merge.payloadBytes,
      deepEqualCalls: merge.deepEqualCalls,
      mergedEntries: merge.mergedTerminals.length,
      restoredPanels: hydration.builtPanelCount,
      // The four unavailable phases, as counts. There is deliberately no
      // `ptyHibernateMs`/`storeResetMs`/`ptyWarmupMs`/`gitFetchMs` beside
      // them: a simulated loop's wall-clock is not that phase's latency, and
      // reporting one under that name is how it ends up summed.
      hibernatedTerminals: residual.hibernatedTerminals,
      resetStores: residual.resetStores,
      ptyDescriptors: residual.ptyDescriptors,
      fileStatuses: residual.fileStatuses,
      ...layoutMergeMisses(mergePlan, merge),
      ...hydrationPassMisses(hydrationPlan, hydration),
      ...unreachablePhaseMisses(residualSpec, residual),
    },
  };
}

const phasedSwitchScenarios: PerfScenario[] = [
  {
    id: "PERF-070",
    name: "Project Switch Phases - Small",
    description:
      "Phase-instrumented project switch with a small layout (60 panels, 6 worktrees). Every duration here covers exactly three phases, all real: serialize (the outgoing delta), project-load (Main's three-way merge) and terminal-restore (the per-panel restore builders). PTY hibernate, store reset, PTY warmup and git fetch are UNAVAILABLE in a plain Node process — they run as simulations for their counts and report no duration, so totalMs/visibleMs/hydrateMs contain no simulated work.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 28 },
    warmups: 2,
    correctness: PHASE_CORRECTNESS,
    run: () => runPhasedSwitch(SMALL_MERGE_PLAN, SMALL_HYDRATION_PLAN, 40),
  },
  {
    id: "PERF-071",
    name: "Project Switch Phases - Medium",
    description:
      "Phase-instrumented project switch with a medium layout (90 panels, 6 worktrees). Same three-real-phase headline and same four unavailable phases as PERF-070.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 28 },
    warmups: 2,
    correctness: PHASE_CORRECTNESS,
    run: () => runPhasedSwitch(MEDIUM_MERGE_PLAN, MEDIUM_HYDRATION_PLAN, 80),
  },
  {
    id: "PERF-072",
    name: "Project Switch Phases - Large",
    description:
      "Phase-instrumented project switch with a large layout (140 panels, 10 worktrees). Same three-real-phase headline and same four unavailable phases as PERF-070.",
    tier: "fast",
    modes: ["ci", "nightly"],
    iterations: { ci: 16, nightly: 24 },
    warmups: 2,
    correctness: PHASE_CORRECTNESS,
    run: () => runPhasedSwitch(LARGE_MERGE_PLAN, LARGE_HYDRATION_PLAN, 150),
  },
  {
    id: "PERF-073",
    name: "Project Switch Phase Regression - Serialize Heavy",
    description:
      "Sweeps three layout sizes in one iteration so the real delta+merge cost can be read against panel count — the shape a superlinear regression in deepEqualIgnoringUndefined or mergeIdArray would show up as. The reported duration is the sum of the three real phases across the sweep, not the sweep's wall-clock.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    correctness: PHASE_CORRECTNESS,
    async run() {
      const sweep: Array<[LayoutMergePlan, HydrationPlan, number]> = [
        [SMALL_MERGE_PLAN, SMALL_HYDRATION_PLAN, 50],
        [MEDIUM_MERGE_PLAN, MEDIUM_HYDRATION_PLAN, 100],
        [LARGE_MERGE_PLAN, LARGE_HYDRATION_PLAN, 200],
      ];

      const totals: Record<string, number> = {};
      let serializeTotalMs = 0;
      let totalSwitchWorkMs = 0;

      for (const [mergePlan, hydrationPlan, outgoing] of sweep) {
        const sample = await runPhasedSwitch(mergePlan, hydrationPlan, outgoing);
        serializeTotalMs += sample.metrics.serializeMs;
        totalSwitchWorkMs += sample.metrics.totalMs;
        for (const [name, value] of Object.entries(sample.metrics)) {
          totals[name] = (totals[name] ?? 0) + value;
        }
      }

      return {
        // The sum of the three REAL phases across the sweep, not the sweep's
        // wall-clock. Wall-clock here would put the four simulated phases and
        // the oracle passes back inside the headline by the back door, which is
        // the defect the rest of this file exists to keep out of it.
        durationMs: totalSwitchWorkMs,
        metrics: {
          ...totals,
          serializeTotalMs,
          totalSwitchWorkMs,
          sweepSteps: sweep.length,
        },
      };
    },
  },
];

/**
 * PERF-074..077 — the real per-project view machinery.
 *
 * PERF-070..073 above are synthetic data transforms: they build objects and
 * time the transform. These four instead construct a real
 * `ProjectViewManager` and drive real switches through it, so the LRU order,
 * the cold/warm classification, the pressure ladder's per-pass budget and the
 * protection tiers are all decided by product code. See
 * `lib/projectViewFixture.ts` for exactly where the real code stops and the
 * inert Chromium stand-in begins — and for why every headline here is a count
 * rather than a latency.
 *
 * Every count is paired with a correctness reading emitted as `*Misses`. A
 * cache that evicts nothing, a switch path that never verifies its bootstrap,
 * and a pressure ladder that has gone dark all score a perfect zero on the
 * counts alone.
 *
 * What these four do NOT cover, so nobody reads more into them than is there:
 * switch-to-paint latency (no renderer, so the runner's wall-clock number is
 * harness time), real renderer creation cost, actual RSS release, and
 * mid-flight cancellation — `switchTo` chains behind the previous switch's
 * settlement, so a burst queues rather than supersedes. Those need a real
 * Electron run.
 */

const WARM_PROJECTS = ["pv-warm-0", "pv-warm-1", "pv-warm-2", "pv-warm-3"];
const WARM_ROTATION = [
  "pv-warm-2",
  "pv-warm-0",
  "pv-warm-3",
  "pv-warm-1",
  "pv-warm-2",
  "pv-warm-3",
  "pv-warm-0",
  "pv-warm-1",
];

const COLD_CACHE_LIMIT = 2;
const COLD_PROJECTS = [
  "pv-cold-0",
  "pv-cold-1",
  "pv-cold-2",
  "pv-cold-3",
  "pv-cold-4",
  "pv-cold-5",
];

const PRESSURE_PROJECTS = ["pv-p-0", "pv-p-1", "pv-p-2", "pv-p-3", "pv-p-4"];
/** Assistant-backed: the unconditional eviction floor (#11157). */
const PRESSURE_ASSISTANT_PROJECT = "pv-p-0";
/** Active agent: the soft tier — evictable, but only after safe candidates. */
const PRESSURE_AGENT_PROJECT = "pv-p-1";
const PRESSURE_POLICY = { criticalMb: 500, warningMb: 2000 };
/** Inside the soft band, low enough that the settled target is one view. */
const PRESSURE_SAMPLE_AVAILABLE_MB = 600;
/** Comfortably above `warningMb`, so the ladder must decline to act. */
const HEALTHY_AVAILABLE_MB = 8_000;

/** Includes a return to a project already in the burst, so the queue has to
 *  resolve both a cold start and a cache hit without draining in between. */
const RACE_SEQUENCE = ["pv-race-a", "pv-race-b", "pv-race-c", "pv-race-a", "pv-race-d"] as const;
const RACE_CACHE_LIMIT = 3;

/** Enough for `Date.now()` to advance, so recency stamps stay distinct. */
const CLOCK_TICK_MS = 2;
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const projectViewScenarios: PerfScenario[] = [
  {
    id: "PERF-074",
    name: "Project View Warm Switch Rotation",
    description:
      "Rotates a real ProjectViewManager across four cached WebContentsViews inside its cache limit, counting warm reactivations against cold starts and the wake signal each warm switch must emit.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["warmSwitchMisses", "attachMisses", "closeMisses"],
    async run() {
      const harness = await ProjectViewHarness.create({
        cachedProjectViews: WARM_PROJECTS.length,
      });
      try {
        for (const projectId of WARM_PROJECTS) {
          await harness.switchTo(projectId);
        }
        // Everything above was a cold start by construction; only the
        // rotation below is the measurement.
        const createdBefore = harness.ledger.created;
        const warmSendsBefore = harness.ledger.warmActivateSends;

        let warmSwitchCount = 0;
        let coldStartCount = 0;
        let switchFailureCount = 0;
        let evictionCount = 0;
        let closeMisses = 0;
        let listenerLeakCount = 0;

        for (const projectId of WARM_ROTATION) {
          const outcome = await harness.switchTo(projectId);
          if (!outcome.ok) switchFailureCount++;
          else if (outcome.isNew) coldStartCount++;
          else warmSwitchCount++;
          evictionCount += outcome.evicted.length;
          closeMisses += outcome.closeMisses;
          listenerLeakCount += outcome.listenerLeaks;
        }

        const warmActivateSendCount = harness.ledger.warmActivateSends - warmSendsBefore;
        return {
          durationMs: 0,
          metrics: {
            warmSwitchCount,
            // Paired with warmSwitchCount: a cache that silently stopped
            // hitting would raise this and lower that, while a cache that
            // stopped evicting would leave both untouched — which is why
            // evictionCount and residentViewCount are here too.
            coldStartCount,
            viewCreateCount: harness.ledger.created - createdBefore,
            // The deterministic wake trigger every cache hit must send
            // (#9679). A warm switch that stops sending it leaves the
            // renderer with no signal to repair its atlas, and the miss
            // below is the only place that shows up as a number.
            warmActivateSendCount,
            // Two-sided on purpose: a missing send strands the renderer with
            // no wake trigger, and a duplicated one wakes a view twice per
            // switch. A one-sided max() would have excused the second.
            warmSwitchMisses: Math.abs(warmSwitchCount - warmActivateSendCount),
            switchFailureCount,
            evictionCount,
            residentViewCount: harness.residentProjectIds().length,
            // Emitted raw, with its own two-sided miss: exactly one view is
            // attached once a switch has settled. Two is the duplicated-view
            // regression (#10806); zero is a reveal that never happened, and
            // an "orphans = count - 1" reading would have scored that
            // perfectly.
            attachedViewCount: harness.attachedViewCount(),
            attachMisses: Math.abs(harness.attachedViewCount() - 1),
            closeMisses,
            listenerLeakCount,
          },
        };
      } finally {
        harness.dispose();
      }
    },
  },
  {
    id: "PERF-075",
    name: "Project View Cold Switch with LRU Eviction",
    description:
      "Walks a real ProjectViewManager across six projects with a two-view cache so every switch cold-starts a WebContentsView and evicts one, checking LRU order and teardown against the manager's own state.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: [
      "lruOrderMisses",
      "lruRequestOrderMisses",
      "bootstrapProbeMisses",
      "capOverflowCount",
      "attachMisses",
    ],
    async run() {
      const harness = await ProjectViewHarness.create({
        cachedProjectViews: COLD_CACHE_LIMIT,
      });
      try {
        // Forward then back, without repeating the turn-around project — a
        // same-project switchTo is a no-op the manager returns early on, and
        // counting it as a cache hit would inflate warmSwitchCount with a
        // switch that never happened.
        const walk = [...COLD_PROJECTS, ...COLD_PROJECTS.slice(0, -1).reverse()];
        let coldStartCount = 0;
        let warmSwitchCount = 0;
        let switchFailureCount = 0;
        let evictionCount = 0;
        let lruOrderMisses = 0;
        let lruRequestOrderMisses = 0;
        let closeMisses = 0;
        let listenerLeakCount = 0;
        let capOverflowCount = 0;
        const probesBefore = harness.ledger.bootstrapProbes;

        // The independent oracle. `lruOrderMisses` reads the manager's own
        // `lastUsed` stamps, so a policy that stopped maintaining them sorts
        // garbage and still scores zero. This model is built from the walk —
        // the driver's own input, which no product change can move — and says
        // only what the spec says: least recently REQUESTED goes first.
        const lastRequestedAt = new Map<string, number>();
        let step = 0;

        for (const projectId of walk) {
          // `lastUsed` is `Date.now()`, and the eviction controller documents
          // its reliance on sequential switches landing on distinct
          // milliseconds. A real cold switch takes 100-500 ms; this harness
          // finishes one in well under 1 ms, so without pacing the stamps tie
          // and the LRU sort falls back to map insertion order. Left unpaced,
          // the request-order oracle below reports a violation that only the
          // harness's clock resolution can produce.
          await sleepMs(CLOCK_TICK_MS);
          const residentBefore = harness.residentProjectIds();
          const outcome = await harness.switchTo(projectId);
          lastRequestedAt.set(projectId, step++);

          if (!outcome.ok) switchFailureCount++;
          else if (outcome.isNew) coldStartCount++;
          else warmSwitchCount++;
          evictionCount += outcome.evicted.length;
          lruOrderMisses += outcome.lruOrderMisses;
          closeMisses += outcome.closeMisses;
          listenerLeakCount += outcome.listenerLeaks;
          if (harness.residentProjectIds().length > COLD_CACHE_LIMIT) capOverflowCount++;

          const survived = new Set(harness.residentProjectIds());
          for (const gone of outcome.evicted) {
            const goneAt = lastRequestedAt.get(gone) ?? -1;
            for (const kept of residentBefore) {
              if (kept === projectId || !survived.has(kept)) continue;
              if (goneAt > (lastRequestedAt.get(kept) ?? -1)) lruRequestOrderMisses++;
            }
          }
        }

        return {
          durationMs: 0,
          metrics: {
            coldStartCount,
            viewCreateCount: harness.ledger.created,
            warmSwitchCount,
            evictionCount,
            // The pair that stops "zero evictions" reading as a win: an
            // eviction pass that stopped running leaves the cache over its
            // limit, and this counts every switch that left it there.
            capOverflowCount,
            residentViewCount: harness.residentProjectIds().length,
            // Two oracles, deliberately. This one reads the manager's own
            // `lastUsed` stamps and catches a mis-sorted policy...
            lruOrderMisses,
            // ...and this one reads the walk, so it still catches a policy
            // whose recency stamps have stopped being maintained — the case
            // the stamp-based check agrees with.
            lruRequestOrderMisses,
            // Every cold start must run the product's bootstrap probe.
            bootstrapProbeCount: harness.ledger.bootstrapProbes - probesBefore,
            // Paired with it: a wrong-document guard (#11635) that stopped
            // running leaves this positive while every latency improves.
            bootstrapProbeMisses: Math.abs(
              harness.ledger.bootstrapProbes - probesBefore - coldStartCount
            ),
            switchFailureCount,
            closeMisses,
            listenerLeakCount,
            attachedViewCount: harness.attachedViewCount(),
            attachMisses: Math.abs(harness.attachedViewCount() - 1),
          },
        };
      } finally {
        harness.dispose();
      }
    },
  },
  {
    id: "PERF-076",
    name: "Project View Eviction Under Memory Pressure",
    description:
      "Drives the real graduated pressure ladder and the forced tier-2 reclaim across five cached views, one holding an active agent and one a live assistant backend, checking the per-pass budget, the soft agent tier's ordering and the hard assistant floor.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: [
      "pressureLadderMisses",
      "pressureBudgetMisses",
      "healthyBandMisses",
      "forcedConvergenceMisses",
      "protectedEvictionMisses",
      "assistantFloorMisses",
    ],
    async run() {
      const harness = await ProjectViewHarness.create({
        cachedProjectViews: PRESSURE_PROJECTS.length,
        memoryPressurePolicy: PRESSURE_POLICY,
        assistantProject: PRESSURE_ASSISTANT_PROJECT,
        activeAgents: [
          {
            terminalId: "pv-agent-terminal",
            projectId: PRESSURE_AGENT_PROJECT,
            agentState: "working",
          },
        ],
      });
      try {
        for (const projectId of PRESSURE_PROJECTS) {
          // Paced for the same reason as PERF-075: the eviction tiers are
          // ordered by `lastUsed`, and sub-millisecond prefill switches would
          // tie every stamp and leave the order decided by map insertion.
          await sleepMs(CLOCK_TICK_MS);
          await harness.switchTo(projectId);
        }
        const activeProjectId = harness.manager.getActiveProjectId();
        const evictedWcIds: number[] = [];
        const evictedProjects: string[] = [];

        // A healthy reading must move nothing. Without this the whole ladder
        // could be firing unconditionally and every other number here would
        // still look correct.
        const healthyPass = harness.pressurePass(HEALTHY_AVAILABLE_MB);
        const healthyBandMisses = healthyPass.evicted.length;

        // Two sampler ticks deep in the band. The settled target is ONE view,
        // but a periodic pass may only shed one per tick (#11477) — a pass
        // that collapses the cache instead is the regression this counts.
        let pressureBudgetMisses = 0;
        let pressureEvictionCount = 0;
        const gradualEvicted: string[] = [];
        for (let pass = 0; pass < 2; pass++) {
          const result = harness.pressurePass(PRESSURE_SAMPLE_AVAILABLE_MB);
          pressureEvictionCount += result.evicted.length;
          pressureBudgetMisses += Math.max(0, result.evicted.length - 1);
          gradualEvicted.push(...result.evicted);
          evictedWcIds.push(...result.wcIds);
          evictedProjects.push(...result.evicted);
        }
        // The soft tier: an active-agent view is evictable, but only once the
        // ordinary candidates are gone. Two of those exist here, so both
        // gradual passes must take them and leave the agent's view alone.
        // Without this the agent tier could be deleted outright and every
        // other number below would be unchanged.
        const agentTierOrderMisses = gradualEvicted.includes(PRESSURE_AGENT_PROJECT) ? 1 : 0;

        // Forced tier-2: one pass, collapse to the active view — except for
        // the assistant floor, which no band admits.
        const forced = harness.forcedReclaim();
        evictedWcIds.push(...forced.wcIds);
        evictedProjects.push(...forced.evicted);

        const resident = harness.residentProjectIds();
        const teardown = harness.teardownMisses(evictedWcIds);
        const protectedEvictionMisses =
          (evictedProjects.includes(PRESSURE_ASSISTANT_PROJECT) ? 1 : 0) +
          (activeProjectId !== null && evictedProjects.includes(activeProjectId) ? 1 : 0);
        // What the forced pass was supposed to converge on: the active view
        // plus whatever the assistant floor holds, and nothing else. A forced
        // reclaim that quietly became a no-op leaves the agent's view resident
        // here — and would otherwise have scored a perfect zero everywhere,
        // since `forcedReportMisses` is |0 - 0| when nothing moves.
        const forcedConvergenceMisses = resident.filter(
          (id) => id !== activeProjectId && id !== PRESSURE_ASSISTANT_PROJECT
        ).length;

        return {
          durationMs: 0,
          metrics: {
            pressureEvictionCount,
            // Zero here means the graduated ladder shed nothing at a reading
            // deep inside the band — the #11469/#11926 failure mode, where
            // reclaim quietly becomes emergency-only.
            pressureLadderMisses: pressureEvictionCount > 0 ? 0 : 1,
            pressureBudgetMisses,
            healthyBandMisses,
            forcedEvictionCount: forced.evicted.length,
            // What `evictStaleViews` reported vs what actually left the view
            // map. A divergence means the return value stopped describing the
            // pass, which is what callers gate their next step on.
            forcedReportMisses: Math.abs(forced.reported - forced.evicted.length),
            forcedConvergenceMisses,
            // Active view + the assistant-protected view. Anything less means
            // a protection floor gave way; anything more means the collapse
            // did not converge.
            residentAfterCollapseCount: resident.length,
            protectedEvictionMisses,
            agentTierOrderMisses,
            assistantFloorMisses: resident.includes(PRESSURE_ASSISTANT_PROJECT) ? 0 : 1,
            closeMisses: teardown.closeMisses,
            listenerLeakCount: teardown.listenerLeaks,
            attachedViewCount: harness.attachedViewCount(),
            attachMisses: Math.abs(harness.attachedViewCount() - 1),
          },
        };
      } finally {
        harness.dispose();
      }
    },
  },
  {
    id: "PERF-077",
    name: "Project View Rapid Queued Switches",
    description:
      "Queues five project switches onto the manager's switch chain in one tick (A-B-C-A-D) so cold starts and a cache hit interleave without the caller draining between them, then reads the settled active view, resident set and window child stack.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["finalActiveMisses", "attachMisses", "strandedViewCount"],
    async run() {
      const harness = await ProjectViewHarness.create({
        cachedProjectViews: RACE_CACHE_LIMIT,
      });
      try {
        const target = RACE_SEQUENCE[RACE_SEQUENCE.length - 1];
        // Created in one tick, so every switch after the first is already on
        // the chain before its predecessor has resolved.
        const pending = RACE_SEQUENCE.map((projectId) => harness.beginSwitch(projectId));
        const settled = await Promise.all(pending);
        // The LRU pass runs a tick after the last switch resolves.
        await flushImmediates(4);

        let switchFailureCount = 0;
        let coldStartCount = 0;
        let warmSwitchCount = 0;
        for (const result of settled) {
          if (result instanceof Error) {
            switchFailureCount++;
          } else if ((result as { isNew: boolean }).isNew) {
            coldStartCount++;
          } else {
            warmSwitchCount++;
          }
        }

        const resident = harness.residentProjectIds();
        const activeProjectId = harness.manager.getActiveProjectId();
        const teardown = harness.teardownMissesForDroppedViews();

        return {
          durationMs: 0,
          metrics: {
            switchRequestCount: RACE_SEQUENCE.length,
            viewCreateCount: harness.ledger.created,
            coldStartCount,
            // The queued return to A must still be served from cache. If this
            // drops to zero the burst is cold-starting a view it already had.
            warmSwitchCount,
            switchFailureCount,
            // The chain must land on the LAST request, not on whichever
            // switch happened to finish loading first.
            finalActiveMisses: activeProjectId === target ? 0 : 1,
            residentViewCount: resident.length,
            capOverflowCount: resident.length > RACE_CACHE_LIMIT ? 1 : 0,
            // Outgoing views must not be left composited behind the winner
            // (#10806), and the winner must actually be attached — hence the
            // two-sided miss rather than an "orphans" count.
            attachedViewCount: harness.attachedViewCount(),
            attachMisses: Math.abs(harness.attachedViewCount() - 1),
            // Views the product created, dropped from its map, and never
            // closed. Distinct from closeMisses: this catches a renderer
            // stranded with no entry pointing at it at all.
            strandedViewCount: Math.max(
              0,
              harness.ledger.created - harness.ledger.closed - resident.length
            ),
            closeMisses: teardown.closeMisses,
            listenerLeakCount: teardown.listenerLeaks,
          },
        };
      } finally {
        harness.dispose();
      }
    },
  },
];

export const projectSwitchScenarios: PerfScenario[] = [
  ...phasedSwitchScenarios,
  ...projectViewScenarios,
];
