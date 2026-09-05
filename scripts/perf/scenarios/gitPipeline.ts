import { basename, join } from "node:path";
import type { PerfScenario, ScenarioSample } from "../types";
import type PQueueType from "p-queue";
import type { WorktreeMonitor } from "../../../electron/workspace-host/WorktreeMonitor";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  IGNORED_BURST_DIR,
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
  spawnObserverMisses,
  withGitDirProbeFault,
} from "../lib/gitPipelineFixture";
import {
  EmitRecorder,
  PIPELINE_QUIESCE_SETTLE_MS,
  pollUntil,
  quiesceGitSpawns,
  removeFileQuietly,
  snapshotChangedFileCount,
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
// The dirty fixture's standing modification set (gitPipelineFixture's
// DIRTY_MODIFIED_FILES). A floor rather than an equality: whether the twelve
// untracked files land in the same tally is the status pass's business, and
// pinning that here would make a reporting choice look like a regression.
const DIRTY_MIN_CHANGED_FILES = 40;
const STORM_SETTLE_MS = 2_000;
const STORM_TIMEOUT_MS = 20_000;
const WARM_STALENESS_MS = 60_000;

// --- Ignored-burst classification (PERF-107) ---------------------------------

/** Files written into the gitignored directory per burst. */
const IGNORED_BURST_FILES = 40;
/** How long one arm waits for its flush to surface and settle. Deliberately
 *  tight: the scenarioLiveness guard DRIVES this scenario, and three arms each
 *  waiting out a long deadline on a machine whose watcher never armed would
 *  push a single run() past the ~12s the guard's cost exclusions are drawn at. */
const BURST_FLUSH_TIMEOUT_MS = 6_000;
const BURST_SETTLE_MS = 1_200;
/** Mirrors WORKTREE_CLASSIFY_TIMEOUT_MS in gitFileWatcher.ts. */
const WORKTREE_CLASSIFY_DEADLINE_MS = 2_000;

/**
 * Count of distinct file-browser notifications in a window.
 *
 * `WorktreeMonitor.handleWorktreeFilesChanged` bumps `workingTreeChangedAt` and
 * emits, so DISTINCT values of that stamp count raw-filesystem signals. Total
 * emits would not: a status pass emits too, which is exactly the thing this
 * scenario is trying to prove did NOT happen.
 */
function browserSignals(recorder: EmitRecorder, from: number, since: number): number {
  const stamps = new Set<number>();
  for (const emit of recorder.emits.slice(from)) {
    const at = emit.snapshot.workingTreeChangedAt;
    // Strictly newer than the window's baseline, not merely present: a
    // status-only emit landing after the cursor still carries the PREVIOUS
    // flush's stamp, and counting it would invent a flush that never happened
    // and halve the reported per-flush cost. The stamp is strictly increasing
    // (WorktreeMonitor bumps it with Math.max(now, prev + 1)), so ">" is exact.
    if (typeof at === "number" && at > since) stamps.add(at);
  }
  return stamps.size;
}

/** The newest file-browser stamp the recorder has seen, or 0. */
function latestBrowserStamp(recorder: EmitRecorder): number {
  let latest = 0;
  for (const emit of recorder.emits) {
    const at = emit.snapshot.workingTreeChangedAt;
    if (typeof at === "number" && at > latest) latest = at;
  }
  return latest;
}

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

function statusCheckedAt(monitor: WorktreeMonitor): number {
  return monitor.getSnapshot().lastGitStatusCheckedAt ?? 0;
}

/**
 * Did a forced pass actually produce git state? 0 when it did.
 *
 * Read off the monitor's own snapshot and never off the spawn counter: a
 * `gitSpawns` figure cannot tell a refresh that did nothing apart from an
 * observer that saw nothing, and both report the same improved duration.
 * `lastGitStatusCheckedAt` only advances when a pass completes, and
 * `worktreeChanges` is the object that pass builds — a no-op `refresh()`
 * leaves both untouched and scores 2.
 */
function statusPassMisses(monitor: WorktreeMonitor, checkedBefore: number): number {
  const snapshot = monitor.getSnapshot();
  return (
    ((snapshot.lastGitStatusCheckedAt ?? 0) > checkedBefore ? 0 : 1) +
    (snapshot.worktreeChanges ? 0 : 1)
  );
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
): Promise<{ durationMs: number; misses: number }> {
  const targets = harness.monitors.slice(0, count);
  const checkedBefore = targets.map(statusCheckedAt);
  const start = performance.now();
  // Mirrors WorkspaceService.refreshAll: each refresh takes a shared
  // pollQueue slot; allSettled so one bad worktree can't abort the cycle.
  const settled = await Promise.allSettled(
    targets.map((monitor) => harness.queue.add(() => monitor.refresh()))
  );
  const durationMs = performance.now() - start;
  // `allSettled` is right for fidelity and wrong for measurement if left
  // silent: a cycle where 10 of 50 refreshes threw completes FASTER and
  // reports that as an improvement. Counting REJECTIONS alone is not enough
  // either — fifty fulfilled no-ops reject nothing, spawn nothing and post an
  // excellent latency. So every target is checked against its own pre-cycle
  // freshness stamp: a worktree whose stamp did not advance is one this cycle
  // did not actually do, however cleanly its promise resolved.
  let misses = 0;
  for (let i = 0; i < targets.length; i++) {
    if (settled[i].status === "rejected") {
      misses += 1;
      continue;
    }
    if (statusCheckedAt(targets[i]) <= checkedBefore[i]) misses += 1;
  }
  return { durationMs, misses };
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
    correctness: ["statusPassMisses", "spawnObserverMisses"],
    async run() {
      const fixture = getGitPipelineFixture();
      if (!soloMonitor) {
        soloMonitor = await createMonitorHarness(fixture.soloPath, "wt-solo-branch");
        soloMonitor.startWithoutGitStatus();
      }
      // Before the mark: the probe starts a child of its own.
      const observerMisses = spawnObserverMisses();
      const checkedBefore = statusCheckedAt(soloMonitor);
      const mark = gitSpawnMark();
      const start = performance.now();
      await soloMonitor.refresh();
      const durationMs = performance.now() - start;
      return {
        durationMs,
        metrics: {
          gitSpawns: gitSpawnsSince(mark).count,
          // A `refresh()` that returned without doing anything spawns nothing
          // and finishes instantly — the best duration and the best count this
          // scenario can record. This is what stops that reading as a win.
          statusPassMisses: statusPassMisses(soloMonitor, checkedBefore),
          spawnObserverMisses: observerMisses,
        },
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
    correctness: ["refreshMisses", "spawnObserverMisses"],
    async run() {
      const harness = await getScalingHarness();
      const observerMisses = spawnObserverMisses();
      const cycleMs: number[] = [];
      let spawnsAt50 = 0;
      let refreshMisses = 0;
      for (const count of SCALING_WORKTREE_COUNTS) {
        const mark = gitSpawnMark();
        const cycle = await runRefreshCycle(harness, count);
        cycleMs.push(cycle.durationMs);
        refreshMisses += cycle.misses;
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
          // Worktrees this cycle did not actually refresh — whether the promise
          // rejected or fulfilled without moving the worktree's freshness
          // stamp. Every duration above is over a denominator this many
          // worktrees short of its label, and a shrinking denominator reads as
          // a speedup.
          refreshMisses,
          spawnObserverMisses: observerMisses,
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
    correctness: ["tickMisses", "spawnObserverMisses"],
    async run() {
      const harness = await getScalingHarness();
      await ensureWarm(harness);
      const observerMisses = spawnObserverMisses();
      // StatPrecheck stamps `baselineAt` on the skip path AND after a full
      // pass, so this advances once per tick that actually ran. It is the only
      // available oracle here: the whole point of the quiet path is that it
      // spawns nothing, so the spawn counter cannot tell fifty successful
      // skips apart from fifty ticks that never happened.
      const baselinesBefore = harness.monitors.map((monitor) => monitor.lastStatBaselineAt);
      const mark = gitSpawnMark();
      const start = performance.now();
      const settled = await Promise.allSettled(
        harness.monitors.map((monitor) => harness.queue.add(() => monitor.updateGitStatus(false)))
      );
      const durationMs = performance.now() - start;
      let tickMisses = 0;
      harness.monitors.forEach((monitor, i) => {
        if (settled[i].status === "rejected") tickMisses += 1;
        else if (monitor.lastStatBaselineAt <= baselinesBefore[i]) tickMisses += 1;
      });
      return {
        durationMs,
        metrics: {
          gitSpawns: gitSpawnsSince(mark).count,
          tickMisses,
          spawnObserverMisses: observerMisses,
        },
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
    correctness: ["statusPassMisses", "spawnObserverMisses"],
    async run() {
      const fixture = getGitPipelineFixture();
      if (!dirtyMonitor) {
        dirtyMonitor = await createMonitorHarness(fixture.dirtyPath, "wt-dirty-branch");
        dirtyMonitor.startWithoutGitStatus();
      }
      const observerMisses = spawnObserverMisses();
      const checkedBefore = statusCheckedAt(dirtyMonitor);
      const mark = gitSpawnMark();
      const start = performance.now();
      await dirtyMonitor.refresh();
      const durationMs = performance.now() - start;
      // The dirty fixture is a fixed 40 modified + 12 untracked files, so the
      // pass has an exact expected answer — a numstat/line-count path that
      // quietly stopped reporting files is the cheapest possible pass.
      const changedFileCount = snapshotChangedFileCount(dirtyMonitor.getSnapshot());
      return {
        durationMs,
        metrics: {
          gitSpawns: gitSpawnsSince(mark).count,
          changedFileCount,
          statusPassMisses:
            statusPassMisses(dirtyMonitor, checkedBefore) +
            (changedFileCount >= DIRTY_MIN_CHANGED_FILES ? 0 : 1),
          spawnObserverMisses: observerMisses,
        },
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
    correctness: ["reactionMisses", "spawnObserverMisses"],
    async run() {
      const fixture = getGitPipelineFixture();
      const recorder = new EmitRecorder();
      // Fresh monitor per iteration, stopped in the finally: the recursive
      // parcel watcher is a live native handle, and leaking it would distort
      // any scenario running after this one in the same harness process.
      const monitor = await createMonitorHarness(fixture.stormPath, "storm-base", {
        isCurrent: true,
        gitWatchEnabled: true,
        onUpdate: (snapshot) => recorder.record(snapshot),
      });
      try {
        await monitor.start();
        // The recursive parcel-watcher subscription arms asynchronously;
        // give it a moment so the storm doesn't race the arm.
        await sleep(500);

        const target = fixture.stormBranches[stormFlip % 2];
        stormFlip += 1;

        const observerMisses = spawnObserverMisses();
        const from = recorder.cursor();
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

        // The independent oracle, and the reason this is not read off the
        // spawn window: a dead watcher reports gitSpawns 0 and statusPasses 0,
        // which is the cheapest sample the scenario can produce. The checkout
        // moves HEAD to the other branch, so a pipeline that actually reacted
        // emits a snapshot naming it. Prose in `notes` was the previous
        // answer, and prose is not a metric.
        const reacted = await recorder.waitFor(
          (snapshot) => snapshot.branch === target,
          Math.max(0, deadline - performance.now()),
          from
        );
        const reactionMisses = reacted ? 0 : 1;

        if (window.lastAtMs === null) {
          // Fail closed: a watcher that never reacted must not read as a
          // perfect zero-cost sample. The deadline blows the p95 budget.
          return {
            durationMs: STORM_TIMEOUT_MS,
            metrics: {
              gitSpawns: 0,
              statusPasses: 0,
              reactionMisses,
              spawnObserverMisses: observerMisses,
            },
            notes: "no pipeline reaction observed before the storm deadline",
          };
        }

        return {
          durationMs: Math.max(0, window.lastAtMs - checkoutDoneAt),
          metrics: {
            gitSpawns: window.count,
            statusPasses: window.bySubcommand["status"] ?? 0,
            reactionMisses,
            spawnObserverMisses: observerMisses,
          },
          notes:
            reactionMisses === 1
              ? "git ran during the storm but no snapshot ever named the checked-out branch"
              : undefined,
        };
      } finally {
        monitor.stop();
      }
    },
  },
  {
    id: "PERF-107",
    name: "Git Ignored-Burst Classification",
    description:
      "Watcher bursts confined to a repo-gitignored directory: git spawns and status passes per flush, against tracked-write and gitignore-edit controls.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["browserSignalMisses", "trackedRefreshMisses", "ignoreEditRefreshMisses", "spawnObserverMisses"],
    async run() {
      const fixture = getGitPipelineFixture();
      const recorder = new EmitRecorder();
      // Fresh monitor per iteration for the same reason PERF-104 uses one: the
      // recursive parcel subscription is a live native handle, and leaking it
      // would distort whatever scenario runs next in this process.
      const monitor = await createMonitorHarness(fixture.ignoredPath, "wt-ignored-branch", {
        isCurrent: true,
        gitWatchEnabled: true,
        onUpdate: (snapshot) => recorder.record(snapshot),
      });
      const outputDir = join(fixture.ignoredPath, IGNORED_BURST_DIR);
      // module-11/file-9.txt is the one (dir, file) pair the standing dirty
      // loop misses: it writes (i % 12, i % 10) for i < 40, and that pair needs
      // i = 59. Editing a CLEAN tracked file is what lets the control assert a
      // strict increase in the changed-file count — editing an already-dirty
      // one leaves the count flat, which the standing set satisfies anyway.
      const trackedFile = join(fixture.ignoredPath, "module-11", "file-9.txt");
      const gitignoreFile = join(fixture.ignoredPath, ".gitignore");
      const trackedOriginal = readFileSync(trackedFile, "utf8");
      const stamp = uid();

      /**
       * Write a burst, wait for the file-browser signal, then wait for git to
       * go quiet. The second wait is what makes the reading honest: the
       * browser signal fires at the flush boundary, BEFORE the classification
       * has decided anything, so stopping there would report zero spawns for
       * a classifier that had merely not finished yet.
       */
      async function runBurst(write: () => void): Promise<{
        spawns: number;
        statusPasses: number;
        checkIgnores: number;
        flushes: number;
        settled: boolean;
        workMs: number;
      }> {
        const from = recorder.cursor();
        const since = latestBrowserStamp(recorder);
        const mark = gitSpawnMark();
        const startedAt = performance.now();
        write();
        const sawSignal = await pollUntil(
          () => browserSignals(recorder, from, since) > 0,
          BURST_FLUSH_TIMEOUT_MS
        );
        // `quiesceGitSpawns` watches process STARTS, not completions, so a
        // classifier still running looks identical to one that finished.
        // Waiting past the classifier's own deadline is what closes that hole:
        // a hung classifier has timed out by then and the fallback refresh it
        // triggers lands inside this window, where it counts against this arm
        // instead of contaminating the next one.
        //
        // The wait has to hang off the LAST flush, not the first. One write
        // burst routinely flushes twice, and a second flush arriving 800ms in
        // starts its own classifier; sleeping from the first signal would let
        // that one's deadline fall outside the window.
        let seen = browserSignals(recorder, from, since);
        for (;;) {
          await sleep(WORKTREE_CLASSIFY_DEADLINE_MS);
          const now = browserSignals(recorder, from, since);
          if (now === seen) break;
          seen = now;
        }
        const settled = await quiesceGitSpawns(BURST_SETTLE_MS, BURST_FLUSH_TIMEOUT_MS);
        const window = gitSpawnsSince(mark);
        // One write burst does not produce one flush: the leading-edge fast
        // path fires on the first batch the watcher delivers and the ramp
        // trails the rest, so a burst of N files routinely flushes twice.
        // Dividing by the observed flush count is what makes these numbers
        // per-flush, which is how the issue frames the cost — a raw per-burst
        // tally would read as double the real figure.
        const flushes = sawSignal ? browserSignals(recorder, from, since) : 0;
        const per = (n: number) => (flushes > 0 ? n / flushes : 0);
        return {
          spawns: per(window.count),
          statusPasses: per(window.bySubcommand["status"] ?? 0),
          checkIgnores: per(window.bySubcommand["check-ignore"] ?? 0),
          flushes,
          settled,
          // Timed to the last git spawn in the window, the way PERF-104 times
          // its storm — NOT wall clock, which now carries the fixed
          // classifier-deadline sleep above and would report the
          // instrumentation instead of the work.
          workMs: window.lastAtMs === null ? 0 : Math.max(0, window.lastAtMs - startedAt),
        };
      }

      try {
        await monitor.start();
        // The recursive parcel subscription arms asynchronously; let it arm and
        // let the startup status pass drain so neither lands in a burst window.
        await sleep(500);
        await quiesceGitSpawns(BURST_SETTLE_MS, BURST_FLUSH_TIMEOUT_MS);

        const observerMisses = spawnObserverMisses();

        // Arm 1 — the case the whole change exists for. Every path is ignored
        // by the repo's own rules and untracked, so nothing here can move
        // tracked status and the status recompute must not run.
        mkdirSync(outputDir, { recursive: true });
        const ignoredArm = await runBurst(() => {
          for (let i = 0; i < IGNORED_BURST_FILES; i++) {
            writeFileSync(join(outputDir, `chunk-${stamp}-${i}.js`), `build output ${i}\n`);
          }
        });
        // Fail closed on the duration too: a watcher that never spawned git
        // has workMs 0, which would read as the cheapest possible sample AND
        // trip the liveness guard's "must self-time a positive duration" rule.
        const durationMs = ignoredArm.workMs > 0 ? ignoredArm.workMs : BURST_FLUSH_TIMEOUT_MS;

        // A dead watcher makes every later arm wait out its full deadline for
        // a signal that cannot come. Stop here and report the miss instead:
        // three timed-out arms would cost ~18s and add nothing the first miss
        // has not already said.
        if (ignoredArm.flushes === 0) {
          return {
            durationMs,
            metrics: {
              gitSpawnsPerIgnoredFlush: 0,
              statusPassesPerIgnoredFlush: 0,
              checkIgnoresPerIgnoredFlush: 0,
              ignoredFlushes: 0,
              gitSpawnsPerTrackedFlush: 0,
              statusPassesPerTrackedFlush: 0,
              gitSpawnsPerIgnoreEditFlush: 0,
              browserSignalMisses: 1,
              trackedRefreshMisses: 1,
              ignoreEditRefreshMisses: 1,
              spawnObserverMisses: observerMisses,
            },
            notes: "no file-browser signal observed for the ignored burst",
          };
        }

        // Arm 2 — tracked control. A real edit must produce the correct
        // snapshot, not merely some refresh. The oracle is a STRICT increase in
        // the changed-file count: `> 0` was already true of the standing dirty
        // set before the arm ran, so it would have been satisfied by the
        // browser notification re-emitting the old snapshot, even if the status
        // recompute that followed had failed outright.
        const trackedFrom = recorder.cursor();
        const changedBefore = snapshotChangedFileCount(monitor.getSnapshot());
        const trackedArm = await runBurst(() => {
          writeFileSync(trackedFile, `tracked edit ${stamp}\n`.repeat(8));
        });
        const trackedRefreshed = await recorder.waitFor(
          (snapshot) => snapshotChangedFileCount(snapshot) > changedBefore,
          BURST_FLUSH_TIMEOUT_MS,
          trackedFrom
        );

        // Arm 3 — ignore-rule control. `.gitignore` is not itself ignored, so
        // it fails the all-ignored test on its own and forces the refresh.
        const ignoreEditArm = await runBurst(() => {
          appendFileSync(gitignoreFile, `# touched ${stamp}\n`);
        });

        return {
          durationMs,
          metrics: {
            gitSpawnsPerIgnoredFlush: ignoredArm.spawns,
            statusPassesPerIgnoredFlush: ignoredArm.statusPasses,
            // Named separately so the composition is legible rather than
            // inferred: the whole change is one status pass per flush becoming
            // one check-ignore, and a flat total would hide that.
            checkIgnoresPerIgnoredFlush: ignoredArm.checkIgnores,
            ignoredFlushes: ignoredArm.flushes,
            gitSpawnsPerTrackedFlush: trackedArm.spawns,
            statusPassesPerTrackedFlush: trackedArm.statusPasses,
            gitSpawnsPerIgnoreEditFlush: ignoreEditArm.spawns,
            // Fail closed: a watcher that never fired is the cheapest possible
            // sample, and would otherwise read as a perfect result.
            browserSignalMisses: ignoredArm.flushes >= 1 && ignoredArm.settled ? 0 : 1,
            trackedRefreshMisses: trackedArm.statusPasses > 0 && trackedRefreshed ? 0 : 1,
            ignoreEditRefreshMisses: ignoreEditArm.statusPasses > 0 ? 0 : 1,
            spawnObserverMisses: observerMisses,
          },
          notes:
            ignoredArm.flushes === 0
              ? "no file-browser signal observed for the ignored burst"
              : undefined,
        };
      } finally {
        monitor.stop();
        // Leave the fixture exactly as the next iteration expects to find it.
        // Without this the ignored directory grows by 40 files per iteration,
        // so later iterations watch a bigger tree than earlier ones and the
        // samples stop being comparable.
        writeFileSync(gitignoreFile, `${IGNORED_BURST_DIR}/\n`);
        writeFileSync(trackedFile, trackedOriginal);
        rmSync(outputDir, { recursive: true, force: true });
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
    correctness: ["detectionMisses", "watcherArmMisses", "spawnObserverMisses"],
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
      // Taken up front, before any counted window opens: the probe starts a
      // child process to prove the counter can still see one.
      const observerMisses = spawnObserverMisses();
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
            spawnObserverMisses: observerMisses,
          });
        }

        const idle = await measureIdleWindow(monitor, recorder, fixture.idlePath, probeName);
        const cleanup = await measureCleanup(monitor, probeFile);
        return {
          // Self-timed: the headline number is a count, not a duration.
          durationMs: 0,
          metrics: { ...idle, ...cleanup, spawnObserverMisses: observerMisses },
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
    correctness: [
      "detectionMisses",
      "watcherArmMisses",
      "faultInjectionMisses",
      "faultStateMisses",
      "spawnObserverMisses",
    ],
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
      const observerMisses = spawnObserverMisses();
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
          spawnObserverMisses: observerMisses,
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
