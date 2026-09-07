import { performance } from "node:perf_hooks";

import type { PerfScenario, ScenarioSample } from "../types";
import type { CliAvailability } from "../../../shared/types/ipc";
import {
  activateArm,
  addRefreshGrade,
  ALWAYS_ABSENT_AGENT_ID,
  captureConsole,
  duplicateMilestoneKey,
  DUPLICATE_AGENT_ID,
  emptyRefreshGrade,
  getArm,
  gradeRefresh,
  loadCliModules,
  persistedMilestoneKeys,
  refreshMisses,
  refreshPathCallCount,
  resetMilestoneStore,
  storeWriteKeys,
  type CliArm,
  type CliArmLabel,
  type CliModules,
} from "../lib/cliAvailabilityFixture";
import {
  allSpawnMark,
  allSpawnsSince,
  installGitSpawnCounter,
  spawnObserverMisses,
} from "../lib/gitPipelineFixture";

/**
 * The CLI-availability probe storm the agent setup wizard runs.
 *
 * `useAgentSetupPoll` calls `cliAvailabilityClient.refresh()` every **3000 ms**
 * for as long as the wizard is open, and `refresh()` is deliberately
 * cache-bypassing: it awaits a PATH refresh, bumps `checkId`, drops any
 * in-flight check and re-probes all 18 agents from scratch. On a machine with
 * nothing installed — a brand-new user, which is exactly who has the wizard
 * open — every one of those probes misses, and a miss on POSIX costs two
 * subprocess starts rather than one, because `which -a` exiting non-zero is
 * indistinguishable from a `which` that rejects the `-a` flag.
 *
 * `lib/cliAvailabilityFixture.ts` states what is real and what is stubbed. The
 * limit to carry into every reading: `refreshPath()` is stubbed, so the
 * login-shell probe it performs — once per `refresh()`, and twice on the first
 * one — is COUNTED here but not TIMED. It is stubbed because the real one
 * replaces `process.env.PATH` with the user's own, which would put their
 * actually-installed agent CLIs into a benchmark that must not touch them.
 *
 * Both scenarios grade in both directions. `foundSetMisses` is a symmetric
 * difference, so answering "ready" for everything scores as heavily as
 * answering "missing" for everything; `absentAgentMisses` covers the arm where
 * the planted set is empty and a no-op's found set trivially matches; and
 * `spawnCountMisses` is signed against arithmetic this fixture did over its own
 * planting decisions, so a probe ladder that quietly stopped running scores
 * positive while one that over-probes scores negative.
 *
 * `checkAuth` is graded the same way. It is a real filesystem walk per found
 * agent and it is inside every measured refresh, but with an empty synthetic
 * HOME every found agent came back `unauthenticated` and the found-set terms
 * collapse every non-`missing` state into one bucket — so bypassing auth
 * discovery turned them all `ready`, did less work, and scored nothing. The
 * fixture now plants credentials for half the roster and clears every
 * credential env var the roster recognises (`checkAuth` reads env FIRST, so a
 * developer's own `ANTHROPIC_API_KEY` would otherwise decide the answer), and
 * `authStateMisses` grades `ready` against `unauthenticated` per agent.
 */

const WARMUPS = 1;

/** Refreshes one wizard poll window issues. 3 × 3000 ms ≈ nine seconds open. */
const POLL_WINDOW_REFRESHES = 3;

/** Refreshes per minute at the wizard's own cadence, for the projection. */
const REFRESHES_PER_MINUTE = 20;

const CORE_CORRECTNESS = [
  "foundSetMisses",
  "absentAgentMisses",
  "stateCoverageMisses",
  "spawnCountMisses",
  "authStateMisses",
  "authHermeticityMisses",
  "authSplitMisses",
  "pathRefreshMisses",
  "pathHermeticityMisses",
  "spawnObserverMisses",
] as const;

/** `store.set` calls for the duplicate-install milestone key, so far. */
const MILESTONE_STORE_KEY = "orchestrationMilestones";

function milestoneWriteCount(): number {
  return storeWriteKeys().filter((key) => key === MILESTONE_STORE_KEY).length;
}

interface RefreshMeasurement {
  ms: number;
  spawns: number;
  availability: CliAvailability;
  refreshPathCalls: number;
}

interface AvailabilityService {
  refresh: () => Promise<CliAvailability>;
  checkAvailability: () => Promise<CliAvailability>;
  getDetails: () => Record<string, { allResolvedPaths?: string[] }> | null;
}

/**
 * Drive one call and bracket it with the harness's spawn observer.
 *
 * The mark is taken immediately before the call and read immediately after, so
 * the count is the calls the probe ladder itself made. The observer's own
 * self-validation runs before the window opens — its probe child would
 * otherwise land inside the count it is validating.
 */
async function measureCall(call: () => Promise<CliAvailability>): Promise<RefreshMeasurement> {
  const refreshCallsBefore = refreshPathCallCount();
  const mark = allSpawnMark();
  const start = performance.now();
  const availability = await call();
  const ms = performance.now() - start;
  const spawns = allSpawnsSince(mark).count;
  return {
    ms,
    spawns,
    availability,
    refreshPathCalls: refreshPathCallCount() - refreshCallsBefore,
  };
}

function newService(modules: CliModules): AvailabilityService {
  return new modules.CliAvailabilityService() as unknown as AvailabilityService;
}

export const cliAvailabilityScenarios: PerfScenario[] = [
  {
    id: "PERF-393",
    name: "CLI Availability First-Run Probe Storm",
    description:
      "Three back-to-back cache-bypassing CliAvailabilityService.refresh() calls against a synthetic bin directory with nothing installed — one agent setup wizard poll window with the 3-second waits removed, and the worst case a brand-new user hits. Reports subprocess starts per refresh through the harness's own spawn observer and projects them to the wizard's real cadence. A miss costs two starts on POSIX, not one, because `which -a` exiting non-zero cannot be told apart from a `which` that rejects `-a`. Graded against arithmetic this fixture did over its own planting decisions: the signed spawn count, a deliberately never-planted agent that must report absent, full registry coverage in the returned map, and a PATH-hermeticity check so a machine with an agent CLI in /usr/bin cannot produce a quietly wrong found set. The real checkAuth walk is inside the bracket and is graded per agent: this fixture plants credentials for half the roster and clears every credential env var the roster recognises, so bypassing auth discovery scores rather than reporting ready for free.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...CORE_CORRECTNESS],
    platforms: { win32: "diagnostic" },
    async run(): Promise<ScenarioSample> {
      const modules = await loadCliModules();
      const arm = getArm(modules, "allMiss");
      activateArm(arm);

      installGitSpawnCounter();
      const observerMisses = spawnObserverMisses();

      const service = newService(modules);
      const grade = emptyRefreshGrade();
      const restoreConsole = captureConsole();

      const perRefresh: RefreshMeasurement[] = [];
      try {
        for (let index = 0; index < POLL_WINDOW_REFRESHES; index += 1) {
          const measurement = await measureCall(() => service.refresh());
          perRefresh.push(measurement);
          addRefreshGrade(
            grade,
            gradeRefresh(modules, arm, {
              availability: measurement.availability,
              spawns: measurement.spawns,
              refreshPathCalls: measurement.refreshPathCalls,
              // The first `refresh()` on a fresh service refreshes PATH twice:
              // once in `refresh()` itself, and once inside
              // `checkAvailability()` because `availability` is still null.
              // Every later one refreshes it exactly once. Both are the
              // product's own behaviour, and both are counted.
              expectedRefreshPathCalls: index === 0 ? 2 : 1,
            })
          );
        }
      } finally {
        restoreConsole();
      }

      const totalMs = perRefresh.reduce((sum, item) => sum + item.ms, 0);
      const windowSpawns = perRefresh.reduce((sum, item) => sum + item.spawns, 0);
      const spawnsPerRefresh = windowSpawns / perRefresh.length;

      const metrics: Record<string, number> = {
        windowSpawns,
        spawnsPerRefresh,
        projectedSpawnsPerMinute: spawnsPerRefresh * REFRESHES_PER_MINUTE,
        agentsProbed: modules.agentIds.length,
        firstRefreshMs: perRefresh[0]?.ms ?? 0,
        steadyRefreshMs: perRefresh[perRefresh.length - 1]?.ms ?? 0,
        pathRefreshCalls: perRefresh.reduce((sum, item) => sum + item.refreshPathCalls, 0),
        spawnObserverMisses: observerMisses,
        ...refreshMisses(grade),
      };

      return {
        durationMs: totalMs,
        metrics,
        notes: `${modules.agentIds.length} agents, ${POLL_WINDOW_REFRESHES} refreshes, expected ${arm.expectedSpawns} spawns each`,
      };
    },
  },
  {
    id: "PERF-394",
    name: "CLI Availability Cost by Hit Ratio",
    description:
      "One cache-bypassing refresh() per arm across a 0% / ~50% / 100% hit ratio against synthetic bin directories, plus the DAINTREE_CLI_PATH_PREPEND seam and a plain checkAvailability() on an already-populated service. The spread is the whole finding: a hit found through the prepended path costs no subprocess at all (it is an access() that returns before the shell probe), a hit found on PATH costs one, and a miss costs two. The 100% arm plants a second install of one agent in a second PATH directory, so the real which -a duplicate detection, dedupePathsByDirectory and the notifyDuplicateInstalls milestone write are on the measured path and carry their own predicates. The milestone is now graded rather than assumed: the stubbed store is reset at the top of every iteration, so exactly one orchestrationMilestones write carrying this agent's key must land on the duplicate arm, the arm with no duplicate must write none, and the two checkAvailability re-probes that follow must add none. Auth discovery is graded per agent against credentials this fixture planted for half the roster, so a probe that skips checkAuth reports ready for the unauthenticated half and scores.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...CORE_CORRECTNESS, "duplicateDetectionMisses", "milestonePersistenceMisses"],
    platforms: { win32: "diagnostic" },
    async run(): Promise<ScenarioSample> {
      const modules = await loadCliModules();
      installGitSpawnCounter();
      const observerMisses = spawnObserverMisses();

      // Put the milestone transition back. `notifyDuplicateInstalls` writes
      // once per agent and then skips forever, so without this the write is a
      // first-iteration-only event and could never be a predicate.
      resetMilestoneStore();

      const grade = emptyRefreshGrade();
      const metrics: Record<string, number> = {};
      let duplicateDetectionMisses = 0;
      let milestonePersistenceMisses = 0;
      let totalMs = 0;
      let consoleLines = 0;

      const armLabels: CliArmLabel[] = ["allMiss", "half", "allHit", "prepend"];

      for (const label of armLabels) {
        const arm: CliArm = getArm(modules, label);
        activateArm(arm);
        // A fresh service per arm: `checkId` and the npm-prefix cache are
        // per-instance, and carrying one arm's cache into the next would price
        // the npm probe once instead of once per refresh.
        const service = newService(modules);
        const restoreConsole = captureConsole();
        let measurement: RefreshMeasurement;
        try {
          measurement = await measureCall(() => service.refresh());
        } finally {
          consoleLines += restoreConsole();
        }

        addRefreshGrade(
          grade,
          gradeRefresh(modules, arm, {
            availability: measurement.availability,
            spawns: measurement.spawns,
            refreshPathCalls: measurement.refreshPathCalls,
            expectedRefreshPathCalls: 2,
          })
        );

        totalMs += measurement.ms;
        metrics[`${label}Ms`] = measurement.ms;
        metrics[`${label}Spawns`] = measurement.spawns;
        metrics[`${label}Hits`] = arm.plantedIds.length;

        if (arm.hasDuplicate) {
          // The shell probe found two installs in two directories, so the real
          // `dedupePathsByDirectory` must report both. A probe that returned the
          // first match and stopped scores here and nowhere else. The milestone
          // WRITE is a separate claim and is graded separately below, against
          // the store — it is not implied by this one.
          const details = service.getDetails();
          const paths = details?.[DUPLICATE_AGENT_ID]?.allResolvedPaths ?? [];
          if (paths.length !== 2) duplicateDetectionMisses += 1;

          const nonDuplicate = arm.plantedIds.find(
            (id) => id !== DUPLICATE_AGENT_ID && id !== ALWAYS_ABSENT_AGENT_ID
          );
          // The opposite direction: an agent with exactly one install must NOT
          // be reported as duplicated, so a probe that reports every agent as
          // multiply installed is caught on the same pass.
          if (nonDuplicate !== undefined) {
            const single = details?.[nonDuplicate]?.allResolvedPaths;
            if (single !== undefined && single.length > 1) duplicateDetectionMisses += 1;
          }

          // The milestone write, graded rather than asserted in a comment. The
          // store was reset at the top of this iteration, and this is the first
          // arm with a second install on PATH, so exactly one
          // `orchestrationMilestones` write must have landed and it must carry
          // this agent's key and no other.
          if (milestoneWriteCount() !== 1) milestonePersistenceMisses += 1;
          const persisted = persistedMilestoneKeys();
          if (persisted.length !== 1) milestonePersistenceMisses += 1;
          if (!persisted.includes(duplicateMilestoneKey(DUPLICATE_AGENT_ID))) {
            milestonePersistenceMisses += 1;
          }
        } else if (milestoneWriteCount() !== 0 && label === "allMiss") {
          // The control: an arm with no duplicate anywhere on PATH must not
          // write the milestone at all. Checked on the first arm, before the
          // duplicate arm has had a chance to write one.
          milestonePersistenceMisses += 1;
        }
      }

      // The suppression half, on the arm that ran AFTER the duplicate one: the
      // prepend arm re-probes the same roster with no second install, and must
      // not have added a write.
      const writesAfterArms = milestoneWriteCount();
      if (writesAfterArms !== 1) milestonePersistenceMisses += 1;

      // The non-bypassing entry point on a service that already holds a result:
      // it re-probes exactly the same way, and the only thing it skips is the
      // PATH refresh. Measured last so it inherits the final arm's PATH.
      const finalArm = getArm(modules, "allHit");
      activateArm(finalArm);
      const cachedService = newService(modules);
      const restoreConsole = captureConsole();
      let checkMs = 0;
      let checkSpawns = 0;
      try {
        const first = await measureCall(() => cachedService.checkAvailability());
        addRefreshGrade(
          grade,
          gradeRefresh(modules, finalArm, {
            availability: first.availability,
            spawns: first.spawns,
            refreshPathCalls: first.refreshPathCalls,
            expectedRefreshPathCalls: 1,
          })
        );
        const second = await measureCall(() => cachedService.checkAvailability());
        addRefreshGrade(
          grade,
          gradeRefresh(modules, finalArm, {
            availability: second.availability,
            spawns: second.spawns,
            refreshPathCalls: second.refreshPathCalls,
            // `checkAvailability` refreshes PATH only while `availability` is
            // null, so the second call must not refresh it at all.
            expectedRefreshPathCalls: 0,
          })
        );
        checkMs = second.ms;
        checkSpawns = second.spawns;
        totalMs += first.ms + second.ms;
      } finally {
        consoleLines += restoreConsole();
      }

      // The `never again` half. The two `checkAvailability()` calls above
      // re-probe the allHit arm, duplicate and all, so `notifyDuplicateInstalls`
      // ran twice more and found the milestone already set both times. A
      // milestone gate that stopped suppressing scores here and nowhere else.
      if (milestoneWriteCount() !== writesAfterArms) milestonePersistenceMisses += 1;
      metrics.milestoneWriteCount = milestoneWriteCount();
      metrics.milestonePersistenceMisses = milestonePersistenceMisses;
      metrics.checkAvailabilityMs = checkMs;
      metrics.checkAvailabilitySpawns = checkSpawns;
      metrics.consoleDiagnosticLines = consoleLines;
      metrics.spawnObserverMisses = observerMisses;
      metrics.duplicateDetectionMisses = duplicateDetectionMisses;
      const missSpawns = metrics.allMissSpawns ?? 0;
      const hitSpawns = metrics.allHitSpawns ?? 0;
      metrics.missToHitSpawnRatio = hitSpawns > 0 ? missSpawns / hitSpawns : 0;

      return {
        durationMs: totalMs,
        metrics: { ...metrics, ...refreshMisses(grade) },
        notes: `${modules.agentIds.length} agents; ${ALWAYS_ABSENT_AGENT_ID} never planted`,
      };
    },
  },
];
