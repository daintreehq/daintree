import type { PerfScenario } from "../types";
import {
  createPersistedLayout,
  projectSwitchPhaseMisses,
  simulateProjectSwitchPhased,
  spinEventLoop,
} from "../lib/workloads";
import { ProjectViewHarness, flushImmediates } from "../lib/projectViewFixture";

const SMALL_LAYOUT = createPersistedLayout(60, 6, 310);
const MEDIUM_LAYOUT = createPersistedLayout(90, 6, 311);
const LARGE_LAYOUT = createPersistedLayout(140, 10, 312);

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
  {
    id: "PERF-070",
    name: "Project Switch Phases - Small",
    description: "Phase-instrumented project switch with a small layout (60 panels, 6 worktrees).",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 28 },
    warmups: 2,
    correctness: ["phaseMisses"],
    async run() {
      const spec = { outgoingStateSize: 40, incomingLayout: SMALL_LAYOUT };
      const result = simulateProjectSwitchPhased(spec);
      await spinEventLoop(0.5);

      return {
        durationMs: 0,
        metrics: {
          ...result.phases,
          checksum: result.checksum,
          phaseMisses: projectSwitchPhaseMisses(spec, result),
        },
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
    correctness: ["phaseMisses"],
    async run() {
      const spec = { outgoingStateSize: 80, incomingLayout: MEDIUM_LAYOUT };
      const result = simulateProjectSwitchPhased(spec);
      await spinEventLoop(0.5);

      return {
        durationMs: 0,
        metrics: {
          ...result.phases,
          checksum: result.checksum,
          phaseMisses: projectSwitchPhaseMisses(spec, result),
        },
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
    correctness: ["phaseMisses"],
    async run() {
      const spec = { outgoingStateSize: 150, incomingLayout: LARGE_LAYOUT };
      const result = simulateProjectSwitchPhased(spec);
      await spinEventLoop(0.5);

      return {
        durationMs: 0,
        metrics: {
          ...result.phases,
          checksum: result.checksum,
          phaseMisses: projectSwitchPhaseMisses(spec, result),
        },
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
    correctness: ["phaseMisses"],
    async run() {
      const sizes = [50, 100, 200];
      let checksum = 0;
      let serializeTotalMs = 0;
      let totalSwitchWorkMs = 0;
      let visibleTotalMs = 0;
      let hydrateTotalMs = 0;
      let phaseMisses = 0;

      for (const size of sizes) {
        const spec = { outgoingStateSize: size, incomingLayout: MEDIUM_LAYOUT };
        const result = simulateProjectSwitchPhased(spec);
        checksum += result.checksum;
        serializeTotalMs += result.phases.serializeMs;
        totalSwitchWorkMs += result.phases.totalMs;
        visibleTotalMs += result.phases.visibleMs;
        hydrateTotalMs += result.phases.hydrateMs;
        phaseMisses += projectSwitchPhaseMisses(spec, result);
      }

      await spinEventLoop(1);

      return {
        durationMs: 0,
        metrics: {
          checksum,
          serializeTotalMs,
          totalSwitchWorkMs,
          visibleTotalMs,
          hydrateTotalMs,
          phaseMisses,
        },
      };
    },
  },
  ...projectViewScenarios,
];
