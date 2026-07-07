import type { PerfScenario } from "../types";
import type PQueueType from "p-queue";
import type { WorktreeMonitor } from "../../../electron/workspace-host/WorktreeMonitor";
import {
  SCALING_WORKTREE_COUNTS,
  checkoutStormBranch,
  createMonitorHarness,
  getGitPipelineFixture,
  gitSpawnMark,
  gitSpawnsSince,
  loadPipelineModules,
  sleep,
} from "../lib/gitPipelineFixture";

/**
 * Git pipeline scenarios (PERF-100..104): the always-on workspace-host git
 * cost — status poll cycles, subprocess spawn counts, the stat-skip fast
 * path, and watcher-storm recovery — measured against the real
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

async function runRefreshCycle(harness: ScalingHarness, count: number): Promise<number> {
  const targets = harness.monitors.slice(0, count);
  const start = performance.now();
  // Mirrors WorkspaceService.refreshAll: each refresh takes a shared
  // pollQueue slot; allSettled so one bad worktree can't abort the cycle.
  await Promise.allSettled(targets.map((monitor) => harness.queue.add(() => monitor.refresh())));
  return performance.now() - start;
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
      for (const count of SCALING_WORKTREE_COUNTS) {
        const mark = gitSpawnMark();
        const elapsed = await runRefreshCycle(harness, count);
        cycleMs.push(elapsed);
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
];
