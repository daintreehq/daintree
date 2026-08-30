import { basename, join } from "node:path";
import type PQueueType from "p-queue";
import type { PerfScenario, ScenarioSample } from "../types";
import type { WorktreeMonitor } from "../../../electron/workspace-host/WorktreeMonitor";
import {
  createMonitorHarness,
  getGitPipelineFixture,
  loadPipelineModules,
  sleep,
  spawnObserverMisses,
} from "../lib/gitPipelineFixture";
import {
  EmitRecorder,
  PIPELINE_QUIESCE_SETTLE_MS,
  pollUntil,
  quiesceGitSpawns,
  removeFileQuietly,
  uid,
  writeEditFile,
} from "../lib/worktreeSidebarFixture";
import {
  IDLE_WINDOW_MS,
  PROCESS_TREE_POLL_INTERVAL_MS,
  closeIdleWindow,
  createProcessTreeHarness,
  installProcessProbeFault,
  openIdleWindow,
  processProbeSpawnCount,
  processProbeWorks,
  removeProcessProbeFault,
  spawnProbeChild,
  stageProbeFile,
  unstageProbeFile,
  waitForProcessDiscovery,
  type IdleWindowReading,
  type ProbeChild,
  type ProbeFaultHandle,
  type ProcessTreeHarness,
} from "../lib/idleFixture";

/**
 * Idle-window scenarios (PERF-092..094): what the app costs while nobody is
 * touching it, measured by letting REAL long-lived services sit.
 *
 * These replace PERF-090/091, which described themselves as an idle window but
 * were a hand-written table of thirteen timer "groups" plus arithmetic over it.
 * No product code ran, no timer was ever armed, and the headline `wakeUpCount`
 * was a pure function of a constant array — the same number on every machine,
 * in every build, forever. A benchmark that cannot move cannot catch anything,
 * and #12042 (a git storm during idle on Windows) is precisely what it claimed
 * to be watching for.
 *
 * What actually runs here:
 *   PERF-092 — one real ProcessTreeCache, healthy, at the pty-host's own
 *              cadence.
 *   PERF-093 — the same service through a transient probe failure and out the
 *              other side: does it return to the cheap path?
 *   PERF-094 — a population: 20 real poll-fallback WorktreeMonitors (the
 *              worktrees past the background watcher budget) plus a
 *              ProcessTreeCache, idling together.
 *
 * Every count is paired with a correctness reading, because the failure mode of
 * a count-only idle benchmark is that breaking the feature scores perfectly: a
 * poller that has died spawns nothing, wakes nothing, and burns no CPU. So each
 * scenario also proves the subsystem still works — a real child process that
 * must be discovered, a file edit that must be detected — and emits that as a
 * `*Misses` metric. Read the pair, never the count alone.
 *
 * CPU time is the headline the doc asks for and the honest way to phrase "how
 * much does idle cost": `process.cpuUsage()` excludes scheduler preemption, so
 * it is far steadier than wall time on a shared machine. It is in-process only
 * — see `closeIdleWindow` — so it always travels next to a spawn count.
 *
 * Three readings from the first runs, recorded because they are the ones most
 * likely to be misread:
 *
 * - `backoffIntervalMs` sits at the 1500ms base every time. ProcessTreeCache
 *   only advances its backoff on an UNCHANGED pid set, and the probe is a new
 *   `ps` process on every poll that appears in its own census — so the set it
 *   compares can never match, and the adaptive ramp is effectively unreachable
 *   even on an otherwise silent machine. The spawn count is therefore a flat
 *   function of window length, not a decaying one.
 * - `faultCpuMs` runs well BELOW `healedCpuMs`: a blind poller still forks
 *   `ps` but has nothing to parse, so breaking detection is a CPU saving. It
 *   is the clearest example in this file of why no count or CPU figure here
 *   may be read without its paired `*Misses`.
 * - PERF-094's `idleGitSpawns: 0` is the stat-skip steady state INSIDE the
 *   120s full-status budget (StatPrecheck.FULL_STATUS_MAX_AGE_MS), which the
 *   warm cycle refreshes immediately before the window. It is a real reading of
 *   the cheap path and a real detector for a regression that forces passes, but
 *   it deliberately excludes the periodic full pass an hours-long idle would
 *   pay. Read it as "the poll loop stays off git", not as "idle costs nothing".
 */

// Long enough that a leaked poller running at the base cadence fires inside
// it, short enough not to double the scenario. It cannot see a poller parked
// at ProcessTreeCache's 15s backoff ceiling: this is a cheap partial check,
// not a proof of teardown.
const RESIDUAL_WINDOW_MS = 4_000;

// Equal-length fault and post-heal windows so the two spawn counts are a
// straight comparison rather than two differently-scaled numbers.
const FAULT_WINDOW_MS = 8_000;
const POST_HEAL_WINDOW_MS = 8_000;

// Must clear ProcessTreeCache's 15s backoff ceiling plus one full `ps` pass,
// or a healthy-but-quiet poller reports as a dead one.
const DISCOVERY_TIMEOUT_MS = 25_000;
const FIRST_REFRESH_TIMEOUT_MS = 20_000;
// One backed-off poll plus the `ps` pass it is waiting on.
const IN_FLIGHT_DRAIN_TIMEOUT_MS = 20_000;

// The "performance" resource profile's background worktree cadence
// (pollIntervalBackground: 5000) — the fastest the product ever polls a
// worktree that is not the active one, and therefore the honest worst case.
// This is the cadence for a worktree WITHOUT a watcher: the profile grants at
// most `backgroundGitWatcherCap` (20) background watchers, and everything past
// that budget falls back to this poll loop. A watched background monitor runs
// a 300s heartbeat instead and would be a different scenario.
const FLEET_POLL_INTERVAL_MS = 5_000;
const FLEET_POLL_INTERVAL_MAX_MS = 20_000;
const FLEET_MONITOR_COUNT = 20;
const FLEET_WARM_TIMEOUT_MS = 60_000;
// One backed-off poll interval plus a full status pass, with room for a
// 20-monitor queue drain behind it.
const FLEET_DETECTION_TIMEOUT_MS = 40_000;
const FLEET_SETTLE_TIMEOUT_MS = 10_000;

function failClosed(notes: string, metrics: Record<string, number>): ScenarioSample {
  return { durationMs: 0, metrics, notes };
}

/** Shared shape for the per-window readings so 092/093/094 stay comparable. */
function windowMetrics(prefix: string, reading: IdleWindowReading): Record<string, number> {
  return {
    [`${prefix}ProbeSpawns`]: processProbeSpawnCount(reading.byExecutable),
    [`${prefix}SubprocessSpawns`]: reading.subprocessSpawns,
    [`${prefix}CpuMs`]: reading.cpuMs,
  };
}

/**
 * Bring a freshly started ProcessTreeCache to a known-GOOD state.
 *
 * `refreshCount` alone is not that state: the service fires its callbacks from
 * a `finally`, so it counts failed polls too, and a machine whose `ps` is
 * already broken would sail past a callback-only check and turn every reading
 * below into a fault measurement wearing a healthy label.
 */
async function awaitHealthyRefresh(harness: ProcessTreeHarness): Promise<boolean> {
  return pollUntil(() => harness.isHealthy(), FIRST_REFRESH_TIMEOUT_MS, 25);
}

/**
 * Wait out whichever poll is in flight right now.
 *
 * A poll that started before the fault was installed resolves against a
 * healthy probe, and `ps` enumerates when it execs — late enough to list a
 * child spawned microseconds after the shim went in. The blindness reading
 * depends on the cache having had no chance to see the probe child, so the
 * child is only spawned once that poll has landed. Returns false when it never
 * did, which makes the blindness reading unsafe rather than merely slow.
 */
async function drainInFlightRefresh(harness: ProcessTreeHarness): Promise<boolean> {
  const before = harness.refreshCount();
  return pollUntil(() => harness.refreshCount() > before, IN_FLIGHT_DRAIN_TIMEOUT_MS, 25);
}

/**
 * Teardown reading. Taken inline rather than as its own scenario because the
 * spawn counter is process-global: a leaked poller would otherwise bleed into
 * whichever scenario the harness runs next. The probe child is killed AFTER
 * stop() so a leaked poller has something to react to.
 */
async function measureResidual(
  harness: ProcessTreeHarness,
  killProbeChild: () => void
): Promise<Record<string, number>> {
  harness.stop();
  const window = openIdleWindow();
  killProbeChild();
  await sleep(RESIDUAL_WINDOW_MS);
  const reading = closeIdleWindow(window);
  return {
    residualProbeSpawns: processProbeSpawnCount(reading.byExecutable),
    residualSubprocessSpawns: reading.subprocessSpawns,
  };
}

export const idleWindowScenarios: PerfScenario[] = [
  {
    id: "PERF-092",
    name: "Idle Process-Tree Poll Tax (healthy)",
    description:
      "A real ProcessTreeCache with a real subscriber, idling at the pty-host's own 1500ms cadence. Reports subprocess starts, refresh callbacks, in-process CPU time per idle second and event-loop utilization across a 15s window, paired with the discovery latency of a real child process spawned after the window closes.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    // The CPU figures are the reason this pays for a warmup it would otherwise
    // skip: the first measured window in a fresh process carries the JIT cost
    // of the `ps` parse, and a cold iteration lands in the `max` that the count
    // metrics are read by. Everything else here is wall-clock bounded and would
    // not need one.
    warmups: 1,
    iterations: { smoke: 2, ci: 3, nightly: 5 },
    correctness: ["discoveryMisses", "refreshMisses", "spawnObserverMisses"],
    async run() {
      const harness = await createProcessTreeHarness(PROCESS_TREE_POLL_INTERVAL_MS);
      let child: ProbeChild | null = null;
      const killChild = () => child?.kill();
      try {
        const started = await awaitHealthyRefresh(harness);
        if (!started) {
          return failClosed("the process-tree poller never completed a healthy refresh", {
            ...(await measureResidual(harness, killChild)),
            refreshMisses: 1,
            discoveryMisses: 1,
            spawnObserverMisses: spawnObserverMisses(),
          });
        }

        const refreshesBefore = harness.refreshCount();
        const window = openIdleWindow();
        await sleep(IDLE_WINDOW_MS);
        const reading = closeIdleWindow(window);
        const idleRefreshCallbacks = harness.refreshCount() - refreshesBefore;
        // Sampled here and not later: the probe child below is a new pid, which
        // makes the next poll's outcome "changed" and resets the backoff. Read
        // after the probe, this metric would report the base interval no matter
        // what the window actually settled at.
        const backoffIntervalMs = harness.cache.getCurrentIntervalMs();

        // Spawned only now, for two reasons: the spawn is itself a subprocess
        // start and must not land in the idle count it exists to validate, and
        // a process that already existed when the window opened would be found
        // by a cache that stopped polling the moment the window began.
        child = spawnProbeChild();
        const discoveryMs =
          child.pid === null
            ? null
            : await waitForProcessDiscovery(harness.cache, child.pid, DISCOVERY_TIMEOUT_MS);

        const residual = await measureResidual(harness, killChild);

        const metrics = {
          idleProbeSpawns: processProbeSpawnCount(reading.byExecutable),
          idleSubprocessSpawns: reading.subprocessSpawns,
          idleRefreshCallbacks,
          idleCpuMs: reading.cpuMs,
          cpuMsPerIdleSec: reading.cpuMsPerIdleSec,
          idleEluPct: reading.eluPct,
          backoffIntervalMs,
          discoveryMs: discoveryMs ?? DISCOVERY_TIMEOUT_MS,
          // The pair. A cache that never sees a live process is blind, and a
          // blind cache is the cheapest possible one — without this reading,
          // "zero spawns during idle" is indistinguishable from "detection is
          // dead" and the benchmark rewards the second.
          discoveryMisses: discoveryMs === null ? 1 : 0,
          refreshMisses: idleRefreshCallbacks === 0 ? 1 : 0,
          // The observer's own reading: every count above is a tally of Node
          // `child_process` starts, and a hook that stopped firing reports the
          // same zero a quiet machine does.
          spawnObserverMisses: reading.spawnObserverMisses,
          ...residual,
        };
        return {
          // Self-timed: the headline is a count and a CPU figure, not a duration.
          durationMs: 0,
          metrics,
          notes:
            metrics.discoveryMisses === 1
              ? "the idle window was cheap but the poller never saw a live child — a low count here is blindness, not efficiency"
              : undefined,
        };
      } finally {
        harness.stop();
        killChild();
      }
    },
  },
  {
    id: "PERF-093",
    name: "Idle Process-Tree Poll Tax (after a transient probe failure)",
    description:
      "The generalisable #12042 shape on the process-tree poller: the `ps`/`powershell` probe fails for 8s via a PATH shim, then heals. Reports the cost of idling while broken, the recovery latency, and whether the poller returned to the cheap path over an identical 8s window afterwards.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    warmups: 1,
    iterations: { smoke: 2, ci: 3, nightly: 5 },
    correctness: [
      "recoveryMisses",
      "postHealDiscoveryMisses",
      "preFaultRefreshMisses",
      "faultInjectionMisses",
      "faultStateMisses",
      "spawnObserverMisses",
    ],
    async run() {
      const harness = await createProcessTreeHarness(PROCESS_TREE_POLL_INTERVAL_MS);
      let fault: ProbeFaultHandle | null = null;
      let child: ProbeChild | null = null;
      const killChild = () => child?.kill();
      try {
        // The probe must be working BEFORE the shim goes in, or a machine where
        // `ps` is already unavailable produces a flawless-looking fault run
        // whose "healthy" baseline was never healthy.
        const healthyBaseline = (await awaitHealthyRefresh(harness)) && processProbeWorks();
        if (!healthyBaseline) {
          return failClosed("the process-tree poller never completed a healthy refresh", {
            ...(await measureResidual(harness, killChild)),
            preFaultRefreshMisses: 1,
            recoveryMisses: 1,
            postHealDiscoveryMisses: 1,
            faultInjectionMisses: 1,
            faultStateMisses: 1,
            spawnObserverMisses: spawnObserverMisses(),
          });
        }

        fault = installProcessProbeFault();
        const faultInjected = !processProbeWorks();
        const drained = await drainInFlightRefresh(harness);
        // Spawned while the probe is broken, so a cache that reports it has
        // not actually been faulted — the apparatus check that keeps every
        // number below honest.
        child = spawnProbeChild();

        const faultWindow = openIdleWindow();
        await sleep(FAULT_WINDOW_MS);
        const faultReading = closeIdleWindow(faultWindow);
        const faultBackoffIntervalMs = harness.cache.getCurrentIntervalMs();
        // Blindness alone would also be satisfied by a poller that simply
        // stopped, so it is read together with the service's OWN record of a
        // failing probe: something tried, and failed, inside this window.
        const wentBlind = child.pid === null || harness.cache.getProcess(child.pid) === undefined;
        const observedFailure = harness.hasObservedFailure();

        removeProcessProbeFault(fault);
        fault = null;
        const healed = processProbeWorks();

        // Measured before the post-heal window opens, so the polling this loop
        // does is not charged to the CPU figure it would otherwise inflate.
        const recoveryMs =
          child.pid === null
            ? null
            : await waitForProcessDiscovery(harness.cache, child.pid, DISCOVERY_TIMEOUT_MS);

        const healedWindow = openIdleWindow();
        await sleep(POST_HEAL_WINDOW_MS);
        const healedReading = closeIdleWindow(healedWindow);
        const healedBackoffIntervalMs = harness.cache.getCurrentIntervalMs();

        // A second probe, AFTER the healed window. `recoveryMisses` alone is
        // satisfied by a cache that recovered for exactly one poll and then
        // died — which would then report a beautifully cheap healed window.
        // This is the reading that makes those counts mean something.
        const postHealChild = spawnProbeChild();
        const postHealDiscoveryMs =
          postHealChild.pid === null
            ? null
            : await waitForProcessDiscovery(harness.cache, postHealChild.pid, DISCOVERY_TIMEOUT_MS);
        postHealChild.kill();

        const residual = await measureResidual(harness, killChild);

        const metrics = {
          ...windowMetrics("fault", faultReading),
          faultBackoffIntervalMs,
          ...windowMetrics("healed", healedReading),
          healedBackoffIntervalMs,
          cpuMsPerIdleSec: healedReading.cpuMsPerIdleSec,
          healedEluPct: healedReading.eluPct,
          recoveryMs: recoveryMs ?? DISCOVERY_TIMEOUT_MS,
          // The pair, on the side that matters: a poller that stayed broken
          // is silent and cheap forever.
          recoveryMisses: recoveryMs === null ? 1 : 0,
          postHealDiscoveryMs: postHealDiscoveryMs ?? DISCOVERY_TIMEOUT_MS,
          postHealDiscoveryMisses: postHealDiscoveryMs === null ? 1 : 0,
          preFaultRefreshMisses: 0,
          faultInjectionMisses: faultInjected && healed ? 0 : 1,
          faultStateMisses: wentBlind && observedFailure && drained ? 0 : 1,
          spawnObserverMisses: healedReading.spawnObserverMisses,
          ...residual,
        };

        if (!faultInjected || !healed || !wentBlind || !observedFailure || !drained) {
          return failClosed(
            "the probe fault was not reproduced (shim ineffective, PATH not healed, in-flight poll not drained, or the poller never recorded a failure) — every count here is invalid",
            metrics
          );
        }
        return {
          durationMs: 0,
          metrics,
          notes:
            metrics.recoveryMisses === 1 || metrics.postHealDiscoveryMisses === 1
              ? "the poller never recovered after the probe healed — its post-heal counts are a dead service, not a cheap one"
              : undefined,
        };
      } finally {
        if (fault) removeProcessProbeFault(fault);
        harness.stop();
        killChild();
      }
    },
  },
  {
    id: "PERF-094",
    name: "Idle Service Population Tax (20 poll-fallback worktree monitors + process tree)",
    description:
      "Twenty real watcher-less WorktreeMonitors — the poll-fallback population beyond the background watcher budget — at the performance profile's 5000ms background cadence, plus a real ProcessTreeCache, all idling together for 15s. Reports git and total subprocess starts, snapshot emits, refresh callbacks and CPU time per idle second across the population, paired with per-monitor poll-tick liveness, a staged file change that must still be detected, and a child process that must still be discovered.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    warmups: 1,
    iterations: { smoke: 2, ci: 3, nightly: 5 },
    correctness: [
      "detectionMisses",
      "discoveryMisses",
      "pollTickMisses",
      "warmMisses",
      "populationMisses",
      "settleMisses",
      "spawnObserverMisses",
    ],
    async run() {
      const fixture = getGitPipelineFixture();
      const { PQueue } = await loadPipelineModules();
      // The top of the scaling range: PERF-101 measures its curve at N=1/5/20,
      // so leaving the low indices untouched keeps this scenario's edits out of
      // the worktrees those points read.
      const firstIndex = Math.max(0, fixture.scalingPaths.length - FLEET_MONITOR_COUNT);
      const paths = fixture.scalingPaths.slice(firstIndex);
      const recorder = new EmitRecorder();
      const queue: PQueueType = new PQueue({ concurrency: 3 });
      const monitors: WorktreeMonitor[] = [];
      const harness = await createProcessTreeHarness(PROCESS_TREE_POLL_INTERVAL_MS);
      let child: ProbeChild | null = null;
      const killChild = () => child?.kill();
      const probeName = `idle-pop-probe-${uid()}.txt`;
      const editTarget = paths[0];
      const probeFile = join(editTarget, probeName);

      try {
        for (let i = 0; i < paths.length; i++) {
          const monitor = await createMonitorHarness(
            paths[i],
            `wt-branch-${firstIndex + i}`,
            {
              basePollingInterval: FLEET_POLL_INTERVAL_MS,
              pollIntervalMax: FLEET_POLL_INTERVAL_MAX_MS,
              onUpdate: (snapshot) => recorder.record(snapshot),
            },
            queue
          );
          monitor.startWithoutGitStatus();
          monitors.push(monitor);
        }

        // Warm every monitor's stat baseline, or the first self-scheduled poll
        // inside the window runs a full status pass and the idle reading is a
        // cold-start reading wearing an idle label. `allSettled` is right for
        // fidelity and wrong for measurement if left silent, so rejections are
        // counted: a monitor whose warm threw is cold, and a cold monitor is
        // one this window is not actually measuring.
        const warmed = await Promise.race([
          Promise.allSettled(monitors.map((monitor) => queue.add(() => monitor.refresh()))),
          sleep(FLEET_WARM_TIMEOUT_MS).then(() => null),
        ]);
        const warmRejections = warmed
          ? warmed.filter((result) => result.status === "rejected").length
          : monitors.length;
        for (const monitor of monitors) monitor.reschedulePolling();

        const quiet = await quiesceGitSpawns(PIPELINE_QUIESCE_SETTLE_MS, FLEET_SETTLE_TIMEOUT_MS);
        const refreshesBefore = harness.refreshCount();
        const emitsBefore = recorder.cursor();
        // Per-monitor poll liveness. StatPrecheck stamps `baselineAt` on every
        // successful stat-skip, so this advances once per poll tick even though
        // a skipped poll spawns nothing and emits nothing — the only signal
        // that all twenty timers ran. Without it, nineteen dead monitors and
        // one live one report exactly the same numbers as a healthy fleet, and
        // the staged-change probe below only ever exercises one of them.
        const baselinesBefore = monitors.map((monitor) => monitor.lastStatBaselineAt);

        const window = openIdleWindow();
        await sleep(IDLE_WINDOW_MS);
        const reading = closeIdleWindow(window);

        const pollTickMisses = monitors.filter(
          (monitor, i) => monitor.lastStatBaselineAt <= baselinesBefore[i]
        ).length;
        const idleSnapshotEvents = recorder.cursor() - emitsBefore;
        const idleRefreshCallbacks = harness.refreshCount() - refreshesBefore;

        // Both correctness probes, after the counted window: a change the
        // polling fleet must still notice, and a live process the cache must
        // still find. Twenty dead monitors and a blind cache produce the
        // cheapest idle window this scenario can report.
        writeEditFile(editTarget, probeName);
        const from = recorder.cursor();
        const editedAt = performance.now();
        stageProbeFile(editTarget, probeName);
        const emit = await recorder.waitFor(
          (snapshot) =>
            (snapshot.worktreeChanges?.changes ?? []).some(
              (change) => basename(change.path) === probeName
            ),
          FLEET_DETECTION_TIMEOUT_MS,
          from
        );
        child = spawnProbeChild();
        const discoveryMs =
          child.pid === null
            ? null
            : await waitForProcessDiscovery(harness.cache, child.pid, DISCOVERY_TIMEOUT_MS);

        const metrics = {
          monitorCount: monitors.length,
          idleGitSpawns: reading.gitSpawns,
          idleProbeSpawns: processProbeSpawnCount(reading.byExecutable),
          idleSubprocessSpawns: reading.subprocessSpawns,
          idleSnapshotEvents,
          idleRefreshCallbacks,
          idleCpuMs: reading.cpuMs,
          cpuMsPerIdleSec: reading.cpuMsPerIdleSec,
          idleEluPct: reading.eluPct,
          // The scaling shape: git cost attributable to one idle worktree over
          // this window, so the number survives a change to the fleet size.
          gitSpawnsPerMonitor: monitors.length > 0 ? reading.gitSpawns / monitors.length : 0,
          // Monitors that did not take a single poll tick inside the window.
          // The population-wide half of the pair; `detectionMisses` below only
          // ever speaks for `editTarget`'s monitor.
          pollTickMisses,
          detectionMs: emit ? emit.atMs - editedAt : FLEET_DETECTION_TIMEOUT_MS,
          detectionMisses: emit ? 0 : 1,
          discoveryMs: discoveryMs ?? DISCOVERY_TIMEOUT_MS,
          discoveryMisses: discoveryMs === null ? 1 : 0,
          // A warm cycle that never finished, or a refresh that threw, leaves
          // that monitor cold — so the window above is over a smaller
          // population than `monitorCount` claims.
          warmMisses: warmRejections,
          populationMisses: monitors.length === FLEET_MONITOR_COUNT ? 0 : 1,
          settleMisses: quiet ? 0 : 1,
          spawnObserverMisses: reading.spawnObserverMisses,
        };

        for (const monitor of monitors) monitor.stop();
        unstageProbeFile(editTarget, probeName);
        const residualWindow = openIdleWindow();
        removeFileQuietly(probeFile);
        harness.stop();
        killChild();
        await sleep(RESIDUAL_WINDOW_MS);
        const residual = closeIdleWindow(residualWindow);

        const withResidual = {
          ...metrics,
          residualGitSpawns: residual.gitSpawns,
          residualSubprocessSpawns: residual.subprocessSpawns,
        };
        if (warmed === null || warmRejections > 0 || !quiet) {
          return failClosed(
            "the fleet never reached a warm, quiet baseline — the idle counts below are a settling system",
            withResidual
          );
        }
        return {
          durationMs: 0,
          metrics: withResidual,
          notes:
            withResidual.detectionMisses === 1 ||
            withResidual.discoveryMisses === 1 ||
            withResidual.pollTickMisses > 0
              ? "an idle subsystem stopped reacting — read the low counts as a dead population, not a cheap one"
              : undefined,
        };
      } finally {
        for (const monitor of monitors) monitor.stop();
        harness.stop();
        killChild();
        unstageProbeFile(editTarget, probeName);
        removeFileQuietly(probeFile);
        queue.clear();
      }
    },
  },
];
