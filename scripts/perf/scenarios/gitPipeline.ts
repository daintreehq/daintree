import { basename, join } from "node:path";
import type { PerfScenario, ScenarioSample } from "../types";
import type PQueueType from "p-queue";
import type { WorktreeMonitor } from "../../../electron/workspace-host/WorktreeMonitor";
import {
  SCALING_WORKTREE_COUNTS,
  allSpawnMark,
  allSpawnsSince,
  checkoutStormBranch,
  clearCachedGitDir,
  createMonitorHarness,
  getGitPipelineFixture,
  gitSpawnMark,
  gitSpawnsSince,
  loadPipelineModules,
  nonGitSpawnCount,
  sleep,
  withGitDirProbeFault,
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

/**
 * Git pipeline scenarios (PERF-100..106): the always-on workspace-host git
 * cost — status poll cycles, subprocess spawn counts, the stat-skip fast
 * path, watcher-storm recovery, and the idle spawn rate with and without a
 * transient git-dir probe failure — measured against the real
 * WorktreeMonitor + shared PQueue(3) pipeline on a synthetic repo with up to
 * 50 linked worktrees.
 *
 * Steady-state spawn-rate model (for interpreting the metrics): a background
 * worktree without a watcher stat-checks every ~10-30s (0 spawns on the skip
 * path) and runs a full pass at most every FULL_STATUS_MAX_AGE_MS (120s);
 * git-only watcher worktrees poll at 300s where every pass is full. So
 * spawns/min at N worktrees ≈ N × fullPassSpawns × (60/120..60/300). The
 * spawn metrics here (gitSpawns per pass, quiet-tick spawns) are the factors
 * of that product — driving them down or keeping them at zero is what the
 * budgets guard.
 *
 * All fixture setup is lazy (first run()/warmup) so importing this module —
 * e.g. from scenarioMatrix tests or perf modes that exclude these scenarios —
 * never builds repos or patches child_process.
 */

const POLL_QUEUE_TASK_TIMEOUT_MS = 60_000;
const STORM_SETTLE_MS = 2_000;
const STORM_TIMEOUT_MS = 20_000;
const WARM_STALENESS_MS = 60_000;

// --- Idle spawn-rate scenarios (PERF-105/106) --------------------------------

const IDLE_WINDOW_MS = 10_000;
// #12042's own cadence: the "Performance" resource profile's 1500ms adaptive
// base, the shortest interval the product ever falls back to. It is what makes
// a watcher that has gone dark loud inside a 10s window (several full status
// passes) while a healthy watcher's 300s heartbeat contributes none. Leaving
// createMonitorHarness's 1h default in place here would report a perfect zero
// for both the healthy and the broken monitor — measuring nothing.
const IDLE_BASE_POLL_INTERVAL_MS = 1_500;
const IDLE_POLL_INTERVAL_MAX_MS = 30_000;
const IDLE_ARM_TIMEOUT_MS = 8_000;
// The faulted monitor never goes quiet by construction, so the pre-window
// settle has to be bounded rather than waiting out real silence.
const IDLE_SETTLE_TIMEOUT_MS = 3_000;
const IDLE_DETECTION_TIMEOUT_MS = 15_000;
// Wider than the base poll interval plus its 20% jitter, so a leaked polling
// timer has to fire inside the window rather than slipping past its end.
const IDLE_CLEANUP_WINDOW_MS = 2_000;

function failClosed(notes: string, metrics: Record<string, number>): ScenarioSample {
  return { durationMs: 0, metrics, notes };
}

/**
 * The idle window and its PAIRED correctness reading, measured identically
 * for the healthy and the faulted monitor so the two counts are comparable.
 *
 * A spawn count on its own is a trap. A watcher that has gone permanently
 * dark and stopped polling spawns nothing at all and scores a perfect zero —
 * a count-only benchmark rewards breaking change detection outright. So every
 * reading here carries `detectionMisses`: a file written at the END of the
 * idle window must still reach a snapshot emit. Read the two together, or not
 * at all.
 */
async function measureIdleWindow(
  monitor: WorktreeMonitor,
  recorder: EmitRecorder,
  worktreePath: string,
  probeName: string
): Promise<Record<string, number>> {
  await quiesceGitSpawns(PIPELINE_QUIESCE_SETTLE_MS, IDLE_SETTLE_TIMEOUT_MS);

  const gitMark = gitSpawnMark();
  const allMark = allSpawnMark();
  await sleep(IDLE_WINDOW_MS);
  const gitWindow = gitSpawnsSince(gitMark);
  const allWindow = allSpawnsSince(allMark);

  const from = recorder.cursor();
  const editedAt = performance.now();
  writeEditFile(worktreePath, probeName);
  const emit = await recorder.waitFor(
    (snapshot) =>
      (snapshot.worktreeChanges?.changes ?? []).some(
        (change) => basename(change.path) === probeName
      ),
    IDLE_DETECTION_TIMEOUT_MS,
    from
  );

  return {
    idleGitSpawns: gitWindow.count,
    idleStatusPasses: gitWindow.bySubcommand["status"] ?? 0,
    idleNonGitSpawns: nonGitSpawnCount(allWindow),
    detectionMs: emit ? emit.atMs - editedAt : IDLE_DETECTION_TIMEOUT_MS,
    detectionMisses: emit ? 0 : 1,
    // Inverted so the max-ceiling budget model can gate it: 0 means a watcher
    // is armed. Only observable at monitor granularity — `hasArmedWatcher`
    // does not distinguish the recursive watcher from the git-only fallback,
    // and the recursive arm's native subscription resolves after it flips.
    watcherArmMisses: monitor.hasArmedWatcher ? 0 : 1,
  };
}

/**
 * Teardown reading, taken inline rather than as its own scenario: the spawn
 * counter is process-global, so a leaked monitor bleeds into every scenario
 * that runs after this one. The probe file is removed AFTER `stop()` on
 * purpose — a leaked watcher or poll timer reacts to the removal, so a leak
 * shows up as residual subprocess activity. Deliberately NOT reading
 * `monitor.hasWatcher` here: `stop()` clears the controller's state
 * synchronously, so that flag reads false whether or not a native handle
 * survived. Observed behaviour after teardown is the only honest evidence.
 */
async function measureCleanup(
  monitor: WorktreeMonitor,
  probeFile: string
): Promise<Record<string, number>> {
  monitor.stop();
  const gitMark = gitSpawnMark();
  const allMark = allSpawnMark();
  removeFileQuietly(probeFile);
  await sleep(IDLE_CLEANUP_WINDOW_MS);
  return {
    residualGitSpawns: gitSpawnsSince(gitMark).count,
    residualNonGitSpawns: nonGitSpawnCount(allSpawnsSince(allMark)),
  };
}

interface ScalingHarness {
  monitors: WorktreeMonitor[];
  queue: PQueueType;
  warmedAt: number;
}

let scalingHarness: ScalingHarness | null = null;
let soloMonitor: WorktreeMonitor | null = null;
let dirtyMonitor: WorktreeMonitor | null = null;
let stormFlip = 0;

async function getScalingHarness(): Promise<ScalingHarness> {
  if (scalingHarness) return scalingHarness;
  const fixture = getGitPipelineFixture();
  const { PQueue } = await loadPipelineModules();
  const queue = new PQueue({ concurrency: 3, timeout: POLL_QUEUE_TASK_TIMEOUT_MS });
  const monitors: WorktreeMonitor[] = [];
  for (let i = 0; i < fixture.scalingPaths.length; i++) {
    const monitor = await createMonitorHarness(
      fixture.scalingPaths[i],
      `wt-branch-${i}`,
      {},
      queue
    );
    monitor.startWithoutGitStatus();
    monitors.push(monitor);
  }
  scalingHarness = { monitors, queue, warmedAt: 0 };
  return scalingHarness;
}

async function runRefreshCycle(
  harness: ScalingHarness,
  count: number
): Promise<{ durationMs: number; rejected: number }> {
  const targets = harness.monitors.slice(0, count);
  const start = performance.now();
  // Mirrors WorkspaceService.refreshAll: each refresh takes a shared
  // pollQueue slot; allSettled so one bad worktree can't abort the cycle.
  const settled = await Promise.allSettled(
    targets.map((monitor) => harness.queue.add(() => monitor.refresh()))
  );
  const rejected = settled.filter((result) => result.status === "rejected").length;
  // `allSettled` is right for fidelity and wrong for measurement if left
  // silent: a cycle where 10 of 50 refreshes threw completes FASTER and reports
  // that as an improvement. The caller turns this into a metric so the
  // denominator is visible rather than assumed.
  return { durationMs: performance.now() - start, rejected };
}

async function ensureWarm(harness: ScalingHarness): Promise<void> {
  if (performance.now() - harness.warmedAt < WARM_STALENESS_MS && harness.warmedAt !== 0) {
    return;
  }
  await runRefreshCycle(harness, harness.monitors.length);
  harness.warmedAt = performance.now();
}

export const gitPipelineScenarios: PerfScenario[] = [
  {
    id: "PERF-100",
    name: "Git Full Status Pass (single worktree)",
    description:
      "Forced full git-status pass (WorktreeMonitor.refresh) on one clean worktree with warm caches.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 30 },
    warmups: 1,
    async run() {
      const fixture = getGitPipelineFixture();
      if (!soloMonitor) {
        soloMonitor = await createMonitorHarness(fixture.soloPath, "wt-solo-branch");
        soloMonitor.startWithoutGitStatus();
      }
      const mark = gitSpawnMark();
      const start = performance.now();
      await soloMonitor.refresh();
      const durationMs = performance.now() - start;
      return {
        durationMs,
        metrics: { gitSpawns: gitSpawnsSince(mark).count },
      };
    },
  },
  {
    id: "PERF-101",
    name: "Git Poll Cycle Scaling (1/5/20/50 worktrees)",
    description:
      "Full forced refresh cycle (refreshAll-equivalent, shared PQueue concurrency 3) across 1, 5, 20, and 50 worktrees.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 8, nightly: 12 },
    warmups: 1,
    async run() {
      const harness = await getScalingHarness();
      const cycleMs: number[] = [];
      let spawnsAt50 = 0;
      let refreshMisses = 0;
      for (const count of SCALING_WORKTREE_COUNTS) {
        const mark = gitSpawnMark();
        const cycle = await runRefreshCycle(harness, count);
        cycleMs.push(cycle.durationMs);
        refreshMisses += cycle.rejected;
        if (count === 50) {
          spawnsAt50 = gitSpawnsSince(mark).count;
        }
      }
      harness.warmedAt = performance.now();
      return {
        durationMs: cycleMs[cycleMs.length - 1],
        metrics: {
          cycleMsN1: cycleMs[0],
          cycleMsN5: cycleMs[1],
          cycleMsN20: cycleMs[2],
          cycleMsN50: cycleMs[3],
          spawnsPerWorktreeN50: spawnsAt50 / 50,
          // A refresh that threw is a worktree this cycle did not actually do,
          // so every duration above is over a smaller denominator than its
          // label claims — and a shrinking denominator reads as a speedup.
          refreshMisses,
        },
      };
    },
  },
  {
    id: "PERF-102",
    name: "Git Quiet Tick Sweep (50 worktrees, stat-skip)",
    description:
      "Non-forced poll tick across 50 warm worktrees — the steady-state quiet path; should skip git entirely via the stat baseline.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 30 },
    warmups: 1,
    async run() {
      const harness = await getScalingHarness();
      await ensureWarm(harness);
      const mark = gitSpawnMark();
      const start = performance.now();
      await Promise.allSettled(
        harness.monitors.map((monitor) => harness.queue.add(() => monitor.updateGitStatus(false)))
      );
      const durationMs = performance.now() - start;
      return {
        durationMs,
        metrics: { gitSpawns: gitSpawnsSince(mark).count },
      };
    },
  },
  {
    id: "PERF-103",
    name: "Git Full Status Pass (dirty worktree)",
    description:
      "Forced full pass on a worktree with 40 modified + 12 untracked files (numstat + line-count paths, warm per-file cache).",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 30 },
    warmups: 1,
    async run() {
      const fixture = getGitPipelineFixture();
      if (!dirtyMonitor) {
        dirtyMonitor = await createMonitorHarness(fixture.dirtyPath, "wt-dirty-branch");
        dirtyMonitor.startWithoutGitStatus();
      }
      const mark = gitSpawnMark();
      const start = performance.now();
      await dirtyMonitor.refresh();
      const durationMs = performance.now() - start;
      return {
        durationMs,
        metrics: { gitSpawns: gitSpawnsSince(mark).count },
      };
    },
  },
  {
    id: "PERF-104",
    name: "Git Watcher Storm Time-to-Quiescent",
    description:
      "External branch checkout flooding the recursive file watcher; time from checkout completion until git activity settles.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 6, nightly: 8 },
    warmups: 1,
    async run() {
      const fixture = getGitPipelineFixture();
      // Fresh monitor per iteration, stopped in the finally: the recursive
      // parcel watcher is a live native handle, and leaking it would distort
      // any scenario running after this one in the same harness process.
      const monitor = await createMonitorHarness(fixture.stormPath, "storm-base", {
        isCurrent: true,
        gitWatchEnabled: true,
      });
      try {
        await monitor.start();
        // The recursive parcel-watcher subscription arms asynchronously;
        // give it a moment so the storm doesn't race the arm.
        await sleep(500);

        const target = fixture.stormBranches[stormFlip % 2];
        stormFlip += 1;

        const mark = gitSpawnMark();
        checkoutStormBranch(target);
        const checkoutDoneAt = performance.now();

        let window = gitSpawnsSince(mark);
        const deadline = checkoutDoneAt + STORM_TIMEOUT_MS;
        // Quiescent = at least one pipeline reaction observed AND no git spawn
        // for STORM_SETTLE_MS (longer than any debounce/cooldown chain).
        while (performance.now() < deadline) {
          await sleep(50);
          window = gitSpawnsSince(mark);
          if (window.lastAtMs !== null && performance.now() - window.lastAtMs > STORM_SETTLE_MS) {
            break;
          }
        }

        if (window.lastAtMs === null) {
          // Fail closed: a watcher that never reacted must not read as a
          // perfect zero-cost sample. The deadline blows the p95 budget.
          return {
            durationMs: STORM_TIMEOUT_MS,
            metrics: { gitSpawns: 0, statusPasses: 0 },
            notes: "no pipeline reaction observed before the storm deadline",
          };
        }

        return {
          durationMs: Math.max(0, window.lastAtMs - checkoutDoneAt),
          metrics: {
            gitSpawns: window.count,
            statusPasses: window.bySubcommand["status"] ?? 0,
          },
        };
      } finally {
        monitor.stop();
      }
    },
  },
  {
    id: "PERF-105",
    name: "Git Idle Spawn Rate (healthy watcher)",
    description:
      "Git and non-git subprocess starts over a 10s idle window on an armed, recursively watched worktree, paired with the detection latency of an edit made at the end of that window.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 2, ci: 3, nightly: 5 },
    warmups: 1,
    async run() {
      const fixture = getGitPipelineFixture();
      const recorder = new EmitRecorder();
      const monitor = await createMonitorHarness(fixture.idlePath, "wt-idle-branch", {
        isCurrent: true,
        gitWatchEnabled: true,
        basePollingInterval: IDLE_BASE_POLL_INTERVAL_MS,
        pollIntervalMax: IDLE_POLL_INTERVAL_MAX_MS,
        onUpdate: (snapshot) => recorder.record(snapshot),
      });
      const probeName = `idle-probe-${uid()}.txt`;
      const probeFile = join(fixture.idlePath, probeName);
      try {
        monitor.startWithoutGitStatus();
        const armed = await pollUntil(() => monitor.hasArmedWatcher, IDLE_ARM_TIMEOUT_MS);
        await monitor.refresh();
        // startWithoutGitStatus() schedules the first poll while the arm is
        // still in flight, when the controller reports its target mode
        // optimistically. Re-derive the cadence from the mode that actually
        // resolved — the ordering the real elevated start() produces.
        monitor.reschedulePolling();

        if (!armed) {
          // Not a fast healthy monitor: an unarmed watcher makes the idle
          // count meaningless, so refuse to report it as a good number.
          return failClosed("watcher never armed — idle reading is not a healthy baseline", {
            ...(await measureCleanup(monitor, probeFile)),
            watcherArmMisses: 1,
            detectionMisses: 1,
          });
        }

        const idle = await measureIdleWindow(monitor, recorder, fixture.idlePath, probeName);
        const cleanup = await measureCleanup(monitor, probeFile);
        return {
          // Self-timed: the headline number is a count, not a duration.
          durationMs: 0,
          metrics: { ...idle, ...cleanup },
          notes:
            idle.detectionMisses === 1
              ? "idle window was quiet but the paired edit was never detected"
              : undefined,
        };
      } finally {
        monitor.stop();
        removeFileQuietly(probeFile);
      }
    },
  },
  {
    id: "PERF-106",
    name: "Git Idle Spawn Rate (after a transient git-dir probe failure)",
    description:
      "The #12042 shape: one transient git-dir probe failure while the watcher arms, then a healthy repo. Reports whether the watcher recovered (watcherArmMisses 0), whether an edit was still detected, and how much git ran during a 10s idle window.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 2, ci: 3, nightly: 5 },
    warmups: 1,
    async run() {
      const fixture = getGitPipelineFixture();
      const recorder = new EmitRecorder();
      const monitor = await createMonitorHarness(fixture.faultPath, "wt-fault-branch", {
        isCurrent: true,
        gitWatchEnabled: true,
        basePollingInterval: IDLE_BASE_POLL_INTERVAL_MS,
        pollIntervalMax: IDLE_POLL_INTERVAL_MAX_MS,
        onUpdate: (snapshot) => recorder.record(snapshot),
      });
      const probeName = `idle-probe-${uid()}.txt`;
      const probeFile = join(fixture.faultPath, probeName);
      try {
        // Arm the watcher WHILE the probe is failing, so whatever ends up in
        // the git-dir cache is put there by the product's own getGitDir call.
        // The repo is healthy again the moment this resolves.
        const { result: wentDark, injected } = await withGitDirProbeFault(
          fixture.faultPath,
          async () => {
            monitor.startWithoutGitStatus();
            // hasWatcher stays optimistically true while an arm is in flight,
            // and a failed recursive arm immediately starts a git-only one, so
            // it only reads false once BOTH have failed — the dark state.
            return pollUntil(() => !monitor.hasWatcher, IDLE_ARM_TIMEOUT_MS);
          }
        );

        // refresh() resets the recursive retry budget and re-arms, so this is
        // also the product's first recovery attempt against the healed repo.
        // Wait for that arm to resolve before deriving the poll cadence:
        // reading it mid-arm picks up the optimistic 300s watcher heartbeat
        // and reports the runaway as silence.
        await monitor.refresh();
        const armSettled = await pollUntil(
          () => !monitor.hasWatcher || monitor.hasArmedWatcher,
          IDLE_ARM_TIMEOUT_MS
        );
        monitor.reschedulePolling();

        const idle = await measureIdleWindow(monitor, recorder, fixture.faultPath, probeName);
        const cleanup = await measureCleanup(monitor, probeFile);
        const metrics = {
          ...idle,
          ...cleanup,
          faultInjectionMisses: injected ? 0 : 1,
          // Both waits timing out means the watcher lifecycle never settled,
          // so the poll cadence measured below is whatever happened to be
          // armed at the time — not a reading of the fault state.
          faultStateMisses: wentDark && armSettled ? 0 : 1,
        };
        if (!injected || !wentDark || !armSettled) {
          return failClosed(
            "the #12042 fault state was not reproduced — every count here is invalid",
            metrics
          );
        }
        return {
          durationMs: 0,
          metrics,
          notes:
            idle.detectionMisses === 1
              ? "the faulted worktree stopped detecting edits entirely — a zero spawn count here is a dead watcher, not a fix"
              : undefined,
        };
      } finally {
        monitor.stop();
        removeFileQuietly(probeFile);
        // Leave the cache clean so the next iteration injects its own fault
        // rather than inheriting this one's 600s-TTL null.
        await clearCachedGitDir(fixture.faultPath);
      }
    },
  },
];
