import { PerformanceObserver, constants } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import {
  makeTerminalStream,
  simulateTerminalOutputPass,
  terminalOutputPassMisses,
  createLargeStateSnapshot,
  spinEventLoop,
} from "../lib/workloads";
import {
  addLayoutMergeMisses,
  buildLayoutMergePlan,
  layoutMergeMisses,
  runLayoutMergePass,
  zeroLayoutMergeMisses,
  type LayoutMergeMisses,
} from "../lib/layoutMergeFixture";
import {
  ackAllQueues,
  buildFleetSpec,
  captureConsole,
  createFleet,
  gradeFlushCadence,
  loadFlowControlModules,
  measureTimerOverheadNs,
  runFlood,
  timerOverheadMsFor,
  type FleetSpec,
} from "../lib/ptyFlowControlFixture";
import {
  addHydrationMisses,
  buildHydrationPlan,
  hydrationPassMisses,
  loadStatePatcherModule,
  runHydrationPass,
  zeroHydrationMisses,
  type HydrationMisses,
} from "../lib/hydrationFixture";

function memoryUsedMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function normalizeBaselineMb(baselineMb: number): number {
  return Math.max(baselineMb, 256);
}

function maybeRunGc(): void {
  const gcFn = (globalThis as { gc?: () => void }).gc;
  if (typeof gcFn === "function") {
    gcFn();
  }
}

interface GcStats {
  minorGcCount: number;
  minorGcPauseMs: number;
}

async function measureMinorGc(body: () => void | Promise<void>): Promise<GcStats> {
  const stats: GcStats = { minorGcCount: 0, minorGcPauseMs: 0 };
  const record = (entries: PerformanceEntryList): void => {
    for (const entry of entries) {
      const kind = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind;
      if (kind === constants.NODE_PERFORMANCE_GC_MINOR) {
        stats.minorGcCount += 1;
        stats.minorGcPauseMs += entry.duration;
      }
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  try {
    observer.observe({ type: "gc", buffered: true });
    await body();
    // GC entries are flushed to the observer on a macrotask turn, not a
    // microtask — a Promise.resolve() spin would never surface them. Yield a
    // real timer turn, then sweep any still-pending records before disconnect.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    record(observer.takeRecords());
  } finally {
    observer.disconnect();
  }
  return stats;
}

/**
 * The soak workloads are the real subjects now, not simulations.
 *
 * PERF-060 and PERF-061 previously churned `simulateLayoutHydration` and
 * `simulateProjectSwitchCycle` — a `Map.set` loop and a `JSON.stringify`. The
 * allocation profile they soaked was the benchmark's own. Each cycle now runs
 * the production layout merge (`shared/utils/layoutMerge.ts`) and the
 * production restore builders (`src/utils/stateHydration/statePatcher.ts`), so
 * the retained-heap envelope is over the objects the app actually allocates on
 * a switch.
 */
const SOAK_MERGE_PLAN_A = buildLayoutMergePlan("soak-A", 110, 601);
const SOAK_MERGE_PLAN_B = buildLayoutMergePlan("soak-B", 140, 602);
const SOAK_HYDRATION_PLAN_A = buildHydrationPlan("soak-A", 110, 8);
const SOAK_HYDRATION_PLAN_B = buildHydrationPlan("soak-B", 140, 10);
const SOAK_STREAM = makeTerminalStream(2500, 130);

/** Total misses across both graded subjects, flattened for the report. */
function soakMissTotals(
  merge: LayoutMergeMisses,
  hydration: HydrationMisses
): Record<string, number> {
  return { ...merge, ...hydration };
}
const SOAK_SCROLLBACK = 6000;
/** Cycles per iteration. Named so the oracles can hold the loops to them. */
const MIXED_SOAK_CYCLES = 120;
const CHURN_SOAK_CYCLES = 180;
const LEAK_SAMPLE_CYCLES = 40;
const LEAK_RECORDS_PER_CYCLE = 600;
/** Fixed width, so the expected payload volume is arithmetic over the loop bounds. */
const LEAK_PAYLOAD_CHARS = 64;
const LEAK_HEAP_SAMPLE_EVERY = 4;
const LEAK_EXPECTED_HEAP_SAMPLES = Math.ceil(LEAK_SAMPLE_CYCLES / LEAK_HEAP_SAMPLE_EVERY);
const LEAK_EXPECTED_PAYLOAD_CHARS =
  LEAK_SAMPLE_CYCLES * LEAK_RECORDS_PER_CYCLE * LEAK_PAYLOAD_CHARS;

interface LeakRecord {
  id: string;
  data: string;
}

/**
 * What PERF-062's workload must have left behind for its growth envelope to
 * mean anything.
 *
 * The scenario reports memory growth, so every way of doing less work posts a
 * better number: allocating nothing, allocating records that hold a pointer
 * into a constant table instead of their own bytes, dropping each cycle's
 * records before the next reading, or reporting a heap sample without taking
 * one. Each term below is a reading only the real workload can produce —
 * payload volume accumulated per record as it was built (an empty record adds
 * nothing), the retained head of every cycle still holding its own bytes at the
 * end, and the sample values themselves rather than a counter incremented
 * beside the call. A constant sampler yields one distinct reading.
 *
 * There is deliberately no floor on the growth figure itself: heapUsed at the
 * start of an iteration still carries the previous one's garbage, so a GC
 * landing mid-run can cancel out real retention. That makes a floor a flake,
 * not an oracle.
 */
export function leakWorkloadMisses(observed: {
  retained: ReadonlyArray<LeakRecord | undefined>;
  payloadChars: number;
  heapSamples: readonly number[];
}): number {
  let unretained = 0;
  for (let cycle = 0; cycle < LEAK_SAMPLE_CYCLES; cycle += 1) {
    const head = observed.retained[cycle * LEAK_RECORDS_PER_CYCLE];
    if (
      !head ||
      head.id !== `${cycle}-0` ||
      head.data.length !== LEAK_PAYLOAD_CHARS ||
      !head.data.startsWith(head.id)
    ) {
      unretained += 1;
    }
  }

  return (
    Math.abs(LEAK_EXPECTED_PAYLOAD_CHARS - observed.payloadChars) +
    Math.abs(LEAK_EXPECTED_HEAP_SAMPLES - observed.heapSamples.length) +
    (new Set(observed.heapSamples).size > 1 ? 0 : 1) +
    unretained
  );
}

export const soakScenarios: PerfScenario[] = [
  {
    id: "PERF-060",
    name: "2h Mixed Activity Soak (Scaled)",
    description:
      "Scaled mixed activity soak: 120 cycles of the real layout merge, the real per-panel restore builders and a terminal output pass, to detect unbounded memory growth over the objects a switch actually allocates.",
    tier: "soak",
    modes: ["nightly", "soak"],
    iterations: { nightly: 4, soak: 8 },
    warmups: 1,
    correctness: [
      "soakCycleMisses",
      "terminalPassMisses",
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
      "kindInferenceMisses",
      "backendRestoreMisses",
      "reconnectRestoreMisses",
      "respawnResumeMisses",
      "resumeSuppressionMisses",
      "nonPtyRestoreMisses",
      "sanitizerMisses",
      "orphanMisses",
      "routeCoverageMisses",
    ],
    async run() {
      const mod = await loadStatePatcherModule();
      maybeRunGc();
      const baselineMb = memoryUsedMb();
      const startedAt = performance.now();
      let checksum = 0;
      let terminalPassMisses = 0;
      let mergeMisses = zeroLayoutMergeMisses();
      let hydrationMisses = zeroHydrationMisses();
      let cycles = 0;

      for (let i = 0; i < MIXED_SOAK_CYCLES; i += 1) {
        const mergePlan = i % 2 === 0 ? SOAK_MERGE_PLAN_A : SOAK_MERGE_PLAN_B;
        const hydrationPlan = i % 2 === 0 ? SOAK_HYDRATION_PLAN_A : SOAK_HYDRATION_PLAN_B;

        const merged = runLayoutMergePass(mergePlan);
        const hydrated = runHydrationPass(mod, hydrationPlan);
        const terminal = simulateTerminalOutputPass(SOAK_STREAM.chunks, SOAK_SCROLLBACK);

        checksum += merged.payloadBytes + hydrated.builtPanelCount + terminal.checksum;
        cycles += 1;
        mergeMisses = addLayoutMergeMisses(mergeMisses, layoutMergeMisses(mergePlan, merged));
        hydrationMisses = addHydrationMisses(
          hydrationMisses,
          hydrationPassMisses(hydrationPlan, hydrated)
        );
        terminalPassMisses += terminalOutputPassMisses(SOAK_STREAM, SOAK_SCROLLBACK, terminal);

        if (i % 15 === 0) {
          await spinEventLoop(0.8);
        }
      }

      const durationMs = performance.now() - startedAt;
      maybeRunGc();
      const finalMb = memoryUsedMb();
      const memoryGrowthMb = Math.max(0, finalMb - baselineMb);
      const normalizedBaselineMb = normalizeBaselineMb(baselineMb);
      const memoryGrowthPct = (memoryGrowthMb / normalizedBaselineMb) * 100;

      return {
        durationMs,
        metrics: {
          memoryGrowthPct,
          memoryGrowthMb,
          checksum,
          // A soak that stopped churning holds its heap flat, which reads as the
          // cleanest run this scenario has ever recorded.
          soakCycleMisses: Math.abs(MIXED_SOAK_CYCLES - cycles),
          terminalPassMisses,
          ...soakMissTotals(mergeMisses, hydrationMisses),
        },
      };
    },
  },
  {
    id: "PERF-061",
    name: "Overnight Soak Switch/Restart (Scaled)",
    description:
      "Scaled overnight churn: 180 cycles of the real switch merge alongside a large snapshot build, for the restart-like allocation pattern.",
    tier: "soak",
    modes: ["nightly", "soak"],
    iterations: { nightly: 3, soak: 6 },
    warmups: 1,
    correctness: [
      "churnCycleMisses",
      "snapshotBuildMisses",
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
    ],
    async run() {
      maybeRunGc();
      const baselineMb = memoryUsedMb();
      const startedAt = performance.now();
      let checksum = 0;
      let snapshotBuildMisses = 0;
      let mergeMisses = zeroLayoutMergeMisses();
      let cycles = 0;

      for (let i = 0; i < CHURN_SOAK_CYCLES; i += 1) {
        const mergePlan = i % 3 === 0 ? SOAK_MERGE_PLAN_A : SOAK_MERGE_PLAN_B;
        const merged = runLayoutMergePass(mergePlan);
        const scale = 800 + (i % 6) * 120;
        const snapshot = createLargeStateSnapshot(scale);
        const payload = JSON.stringify(snapshot);
        checksum += merged.payloadBytes + payload.length;
        cycles += 1;
        mergeMisses = addLayoutMergeMisses(mergeMisses, layoutMergeMisses(mergePlan, merged));
        snapshotBuildMisses +=
          // The snapshot builder is the restart-like half of the churn: its
          // panel count follows `scale` by construction, so a builder that
          // stopped building scores here instead of allocating nothing.
          Math.abs(scale - snapshot.appState.terminals.length) + (payload.length > 0 ? 0 : 1);

        if (i % 18 === 0) {
          await spinEventLoop(1.1);
        }
      }

      const durationMs = performance.now() - startedAt;
      maybeRunGc();
      const finalMb = memoryUsedMb();
      const memoryGrowthMb = Math.max(0, finalMb - baselineMb);
      const normalizedBaselineMb = normalizeBaselineMb(baselineMb);
      const memoryGrowthPct = (memoryGrowthMb / normalizedBaselineMb) * 100;

      return {
        durationMs,
        metrics: {
          memoryGrowthPct,
          memoryGrowthMb,
          checksum,
          churnCycleMisses: Math.abs(CHURN_SOAK_CYCLES - cycles),
          snapshotBuildMisses,
          ...mergeMisses,
        },
      };
    },
  },
  {
    id: "PERF-062",
    name: "Leak Detection Snapshot Intervals",
    description: "Capture memory snapshots at intervals and report peak growth envelope.",
    tier: "soak",
    modes: ["nightly", "soak"],
    iterations: { nightly: 3, soak: 6 },
    warmups: 1,
    correctness: ["leakMisses"],
    async run() {
      maybeRunGc();
      const baselineMb = memoryUsedMb();
      const startedAt = performance.now();
      let checksum = 0;
      let payloadChars = 0;
      const heapSamples: number[] = [];
      // Held for the whole run. Records dropped at the end of each cycle leave
      // the growth envelope reading its own baseline, so a workload that
      // allocated nothing would be indistinguishable from a healthy one.
      const retained: LeakRecord[] = [];

      for (let i = 0; i < LEAK_SAMPLE_CYCLES; i += 1) {
        for (let index = 0; index < LEAK_RECORDS_PER_CYCLE; index += 1) {
          const id = `${i}-${index}`;
          // Bytes of its own, not a reference into a shared table: a record
          // that borrows its payload costs nothing to keep alive.
          const data = id.padEnd(LEAK_PAYLOAD_CHARS, "-leak-payload");
          retained.push({ id, data });
          payloadChars += data.length;
          checksum += data.charCodeAt(LEAK_PAYLOAD_CHARS - 1);
        }

        if (i % LEAK_HEAP_SAMPLE_EVERY === 0) {
          heapSamples.push(memoryUsedMb());
        }

        await spinEventLoop(0.2);
      }

      const durationMs = performance.now() - startedAt;
      maybeRunGc();
      const finalMb = memoryUsedMb();
      const peakMb = Math.max(baselineMb, finalMb, ...heapSamples);
      const memoryGrowthMb = Math.max(0, finalMb - baselineMb);
      const peakMemoryGrowthMb = Math.max(0, peakMb - baselineMb);
      const normalizedBaselineMb = normalizeBaselineMb(baselineMb);
      const memoryGrowthPct = (memoryGrowthMb / normalizedBaselineMb) * 100;

      return {
        durationMs,
        metrics: {
          memoryGrowthPct,
          memoryGrowthMb,
          peakMemoryGrowthPct: (peakMemoryGrowthMb / normalizedBaselineMb) * 100,
          peakMemoryGrowthMb,
          checksum,
          leakMisses: leakWorkloadMisses({ retained, payloadChars, heapSamples }),
        },
      };
    },
  },
  {
    id: "PERF-063",
    name: "PortBatcher Flush Allocation: Zero-Copy vs Copy",
    description:
      "The real PortBatcher's flush allocation under a 400 MiB agent-output flood, in both of the shapes production actually produces. pty-host.ts sets `owned = targets.length === 1`, so a one-window app takes mergeChunks' zero-copy fast path on every single-chunk flush and a two-window app takes the allocate-and-copy on every flush of the same bytes for both of its batchers. Minor-GC count and pause are reported per arm, so the number is what the second window costs rather than what a retired code path used to cost. Graded in BOTH directions on the merge branch, which is also the PR #4639 invariant: the one-window arm's payload must be the exact object that was written (a batcher that copies anyway scores zeroCopyMisses) and the two-window arm's payload must never be (a batcher that hands on a shared chunk for transfer would detach a node-pty slab under its sibling, and scores copyPathMisses). The reported duration is the two arms' own write-and-flush time, not the outer wall clock: fleet construction, the queue acknowledgements between batches, the GC observer's timer turns and disposal are none of them the subject. What that isolation costs is on the record rather than buried in the headline: the per-write bracketing takes two performance.now() calls per write across ~409,600 writes, and timerSampleCount, timerSampleNs and timerOverheadMs report the residual for the pair and for each arm.",
    tier: "soak",
    modes: ["nightly", "soak"],
    iterations: { nightly: 3, soak: 6 },
    warmups: 1,
    correctness: [
      "deliveryMisses",
      "zeroCopyMisses",
      "copyPathMisses",
      "immediateFlushMisses",
      "throughputFlushMisses",
      "cadenceShortfallCount",
      "batcherShortfallCount",
    ],
    async run() {
      maybeRunGc();
      // Outside every duration below: the cadence probe waits on real timers.
      // It is here because the batcher's (idle → latency → throughput)
      // scheduling runs on every write in the arms below and nothing else in
      // this scenario can see it — both arms end in a forced flush.
      const cadence = await gradeFlushCadence(await loadFlowControlModules(), 2048);

      // 32 terminals x 2 KiB is exactly PORT_BATCH_THRESHOLD_BYTES, so every
      // round ends in one synchronous flush in which each terminal holds
      // exactly ONE chunk. That is the shape the zero-copy fast path is
      // defined over, and the only shape in which the two arms differ solely
      // by `owned`.
      const terminals = 32;
      const chunkBytes = 2048;
      const roundsPerBatch = 128;
      const batches = 50;
      const spec = buildFleetSpec(terminals, { focusedId: null });
      const chunksById = new Map<string, number>();
      for (const terminal of spec.terminals) chunksById.set(terminal.id, roundsPerBatch);

      const armResult = async (windowCount: number) => {
        const fleet = await createFleet({ ...spec, windowCount } as FleetSpec);
        const restore = captureConsole();
        let accepted = 0;
        let rejected = 0;
        let ms = 0;
        let wallMs = 0;
        let timerSampleCount = 0;
        try {
          const gc = await measureMinorGc(() => {
            for (let batch = 0; batch < batches; batch += 1) {
              const flood = runFlood(fleet, {
                chunksById,
                chunkBytes,
                // Production's own rule: sole target owns the chunk.
                owned: windowCount === 1,
                // The ingestion site allocates one standalone Uint8Array per
                // chunk on both arms, so the delta is the FLUSH allocation.
                freshChunks: true,
              });
              accepted += flood.acceptedWriteCount;
              rejected += flood.rejectedWriteCount;
              ms += flood.ms;
              wallMs += flood.wallMs;
              timerSampleCount += flood.timerSampleCount;
              // Acknowledge so no watermark is ever reached: a pause on either
              // arm would put different work in the two brackets.
              ackAllQueues(fleet);
            }
          });
          return {
            gc,
            ms,
            wallMs,
            timerSampleCount,
            accepted,
            rejected,
            windowCount,
            deliveredBytes: fleet.deliveredBytes,
            reportedBytes: fleet.reportedBytes,
            deliveredChunkCount: fleet.deliveredChunkCount,
            zeroCopy: fleet.zeroCopyDeliveryCount,
            copied: fleet.copiedDeliveryCount,
            corrupt: fleet.corruptDeliveryCount,
            rawPauses: fleet.totalRawPauseCalls(),
          };
        } finally {
          restore();
          fleet.dispose();
        }
      };

      // Outside every bracket below, and reported rather than folded away:
      // runFlood isolates the subject with two performance.now() calls per
      // write, and at ~409,600 writes across the two arms that residual is
      // part of the headline whether or not anybody names it. PERF-370/371
      // report the same three terms.
      const timerOverheadNs = measureTimerOverheadNs();

      const outerStartedAt = performance.now();
      const single = await armResult(1);
      const dual = await armResult(2);
      // Kept as a metric, never as the headline. The two arms already measure
      // themselves; the outer clock additionally holds two fleet constructions,
      // 100 `ackAllQueues` sweeps, the GC observer's own timer turns and two
      // disposals, none of which is the flush allocation this prices.
      const outerWallMs = performance.now() - outerStartedAt;
      const durationMs = single.ms + dual.ms;

      const expectedWrites = terminals * roundsPerBatch * batches;
      const expectedBytes = expectedWrites * chunkBytes;

      // Bytes in must equal bytes out, on both counters, on both arms.
      let deliveryMisses = 0;
      for (const arm of [single, dual]) {
        if (arm.deliveredBytes !== expectedBytes * arm.windowCount) deliveryMisses += 1;
        if (arm.reportedBytes !== expectedBytes * arm.windowCount) deliveryMisses += 1;
        if (arm.deliveredChunkCount !== expectedWrites * arm.windowCount) deliveryMisses += 1;
        deliveryMisses += arm.corrupt;
      }

      // The merge branch, both directions. A batcher that always copies fails
      // the first; one that always transfers fails the second, which is the
      // slab-aliasing defect PR #4639 exists to prevent.
      let zeroCopyMisses = 0;
      if (single.zeroCopy !== expectedWrites) zeroCopyMisses += 1;
      zeroCopyMisses += single.copied;

      let copyPathMisses = 0;
      if (dual.copied !== expectedWrites * 2) copyPathMisses += 1;
      copyPathMisses += dual.zeroCopy;

      // Corpus validity: nothing was rejected, no watermark was reached, and
      // the GC observer actually saw the churn it exists to count.
      let batcherShortfallCount = 0;
      for (const arm of [single, dual]) {
        if (arm.accepted !== expectedWrites) batcherShortfallCount += 1;
        if (arm.rejected !== 0) batcherShortfallCount += 1;
        if (arm.rawPauses !== 0) batcherShortfallCount += 1;
        if (arm.gc.minorGcCount === 0) batcherShortfallCount += 1;
      }

      const gcRatio =
        single.gc.minorGcCount > 0 ? dual.gc.minorGcCount / single.gc.minorGcCount : 0;

      return {
        durationMs,
        metrics: {
          terminalCount: terminals,
          chunkPayloadBytes: chunkBytes,
          writtenBytes: expectedBytes,
          flushDeliveryCount: single.deliveredChunkCount + dual.deliveredChunkCount,
          minorGcCountZeroCopy: single.gc.minorGcCount,
          minorGcCountCopyPath: dual.gc.minorGcCount,
          minorGcPauseMsZeroCopy: single.gc.minorGcPauseMs,
          minorGcPauseMsCopyPath: dual.gc.minorGcPauseMs,
          zeroCopyDeliveryCount: single.zeroCopy,
          copiedDeliveryCount: dual.copied,
          copyPathGcOverheadRatio: gcRatio,
          zeroCopyArmMs: single.ms,
          copyPathArmMs: dual.ms,
          floodWallMs: single.wallMs + dual.wallMs,
          outerWallMs,
          timerSampleCount: single.timerSampleCount + dual.timerSampleCount,
          timerSampleNs: timerOverheadNs,
          timerOverheadMs: timerOverheadMsFor(
            single.timerSampleCount + dual.timerSampleCount,
            timerOverheadNs
          ),
          timerOverheadMsZeroCopy: timerOverheadMsFor(single.timerSampleCount, timerOverheadNs),
          timerOverheadMsCopyPath: timerOverheadMsFor(dual.timerSampleCount, timerOverheadNs),
          cadenceImmediateDeliveryCount: cadence.immediateDeliveryCount,
          cadenceThroughputDeliveryCount: cadence.throughputDeliveryCount,
          deliveryMisses,
          zeroCopyMisses,
          copyPathMisses,
          immediateFlushMisses: cadence.immediateFlushMisses,
          throughputFlushMisses: cadence.throughputFlushMisses,
          cadenceShortfallCount: cadence.cadenceShortfallCount,
          batcherShortfallCount,
        },
        notes:
          `${(expectedBytes / (1024 * 1024)).toFixed(0)} MiB per arm: ` +
          `${single.ms.toFixed(0)}ms and ${single.gc.minorGcCount} minor GCs ` +
          `(${single.gc.minorGcPauseMs.toFixed(1)}ms) on the one-window zero-copy path ` +
          `against ${dual.ms.toFixed(0)}ms and ${dual.gc.minorGcCount} ` +
          `(${dual.gc.minorGcPauseMs.toFixed(1)}ms) once a second window forces the ` +
          `allocate-and-copy on every flush`,
      };
    },
  },
];
