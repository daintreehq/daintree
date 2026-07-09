import { basename } from "node:path";
import type { PerfScenario, ScenarioSample } from "../types";
import { gitSpawnMark, gitSpawnsSince, percentileOf, sleep } from "../lib/gitPipelineFixture";
import {
  FAN_IN_WORKTREE_COUNT,
  TOPOLOGY_SCALING_COUNTS,
  TopologyHarness,
  commitAllIn,
  createRecordingMonitor,
  getScaleTopologyHarness,
  getSidebarEditFixture,
  getSteadyTopologyHarness,
  loadWorktreeStoreModule,
  makeBenchSnapshot,
  pollUntil,
  quiesceGitSpawns,
  removeFileQuietly,
  snapshotChangedFileCount,
  startArmedMonitor,
  uid,
  writeEditFile,
  type RecordingMonitor,
} from "../lib/worktreeSidebarFixture";

/**
 * Worktree sidebar latency scenarios (PERF-130..141): wall-time from a real
 * filesystem/topology mutation until the workspace-host pipeline emits the
 * snapshot the sidebar would render (Axis A: change detection; Axis B:
 * external-worktree pickup through the real TopologyWatcher + reconcile), and
 * the renderer store's apply/coalescing cost (Axis C, headless against the
 * real createWorktreeStore).
 *
 * These scenarios return LATENCY, not work done — expect debounce-shaped
 * floors (working-tree ramp 250→800ms/1500ms max-wait, git-metadata 300ms,
 * topology 300ms + 2s reconcile cooldown, 1s self-trigger cooldown) and use
 * generous regression margins; latency is noisier than cost.
 *
 * All fixture setup is lazy (first run()/warmup) so importing this module
 * never builds repos, services, or bundles. E2E variants of this suite
 * (PERF-142..145: renderer commit fan-out via the render probe) are specced
 * but intentionally not implemented here — they need the bench build and a
 * real Electron session.
 */

const EMIT_TIMEOUT_MS = 8_000;
const TOPOLOGY_TIMEOUT_MS = 10_000;
const POLL_BOUND_INTERVAL_MS = 1_500;
const BURST_FILE_COUNT = 50;
const BULK_ADD_COUNT = 10;
const STORE_SEED_COUNTS = [50, 200] as const;
const STORE_APPLY_BATCH = 400;

function failClosed(
  durationMs: number,
  notes: string,
  metrics?: Record<string, number>
): ScenarioSample {
  return { durationMs, metrics, notes };
}

export const worktreeSidebarScenarios: PerfScenario[] = [
  {
    id: "PERF-130",
    name: "Sidebar Edit Latency (focused worktree, watcher → emit)",
    description:
      "Wall-time from one file write in a clean recursively-watched worktree until the snapshot emit whose change count reflects it.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 10, nightly: 14 },
    warmups: 1,
    async run() {
      const fixture = getSidebarEditFixture();
      const rm = await createRecordingMonitor(fixture.focusPath, "wt-focus-branch", {
        isCurrent: true,
        gitWatchEnabled: true,
      });
      let editFile: string | null = null;
      try {
        await startArmedMonitor(rm, { requireWatcher: true });
        await quiesceGitSpawns();
        const from = rm.recorder.cursor();
        const mark = gitSpawnMark();
        const t0 = performance.now();
        editFile = writeEditFile(fixture.focusPath, `edit-${uid()}.txt`);
        const emit = await rm.recorder.waitFor(
          (s) => snapshotChangedFileCount(s) >= 1,
          EMIT_TIMEOUT_MS,
          from
        );
        const gitSpawns = gitSpawnsSince(mark).count;
        if (!emit) {
          return failClosed(EMIT_TIMEOUT_MS, "no matching emit before deadline", { gitSpawns });
        }
        return { durationMs: emit.atMs - t0, metrics: { gitSpawns } };
      } finally {
        rm.monitor.stop();
        if (editFile) removeFileQuietly(editFile);
      }
    },
  },
  {
    id: "PERF-131",
    name: "Sidebar Commit Latency (git-metadata watcher → emit)",
    description:
      "Wall-time from an external `git add && git commit` until the emit reflecting the now-clean worktree (the .git metadata debounce path).",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 10, nightly: 14 },
    warmups: 1,
    async run() {
      const fixture = getSidebarEditFixture();
      const seq = uid();
      // Pre-dirty before the monitor starts: the initial pass then reports
      // changedFileCount >= 1, making the post-commit count===0 emit
      // unambiguous (a stray poll emit can't false-match).
      writeEditFile(fixture.metaPath, `staged-${seq}.txt`);
      const rm = await createRecordingMonitor(fixture.metaPath, "wt-meta-branch", {
        isCurrent: false,
        gitWatchEnabled: true,
      });
      try {
        await startArmedMonitor(rm, { requireWatcher: true });
        await quiesceGitSpawns();
        const from = rm.recorder.cursor();
        const mark = gitSpawnMark();
        commitAllIn(fixture.metaPath, `bench commit ${seq}`);
        const t0 = performance.now();
        const emit = await rm.recorder.waitFor(
          (s) => snapshotChangedFileCount(s) === 0,
          EMIT_TIMEOUT_MS,
          from
        );
        const gitSpawns = gitSpawnsSince(mark).count;
        if (!emit) {
          return failClosed(EMIT_TIMEOUT_MS, "no clean-state emit before deadline", { gitSpawns });
        }
        return { durationMs: emit.atMs - t0, metrics: { gitSpawns } };
      } finally {
        rm.monitor.stop();
      }
    },
  },
  {
    id: "PERF-132",
    name: "Sidebar Poll-Bound Detection (watcherless worst case)",
    description:
      "Watcherless worktree on a compressed poll interval: an edit is only caught by the timed poll once the stat budget expires. Guards the interval-normalized detection ratio, not the raw production interval.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 6, nightly: 8 },
    warmups: 1,
    async run() {
      const fixture = getSidebarEditFixture();
      const rm = await createRecordingMonitor(fixture.pollPath, "wt-poll-branch", {
        isCurrent: false,
        gitWatchEnabled: false,
        basePollingInterval: POLL_BOUND_INTERVAL_MS,
      });
      let editFile: string | null = null;
      try {
        await startArmedMonitor(rm, { requireWatcher: false });
        await quiesceGitSpawns();
        // Phase-align to the poll cycle: wait for a quiet tick to complete
        // (the freshness stamp advances even on the 0-spawn skip path), then
        // mutate immediately after it. Detection then deterministically costs
        // one full poll cycle — the true poll-bound worst case — instead of
        // sampling whatever phase the fixed setup time happens to land on.
        const stampBefore = rm.monitor.getSnapshot().lastGitStatusCheckedAt ?? 0;
        await pollUntil(
          () => (rm.monitor.getSnapshot().lastGitStatusCheckedAt ?? 0) > stampBefore,
          POLL_BOUND_INTERVAL_MS * 3,
          15
        );
        const from = rm.recorder.cursor();
        const t0 = performance.now();
        editFile = writeEditFile(fixture.pollPath, `poll-edit-${uid()}.txt`);
        // A pure working-tree edit leaves the stat baseline (index/HEAD/refs)
        // untouched, so quiet ticks would skip git until the 120s full-status
        // budget lapses. Age the budget through the monitor's test backdoor —
        // after the write, so a racing tick can't re-baseline it first.
        rm.monitor.lastFullStatusAt = Date.now() - 121_000;
        const emit = await rm.recorder.waitFor(
          (s) => snapshotChangedFileCount(s) >= 1,
          15_000,
          from
        );
        if (!emit) {
          return failClosed(15_000, "poll never detected the edit", {
            detectionToIntervalRatio: 15_000 / POLL_BOUND_INTERVAL_MS,
          });
        }
        const latency = emit.atMs - t0;
        return {
          durationMs: latency,
          metrics: { detectionToIntervalRatio: latency / POLL_BOUND_INTERVAL_MS },
        };
      } finally {
        rm.monitor.stop();
        if (editFile) removeFileQuietly(editFile);
      }
    },
  },
  {
    id: "PERF-133",
    name: "Sidebar Burst Coalescing (50 rapid edits)",
    description:
      "50 files written back-to-back into a watched worktree: time to first emit, time until an emit reflects all 50, and how well the debounce ramp coalesces emits and git passes.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 10 },
    warmups: 1,
    async run() {
      const fixture = getSidebarEditFixture();
      const rm = await createRecordingMonitor(fixture.burstPath, "wt-burst-branch", {
        isCurrent: true,
        gitWatchEnabled: true,
      });
      const files: string[] = [];
      try {
        await startArmedMonitor(rm, { requireWatcher: true });
        await quiesceGitSpawns();
        const from = rm.recorder.cursor();
        const mark = gitSpawnMark();
        const t0 = performance.now();
        for (let i = 0; i < BURST_FILE_COUNT; i++) {
          files.push(writeEditFile(fixture.burstPath, `burst-${i}.txt`));
        }
        const first = await rm.recorder.waitFor(
          (s) => snapshotChangedFileCount(s) >= 1,
          EMIT_TIMEOUT_MS,
          from
        );
        const settled =
          first && snapshotChangedFileCount(first.snapshot) >= BURST_FILE_COUNT
            ? first
            : await rm.recorder.waitFor(
                (s) => snapshotChangedFileCount(s) >= BURST_FILE_COUNT,
                EMIT_TIMEOUT_MS,
                from
              );
        // Let any deferred-drain echo pass finish so emitCount/gitSpawns
        // reflect the whole coalescing story, not a truncated window.
        await quiesceGitSpawns();
        const window = gitSpawnsSince(mark);
        const emitCount = rm.recorder.cursor() - from;
        if (!first || !settled) {
          return failClosed(EMIT_TIMEOUT_MS, "burst never fully reflected before deadline", {
            emitCount,
            gitSpawns: window.count,
          });
        }
        return {
          durationMs: settled.atMs - t0,
          metrics: {
            firstEmitMs: first.atMs - t0,
            settleMs: settled.atMs - t0,
            emitCount,
            gitSpawns: window.count,
          },
        };
      } finally {
        rm.monitor.stop();
        for (const file of files) removeFileQuietly(file);
      }
    },
  },
  {
    id: "PERF-134",
    name: "Sidebar Concurrent Fan-In (12 worktrees edited at once)",
    description:
      "One file edited in each of 12 recursively-watched worktrees simultaneously (the background-watcher cap); per-worktree emit latency distribution under concurrent status passes.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    async run() {
      const fixture = getSidebarEditFixture();
      const monitors: RecordingMonitor[] = [];
      const files: string[] = [];
      try {
        for (const wtPath of fixture.fanInPaths) {
          monitors.push(
            await createRecordingMonitor(wtPath, `${basename(wtPath)}-branch`, {
              isCurrent: true,
              gitWatchEnabled: true,
            })
          );
        }
        for (const rm of monitors) {
          await startArmedMonitor(rm, { requireWatcher: true });
        }
        await quiesceGitSpawns();
        const cursors = monitors.map((rm) => rm.recorder.cursor());
        const mark = gitSpawnMark();
        const seq = uid();
        const t0 = performance.now();
        for (const wtPath of fixture.fanInPaths) {
          files.push(writeEditFile(wtPath, `fanin-${seq}.txt`));
        }
        const emits = await Promise.all(
          monitors.map((rm, i) =>
            rm.recorder.waitFor(
              (s) => snapshotChangedFileCount(s) >= 1,
              EMIT_TIMEOUT_MS,
              cursors[i]
            )
          )
        );
        const gitSpawns = gitSpawnsSince(mark).count;
        const latencies = emits.map((emit) => (emit ? emit.atMs - t0 : EMIT_TIMEOUT_MS));
        const missing = emits.filter((emit) => emit === null).length;
        const allSettledMs = Math.max(...latencies);
        return {
          durationMs: allSettledMs,
          metrics: {
            p95LatencyMs: percentileOf(latencies, 95),
            maxLatencyMs: allSettledMs,
            meanLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
            gitSpawns,
          },
          notes:
            missing > 0
              ? `${missing}/${FAN_IN_WORKTREE_COUNT} emits missed the deadline`
              : undefined,
        };
      } finally {
        for (const rm of monitors) rm.monitor.stop();
        for (const file of files) removeFileQuietly(file);
      }
    },
  },
  {
    id: "PERF-135",
    name: "Topology Pickup (external worktree add → surfaced)",
    description:
      "Steady-state project: wall-time from an external `git worktree add` completing until the first worktree-update event carrying the new worktree.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 6, nightly: 8 },
    warmups: 1,
    async run() {
      const harness = await getSteadyTopologyHarness();
      await harness.settle();
      const name = `ext-${uid()}`;
      const from = harness.cursor();
      const mark = gitSpawnMark();
      const wtPath = harness.addWorktreeExternal(name);
      const addDoneAt = performance.now();
      const surfaced = await harness.waitForSurfaced(name, TOPOLOGY_TIMEOUT_MS, from);
      const worktreeListSpawns = gitSpawnsSince(mark).bySubcommand["worktree"] ?? 0;
      await harness.cleanupWorktree(wtPath, name, from);
      if (!surfaced) {
        return failClosed(TOPOLOGY_TIMEOUT_MS, "external add never surfaced", {
          worktreeListSpawns,
        });
      }
      return { durationMs: surfaced.atMs - addDoneAt, metrics: { worktreeListSpawns } };
    },
  },
  {
    id: "PERF-136",
    name: "Topology Cold Pickup (first-ever worktree, sentinel path)",
    description:
      "Project with no .git/worktrees dir yet: the fs.watch sentinel must hand off to the parcel watcher and surface the first external add without waiting for the 90s safety net.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 6 },
    warmups: 1,
    async run() {
      const harness = await TopologyHarness.create(0);
      try {
        const name = `cold-${uid()}`;
        const from = harness.cursor();
        harness.addWorktreeExternal(name);
        const addDoneAt = performance.now();
        const surfaced = await harness.waitForSurfaced(name, TOPOLOGY_TIMEOUT_MS, from);
        if (!surfaced) {
          return failClosed(TOPOLOGY_TIMEOUT_MS, "cold add never surfaced (sentinel missed)");
        }
        return { durationMs: surfaced.atMs - addDoneAt };
      } finally {
        harness.dispose();
      }
    },
  },
  {
    id: "PERF-137",
    name: "Topology Bulk Add (10 external adds → all surfaced)",
    description:
      "Ten external worktree adds in a tight loop: time until every one has surfaced, and how few reconcile passes the coalescing needed.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 2, ci: 3, nightly: 5 },
    warmups: 1,
    async run() {
      const harness = await getSteadyTopologyHarness();
      await harness.settle();
      const seq = uid();
      const names = Array.from({ length: BULK_ADD_COUNT }, (_, k) => `bulk-${seq}-${k}`);
      const from = harness.cursor();
      const mark = gitSpawnMark();
      const t0 = performance.now();
      const paths = names.map((name) => harness.addWorktreeExternal(name));

      const remainingAdds = new Set(names);
      let lastSurfacedAt = t0;
      let index = from;
      const deadline = t0 + 20_000;
      while (remainingAdds.size > 0 && performance.now() < deadline) {
        while (index < harness.events.length) {
          const recorded = harness.events[index];
          index += 1;
          if (recorded.event.type === "worktree-update") {
            if (remainingAdds.delete(basename(recorded.event.worktree.id))) {
              lastSurfacedAt = recorded.atMs;
            }
          }
        }
        await sleep(5);
      }
      const window = gitSpawnsSince(mark);
      const allSurfaced = remainingAdds.size === 0;

      for (const wtPath of paths) harness.removeWorktreeExternal(wtPath);
      harness.svc.scheduleTopologyReconcile(true);
      const remainingRemoves = new Set(names);
      const removeDeadline = performance.now() + 20_000;
      while (remainingRemoves.size > 0 && performance.now() < removeDeadline) {
        while (index < harness.events.length) {
          const recorded = harness.events[index];
          index += 1;
          if (recorded.event.type === "worktree-removed") {
            remainingRemoves.delete(basename(recorded.event.worktreeId));
          }
        }
        await sleep(5);
      }
      await harness.settle();

      const metrics = {
        worktreeListSpawns: window.bySubcommand["worktree"] ?? 0,
        gitSpawns: window.count,
      };
      if (!allSurfaced) {
        return failClosed(
          20_000,
          `${remainingAdds.size}/${BULK_ADD_COUNT} adds never surfaced`,
          metrics
        );
      }
      return {
        durationMs: lastSurfacedAt - t0,
        metrics: { ...metrics, allSurfacedMs: lastSurfacedAt - t0 },
        notes:
          remainingRemoves.size > 0
            ? `${remainingRemoves.size} cleanup removals unconfirmed`
            : undefined,
      };
    },
  },
  {
    id: "PERF-138",
    name: "Topology Pickup Scaling (add latency vs 1/5/20/50 existing)",
    description:
      "One external worktree add against projects already holding 1, 5, 20, and 50 worktrees — does pickup latency grow with topology size?",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 2, ci: 3, nightly: 4 },
    warmups: 1,
    async run() {
      const latencies = new Map<number, number>();
      const notes: string[] = [];
      for (const count of TOPOLOGY_SCALING_COUNTS) {
        const harness = await getScaleTopologyHarness(count);
        await harness.settle();
        const name = `scale-${count}-${uid()}`;
        const from = harness.cursor();
        const wtPath = harness.addWorktreeExternal(name);
        const addDoneAt = performance.now();
        const surfaced = await harness.waitForSurfaced(name, TOPOLOGY_TIMEOUT_MS, from);
        latencies.set(count, surfaced ? surfaced.atMs - addDoneAt : TOPOLOGY_TIMEOUT_MS);
        if (!surfaced) notes.push(`N=${count} add never surfaced`);
        await harness.cleanupWorktree(wtPath, name, from);
      }
      return {
        durationMs: latencies.get(50) ?? TOPOLOGY_TIMEOUT_MS,
        metrics: {
          latencyMsN1: latencies.get(1) ?? TOPOLOGY_TIMEOUT_MS,
          latencyMsN5: latencies.get(5) ?? TOPOLOGY_TIMEOUT_MS,
          latencyMsN20: latencies.get(20) ?? TOPOLOGY_TIMEOUT_MS,
          latencyMsN50: latencies.get(50) ?? TOPOLOGY_TIMEOUT_MS,
        },
        notes: notes.length > 0 ? notes.join("; ") : undefined,
      };
    },
  },
  {
    id: "PERF-139",
    name: "Topology Removal (external worktree remove → dropped)",
    description:
      "Wall-time from an external `git worktree remove` completing until the worktree-removed event drops it — measured from a settled window (durationMs) and from inside the post-reconcile cooldown window (cooldownRemovalMs, the 'removed right after other topology activity' case).",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 6 },
    warmups: 1,
    async run() {
      const harness = await getSteadyTopologyHarness();
      await harness.settle();
      const name = `rm-${uid()}`;
      let from = harness.cursor();
      const wtPath = harness.addWorktreeExternal(name);
      const surfaced = await harness.waitForSurfaced(name, TOPOLOGY_TIMEOUT_MS, from);
      if (!surfaced) {
        await harness.cleanupWorktree(wtPath, name, from);
        return failClosed(TOPOLOGY_TIMEOUT_MS, "setup add never surfaced");
      }
      await harness.settle();
      from = harness.cursor();
      harness.removeWorktreeExternal(wtPath);
      const removeDoneAt = performance.now();
      const removed = await harness.waitForRemoved(name, TOPOLOGY_TIMEOUT_MS, from);
      if (!removed) {
        return failClosed(TOPOLOGY_TIMEOUT_MS, "external removal never dropped");
      }
      const settledRemovalMs = removed.atMs - removeDoneAt;

      // Second leg: remove while the add's reconcile cooldown is still hot —
      // the realistic "external change right after other topology activity"
      // case. Guards the deferred-drain path (an event landing inside the 2s
      // cooldown must still be reconciled promptly, not stranded until the
      // next unrelated event or the 90s safety net).
      const name2 = `rmhot-${uid()}`;
      const from2 = harness.cursor();
      const wtPath2 = harness.addWorktreeExternal(name2);
      const surfaced2 = await harness.waitForSurfaced(name2, TOPOLOGY_TIMEOUT_MS, from2);
      let cooldownRemovalMs = EMIT_TIMEOUT_MS;
      let notes: string | undefined;
      if (surfaced2) {
        harness.removeWorktreeExternal(wtPath2);
        const removeDoneAt2 = performance.now();
        const removed2 = await harness.waitForRemoved(name2, EMIT_TIMEOUT_MS, from2);
        if (removed2) {
          cooldownRemovalMs = removed2.atMs - removeDoneAt2;
        } else {
          notes = "in-cooldown removal stranded past deadline";
          harness.svc.scheduleTopologyReconcile(true);
          await harness.waitForRemoved(name2, TOPOLOGY_TIMEOUT_MS, from2);
        }
      } else {
        notes = "in-cooldown setup add never surfaced";
        await harness.cleanupWorktree(wtPath2, name2, from2);
      }
      return {
        durationMs: settledRemovalMs,
        metrics: { settledRemovalMs, cooldownRemovalMs },
        notes,
      };
    },
  },
  {
    id: "PERF-140",
    name: "Store Apply Fan-Out (single-worktree update at 50/200 rows)",
    description:
      "Real createWorktreeStore seeded with 50 and 200 snapshots; cost of single-worktree applyUpdate batches and whether one logical change stays one Map commit.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 16, nightly: 24 },
    warmups: 1,
    async run() {
      const { createWorktreeStore } = await loadWorktreeStoreModule();
      const applyMsBySeed = new Map<number, number>();
      let notifies = 0;
      let mapChanges = 0;
      let applies = 0;
      for (const seedCount of STORE_SEED_COUNTS) {
        const store = createWorktreeStore();
        let seq = 0;
        const seed = Array.from({ length: seedCount }, (_, i) => makeBenchSnapshot(i));
        seq += 1;
        store.getState().applySnapshot(seed, { epoch: "bench", seq });
        let prevMap = store.getState().worktrees;
        const unsubscribe = store.subscribe(() => {
          notifies += 1;
          const map = store.getState().worktrees;
          if (map !== prevMap) {
            mapChanges += 1;
            prevMap = map;
          }
        });
        const t0 = performance.now();
        for (let b = 0; b < STORE_APPLY_BATCH; b++) {
          seq += 1;
          store.getState().applyUpdate(
            makeBenchSnapshot(b % seedCount, {
              changedFileCount: b + 1,
              lastUpdated: 1_000_000 + b + 1,
            }),
            { epoch: "bench", seq }
          );
        }
        applyMsBySeed.set(seedCount, performance.now() - t0);
        applies += STORE_APPLY_BATCH;
        unsubscribe();
      }
      const applyMsN200 = applyMsBySeed.get(200) ?? 0;
      return {
        durationMs: applyMsN200,
        metrics: {
          applyMsN50: applyMsBySeed.get(50) ?? 0,
          applyMsN200,
          perApplyUsN200: (applyMsN200 * 1000) / STORE_APPLY_BATCH,
          notifiesPerApply: notifies / applies,
          mapChangesPerApply: mapChanges / applies,
        },
      };
    },
  },
  {
    id: "PERF-141",
    name: "Store Freshness No-Churn (statusCheckedAt-only updates)",
    description:
      "Updates that only advance the lastGitStatusCheckedAt freshness stamp must not churn the worktrees Map identity (the side-map decoupling that keeps quiet polls from re-rendering rows).",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 16, nightly: 24 },
    warmups: 1,
    async run() {
      const { createWorktreeStore } = await loadWorktreeStoreModule();
      const store = createWorktreeStore();
      const seedCount = 200;
      let seq = 0;
      const seed = Array.from({ length: seedCount }, (_, i) => makeBenchSnapshot(i));
      seq += 1;
      store.getState().applySnapshot(seed, { epoch: "bench", seq });
      let prevMap = store.getState().worktrees;
      let mapIdentityChanges = 0;
      let notifies = 0;
      const unsubscribe = store.subscribe(() => {
        notifies += 1;
        const map = store.getState().worktrees;
        if (map !== prevMap) {
          mapIdentityChanges += 1;
          prevMap = map;
        }
      });
      const t0 = performance.now();
      for (let b = 0; b < STORE_APPLY_BATCH; b++) {
        seq += 1;
        store
          .getState()
          .applyUpdate(makeBenchSnapshot(b % seedCount, { checkedAt: 1_000_000 + b + 1 }), {
            epoch: "bench",
            seq,
          });
      }
      const elapsed = performance.now() - t0;
      unsubscribe();
      return {
        durationMs: elapsed,
        metrics: {
          mapIdentityChanges,
          notifiesPerApply: notifies / STORE_APPLY_BATCH,
          perApplyUs: (elapsed * 1000) / STORE_APPLY_BATCH,
        },
      };
    },
  },
];
