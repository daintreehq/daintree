import { performance } from "node:perf_hooks";

import type { PerfScenario, ScenarioSample } from "../types";
import {
  buildFleetSpec,
  captureConsole,
  createFleet,
  expectedDisengageOrder,
  expectedEngageOrder,
  expectedTrimOrder,
  expectedVictimSet,
  FLOODER_ID,
  FOCUSED_ID,
  GOVERNOR_LIMIT_PERCENT,
  GOVERNOR_WARMUP_TICKS,
  gradeFlushCadence,
  HEAP_BUDGET_MB,
  heldByToken,
  ipcFallbackMirrorMisses,
  ipcFallbackSequenceMisses,
  loadFlowControlModules,
  measureTimerOverheadNs,
  orderMisses,
  predictGovernorSchedule,
  runDrain,
  runFlood,
  runIpcFlood,
  setDifferenceCount,
  watermarks,
  type FleetSpec,
  type FlowControlFleet,
  type FlowObservation,
} from "../lib/ptyFlowControlFixture";

/**
 * pty-host flow control — the hottest path in the app.
 *
 * Every chunk of PTY output crosses `PortBatcher` → `PortQueueManager` →
 * `PtyPauseCoordinator` on its way to a renderer, once per window, and that
 * traversal is what decides which terminal gets paused when a fleet of agents
 * floods the host at the same moment. `ResourceGovernor` sweeps above it on a
 * 2s timer and can pause the entire fleet. PERF-045 measures the fork channel's
 * volume and says so; PERF-092/094 measure idle pollers. This decision plane
 * had no coverage.
 *
 * `lib/ptyFlowControlFixture.ts` states what is real and what is not. The
 * headline limit to carry into every reading: **these are decision durations,
 * not delivery latency.** There is no MessagePort, no renderer and no node-pty
 * here, so the transfer a real flush ends in and the read suspension a real
 * pause performs are both outside every number.
 *
 * The trap this family is built against is that **a flow controller that
 * pauses nothing is the fastest flow controller there is**, and so is one that
 * pauses everything — the second is also the one that makes the app feel dead
 * under load. So every pause decision is graded as a SET, by symmetric
 * difference against a victim set this fixture computes from its own byte
 * ledger and the shipped watermarks, and the two-sided terms are named
 * separately: the flooder must be paused, the focused quiet terminal must not.
 */

/** Realistic agent-output chunk: node-pty coalesces to a few KiB at a time. */
const CHUNK_BYTES = 2048;

/** Warmup passes; the batcher's Map growth and the merge path are JIT-sensitive. */
const WARMUPS = 1;

interface ArmGrade {
  victimSetMisses: number;
  coordinatorHoldMisses: number;
  pauseSignalMisses: number;
}

function emptyArmGrade(): ArmGrade {
  return { victimSetMisses: 0, coordinatorHoldMisses: 0, pauseSignalMisses: 0 };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function perChunkUs(ms: number, chunks: number): number {
  return chunks > 0 ? (ms * 1000) / chunks : 0;
}

/** A measurement that did not happen, reported as misses rather than thrown. */
function failClosed(notes: string, metrics: Record<string, number>): ScenarioSample {
  return { durationMs: 0, metrics, notes };
}

/** How many chunks of `chunkBytes` it takes to write `totalBytes`. */
function chunkPlanFor(chunkBytes: number, totalBytes: number): number {
  return Math.max(1, Math.ceil(totalBytes / chunkBytes));
}

// --- Shared grading ----------------------------------------------------------

/**
 * Grade one arm's pause decisions against the fixture's own arithmetic.
 *
 * Three separate accumulators, one per operation the pause path performs, so a
 * path that keeps its bookkeeping but stops reaching the PTY (or stops telling
 * the renderer) cannot hide behind the term that still passes:
 *
 *   `victimSetMisses`       — the DECISION, by symmetric difference against the
 *                             set derived from the ledger. Over-pausing and
 *                             under-pausing score equally.
 *   `coordinatorHoldMisses` — the coordinator really holds this manager's token
 *                             AND the raw PTY handle really had `pause()`
 *                             called on it, counted at the handle.
 *   `pauseSignalMisses`     — the renderer was told: one `paused-backpressure`
 *                             status past the real dedup and one `pause-start`
 *                             reliability metric per victim, no more and no
 *                             fewer.
 */
function gradeVictims(
  fleet: FlowControlFleet,
  expected: ReadonlySet<string>,
  token: string,
  statusLabel: string
): ArmGrade {
  const grade = emptyArmGrade();
  const held = heldByToken(fleet, token);
  grade.victimSetMisses = setDifferenceCount(expected, held);

  for (const id of fleet.ids) {
    const shouldPause = expected.has(id);
    const raw = fleet.rawCountsFor(id);
    if (shouldPause && raw.pauseCalls !== 1) grade.coordinatorHoldMisses += 1;
    if (!shouldPause && raw.pauseCalls !== 0) grade.coordinatorHoldMisses += 1;
  }

  const statusCounts = tally(fleet.statusEvents, statusLabel);
  const metricCounts = tally(fleet.metricEvents, "pause-start");
  for (const id of fleet.ids) {
    const want = expected.has(id) ? 1 : 0;
    if ((statusCounts.get(id) ?? 0) !== want) grade.pauseSignalMisses += 1;
    if ((metricCounts.get(id) ?? 0) !== want) grade.pauseSignalMisses += 1;
  }
  return grade;
}

function tally(events: readonly FlowObservation[], label: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.label !== label) continue;
    counts.set(event.terminalId, (counts.get(event.terminalId) ?? 0) + 1);
  }
  return counts;
}

function addArm(into: ArmGrade, arm: ArmGrade): void {
  into.victimSetMisses += arm.victimSetMisses;
  into.coordinatorHoldMisses += arm.coordinatorHoldMisses;
  into.pauseSignalMisses += arm.pauseSignalMisses;
}

/**
 * Depth read-back after every batcher has flushed: the manager's own per-
 * terminal and aggregate accounting must agree with the ledger to the byte.
 * An `addBytes` that stopped accumulating would make every watermark
 * unreachable and every arm above post its best possible number.
 */
function gradeQueueAccounting(fleet: FlowControlFleet): number {
  let misses = 0;
  for (const id of fleet.ids) {
    if (fleet.portQueue.getQueuedBytes(id) !== fleet.ledgerBytes(id)) misses += 1;
  }
  if (fleet.portQueue.getTotalQueuedBytes() !== fleet.ledgerTotal) misses += 1;
  return misses;
}

/**
 * Bytes in must equal bytes out, three ways: what the sink received, what the
 * batcher claimed it was handing over, and what this fixture wrote. Plus the
 * per-terminal marker check the sink performs on every delivery, so a merge
 * that dropped or shifted a chunk is caught even when the byte total survives.
 */
function gradeDelivery(fleet: FlowControlFleet, writtenBytes: number, windows: number): number {
  let misses = 0;
  if (fleet.deliveredBytes !== writtenBytes * windows) misses += 1;
  if (fleet.reportedBytes !== writtenBytes * windows) misses += 1;
  if (fleet.corruptDeliveryCount !== 0) misses += fleet.corruptDeliveryCount;
  if (writtenBytes > 0 && fleet.deliveredChunkCount === 0) misses += 1;
  return misses;
}

// --- PERF-370: per-terminal watermark across fleet sizes ---------------------

const DECISION_FLEET_SIZES = [4, 12, 24, 48] as const;
/** Comfortably over the 67% high watermark, comfortably under the 3 MiB cap. */
const FLOODER_BYTES = 2_400_000;
/** Far below every watermark; the pane the user is actually looking at. */
const FOCUSED_QUIET_BYTES = 64 * 1024;
/** Background agents chattering — sized so the window aggregate stays clear. */
const BACKGROUND_BYTES = 150 * 1024;

interface DecisionArm {
  size: number;
  ms: number;
  chunks: number;
}

// --- PERF-371/372: the window aggregate --------------------------------------

/** 18 MiB across the fleet, against a 16 MiB window watermark. */
const AGGREGATE_TOTAL_BYTES = 18 * 1024 * 1024;
const AGGREGATE_FLEET_SIZE = 12;
const DRAIN_FLEET_SIZES = [12, 24, 48] as const;
/** One renderer parse batch's worth of acknowledgement. */
const ACK_BYTES = 64 * 1024;

// --- PERF-373: the governor sweep --------------------------------------------

const GOVERNOR_FLEET_SIZE = 48;
/**
 * A scripted utilization ladder in percent of the process budget.
 *
 * Five ticks of calm, so the warmup gate has something to refuse; a long climb
 * at 92%, which the EMA reaches the 85% limit only part-way through — the tick
 * it crosses on is arithmetic, not a guess, and `predictGovernorSchedule`
 * names it; then a drop through the 60% resume threshold.
 */
const GOVERNOR_LADDER: readonly number[] = [
  20, 20, 20, 20, 20, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 30, 30,
];
/** Terminals put under real port-queue backpressure before the ladder runs. */
const PRE_BACKPRESSURED = 4;

export const ptyFlowControlScenarios: PerfScenario[] = [
  {
    id: "PERF-370",
    name: "PTY Flow-Control Decision Cost per Output Chunk",
    description:
      "Per-chunk cost of the real pty-host flow-control path — PortBatcher.write, its cadence machine, mergeChunks, PortQueueManager.addBytes and applyBackpressure, and PtyPauseCoordinator — across 4, 12, 24 and 48 terminals with one flooder crossing its own 67% watermark, one focused quiet terminal, and background agents kept under every gate. This runs once per output chunk per terminal per window in production and had no coverage. The clock is opened and closed around the write calls themselves, so this fixture's chunk allocation, byte ledger and counters are outside the reading. Graded as a SET rather than a tally, because a controller that pauses nothing and one that pauses everything both post excellent durations: the victim set is compared by symmetric difference against the set this fixture derives from its own byte ledger and the shipped 3 MiB / 67% constants, bytes delivered downstream must equal bytes written in on all three counters, and the flooder must be paused exactly once while every quiet terminal is paused exactly zero times. The (idle → latency → throughput) cadence machine every write runs is graded on its own probe, because the synchronous drive loop always ends in a forced flush and would otherwise pay for scheduling nothing reads back.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [
      "deliveryMisses",
      "victimSetMisses",
      "flooderPauseMisses",
      "quietTerminalMisses",
      "coordinatorHoldMisses",
      "pauseSignalMisses",
      "queueAccountingMisses",
      "immediateFlushMisses",
      "throughputFlushMisses",
      "cadenceShortfallCount",
      "floodShortfallCount",
    ],
    async run() {
      const modules = await loadFlowControlModules();
      const marks = watermarks(modules);
      // Outside every duration below: it waits on real timers by construction.
      const cadence = await gradeFlushCadence(modules, CHUNK_BYTES);
      const timerOverheadNs = measureTimerOverheadNs();

      const arms: DecisionArm[] = [];
      const total = emptyArmGrade();
      let deliveryMisses = 0;
      let queueAccountingMisses = 0;
      let flooderPauseMisses = 0;
      let quietTerminalMisses = 0;
      let shortfall = 0;
      let totalMs = 0;
      let totalWallMs = 0;
      let timerSampleCount = 0;
      let chunkCount = 0;
      let writtenBytes = 0;
      let logCount = 0;

      for (const size of DECISION_FLEET_SIZES) {
        const spec = buildFleetSpec(size);
        const fleet = await createFleet(spec);
        const chunksById = new Map<string, number>();
        for (const terminal of spec.terminals) {
          const bytes =
            terminal.id === FLOODER_ID
              ? FLOODER_BYTES
              : terminal.id === FOCUSED_ID
                ? FOCUSED_QUIET_BYTES
                : BACKGROUND_BYTES;
          chunksById.set(terminal.id, chunkPlanFor(CHUNK_BYTES, bytes));
        }

        const restore = captureConsole();
        let flood;
        try {
          flood = runFlood(fleet, {
            chunksById,
            chunkBytes: CHUNK_BYTES,
            owned: true,
            freshChunks: false,
          });
        } finally {
          logCount += restore();
        }

        // Corpus validity, checked before the decision is graded: this arm
        // exists to exercise the PER-TERMINAL gate, so a run whose aggregate
        // reached the window watermark would be grading a different branch,
        // and one whose flooder never reached its own watermark would be
        // grading nothing at all.
        if (flood.rejectedWriteCount !== 0) shortfall += 1;
        if (fleet.ledgerTotal >= marks.totalHighWatermarkBytes) shortfall += 1;
        if (fleet.ledgerBytes(FLOODER_ID) < marks.highWatermarkBytes) shortfall += 1;
        if (fleet.ledgerBytes(FOCUSED_ID) >= marks.lowWatermarkBytes) shortfall += 1;

        const expected = expectedVictimSet({
          ids: fleet.ids,
          ownBytes: (id) => fleet.ledgerBytes(id),
          totalBytes: fleet.ledgerTotal,
          focusedId: fleet.focused,
          focusExempt: true,
          marks,
        });
        addArm(total, gradeVictims(fleet, expected, "port-queue", "paused-backpressure"));
        deliveryMisses += gradeDelivery(fleet, fleet.ledgerTotal, 1);
        queueAccountingMisses += gradeQueueAccounting(fleet);

        // The two-sided reading, stated on its own so it is legible in the
        // report: the flooder pauses, the quiet terminals never do.
        if (fleet.rawCountsFor(FLOODER_ID).pauseCalls !== 1) flooderPauseMisses += 1;
        for (const id of fleet.ids) {
          if (id === FLOODER_ID) continue;
          if (fleet.rawCountsFor(id).pauseCalls !== 0) quietTerminalMisses += 1;
        }

        arms.push({ size, ms: flood.ms, chunks: flood.acceptedWriteCount });
        totalMs += flood.ms;
        totalWallMs += flood.wallMs;
        timerSampleCount += flood.timerSampleCount;
        chunkCount += flood.acceptedWriteCount;
        writtenBytes += fleet.ledgerTotal;
        fleet.dispose();
      }

      const small = arms[0];
      const large = arms[arms.length - 1];
      if (small === undefined || large === undefined) {
        return failClosed("no fleet size ran", {
          deliveryMisses: 1,
          victimSetMisses: 1,
          flooderPauseMisses: 1,
          quietTerminalMisses: 0,
          coordinatorHoldMisses: 1,
          pauseSignalMisses: 1,
          queueAccountingMisses: 1,
          immediateFlushMisses: cadence.immediateFlushMisses,
          throughputFlushMisses: cadence.throughputFlushMisses,
          cadenceShortfallCount: cadence.cadenceShortfallCount,
          floodShortfallCount: DECISION_FLEET_SIZES.length,
        });
      }

      const smallUs = perChunkUs(small.ms, small.chunks);
      const largeUs = perChunkUs(large.ms, large.chunks);

      return {
        durationMs: totalMs,
        metrics: {
          fleetSizeCount: DECISION_FLEET_SIZES.length,
          chunkCount,
          writtenBytes,
          chunkPayloadBytes: CHUNK_BYTES,
          perChunkUsAt4: perChunkUs(arms[0]?.ms ?? 0, arms[0]?.chunks ?? 0),
          perChunkUsAt12: perChunkUs(arms[1]?.ms ?? 0, arms[1]?.chunks ?? 0),
          perChunkUsAt24: perChunkUs(arms[2]?.ms ?? 0, arms[2]?.chunks ?? 0),
          perChunkUsAt48: perChunkUs(arms[3]?.ms ?? 0, arms[3]?.chunks ?? 0),
          fleetScalingOverheadRatio: ratio(largeUs, smallUs),
          // What the fixture's own chunk allocation, ledger and counters cost
          // around the subject. Reported so the exclusion is auditable rather
          // than asserted.
          floodWallMs: totalWallMs,
          fixtureOverheadRatio: ratio(totalWallMs, totalMs),
          // What that isolation costs in clock reads. Two samples per bracketed
          // write, each carrying about one call's overhead, so this is the
          // residual a reader should subtract from the per-chunk figures.
          timerSampleCount,
          timerSampleNs: timerOverheadNs,
          timerOverheadMs: (timerSampleCount / 2) * (timerOverheadNs / 1e6),
          cadenceImmediateDeliveryCount: cadence.immediateDeliveryCount,
          cadenceThroughputDeliveryCount: cadence.throughputDeliveryCount,
          cadenceWaitedMs: cadence.waitedMs,
          suppressedLogCount: logCount,
          deliveryMisses,
          queueAccountingMisses,
          flooderPauseMisses,
          quietTerminalMisses,
          immediateFlushMisses: cadence.immediateFlushMisses,
          throughputFlushMisses: cadence.throughputFlushMisses,
          cadenceShortfallCount: cadence.cadenceShortfallCount,
          floodShortfallCount: shortfall,
          victimSetMisses: total.victimSetMisses,
          coordinatorHoldMisses: total.coordinatorHoldMisses,
          pauseSignalMisses: total.pauseSignalMisses,
        },
        notes: `per-chunk decision cost ${smallUs.toFixed(2)}us at 4 terminals, ${largeUs.toFixed(2)}us at 48 (${ratio(largeUs, smallUs).toFixed(2)}x)`,
      };
    },
  },
  {
    id: "PERF-371",
    name: "Window Aggregate Watermark and the Focused-Terminal Exemption",
    description:
      "The window-level gate: 18 MiB of agent output across 12 terminals, none of them over its own 3 MiB queue, against the real 16 MiB IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES. Three arms on one pass. The port path WITH a focused terminal must pause every sibling and exempt the focused pane; the same flood with no terminal focused must pause all twelve, which is what proves the exemption is the focus and not something else about that terminal; and the IPC fallback path — whose IpcQueueDeps has no focused-terminal member at all — must pause all twelve including the focused one. Every arm's victim set is compared by symmetric difference against the set derived from this fixture's own ledger, so pausing nothing and pausing everything are separately caught, and the third arm records a real product asymmetry rather than asserting the two paths agree. The fallback arm cannot import its orchestration — pty-host.ts exports nothing and refuses to evaluate outside a UtilityProcess — so the call sequence is mirrored here and the mirror is graded in both directions. ipcFallbackMirrorMisses is the term that matters: the sequence the fixture ACTUALLY executes is recorded as the mirror enters each ipcQueueManager member, then compared per branch against the accept and drop paths parsed out of the host's own source, so a reordered or dropped step in the fixture scores rather than passing. ipcFallbackSequenceMisses sits beside it and pins that same source against the declared constant.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [
      "deliveryMisses",
      "victimSetMisses",
      "focusExemptionMisses",
      "focusControlMisses",
      "ipcPathMisses",
      "ipcFallbackSequenceMisses",
      "ipcFallbackMirrorMisses",
      "coordinatorHoldMisses",
      "pauseSignalMisses",
      "immediateFlushMisses",
      "throughputFlushMisses",
      "cadenceShortfallCount",
      "aggregateShortfallCount",
    ],
    async run() {
      const modules = await loadFlowControlModules();
      const marks = watermarks(modules);
      const cadence = await gradeFlushCadence(modules, CHUNK_BYTES);
      const timerOverheadNs = measureTimerOverheadNs();
      // Read off `pty-host.ts` itself, outside every bracket below.
      const fallbackSequenceMisses = ipcFallbackSequenceMisses();
      // What runIpcFlood ACTUALLY calls, against the branch it mirrors.
      const fallbackMirrorMisses = ipcFallbackMirrorMisses();
      const perTerminalBytes = Math.floor(AGGREGATE_TOTAL_BYTES / AGGREGATE_FLEET_SIZE);
      const chunksPerTerminal = chunkPlanFor(CHUNK_BYTES, perTerminalBytes);

      const total = emptyArmGrade();
      let shortfall = 0;
      let deliveryMisses = 0;
      let focusExemptionMisses = 0;
      let focusControlMisses = 0;
      let ipcPathMisses = 0;
      let totalMs = 0;
      let totalWallMs = 0;
      let timerSampleCount = 0;
      let logCount = 0;
      let portArmMs = 0;
      let ipcArmMs = 0;
      let chunkCount = 0;

      // Every terminal must sit UNDER its own watermark, so the only trigger
      // available is the aggregate one. If that stops being true the scenario
      // is grading the per-terminal gate again and says so.
      if (perTerminalBytes >= marks.highWatermarkBytes) shortfall += 1;
      if (AGGREGATE_TOTAL_BYTES <= marks.totalHighWatermarkBytes) shortfall += 1;

      const buildPlan = (spec: FleetSpec): Map<string, number> => {
        const plan = new Map<string, number>();
        for (const terminal of spec.terminals) plan.set(terminal.id, chunksPerTerminal);
        return plan;
      };

      // Every terminal writes one more chunk with a forced flush once the
      // aggregate is over the line, so each one's applyBackpressure is
      // guaranteed to have run at least once while the window was over its
      // watermark. Without it the terminals serviced early in the crossing
      // flush would be a race rather than an expectation.
      const settlePlan = (spec: FleetSpec): Map<string, number> => {
        const plan = new Map<string, number>();
        for (const terminal of spec.terminals) plan.set(terminal.id, 1);
        return plan;
      };

      const drivePortArm = async (focusedId: string | null): Promise<FlowControlFleet> => {
        const spec = buildFleetSpec(AGGREGATE_FLEET_SIZE, { focusedId });
        const fleet = await createFleet(spec);
        const restore = captureConsole();
        try {
          const flood = runFlood(fleet, {
            chunksById: buildPlan(spec),
            chunkBytes: CHUNK_BYTES,
            owned: true,
            freshChunks: false,
          });
          portArmMs += flood.ms;
          totalMs += flood.ms;
          totalWallMs += flood.wallMs;
          timerSampleCount += flood.timerSampleCount;
          chunkCount += flood.acceptedWriteCount;
          if (flood.rejectedWriteCount !== 0) shortfall += 1;
          const settle = runFlood(fleet, {
            chunksById: settlePlan(spec),
            chunkBytes: CHUNK_BYTES,
            owned: true,
            freshChunks: false,
            flushEveryWrite: true,
          });
          totalMs += settle.ms;
          totalWallMs += settle.wallMs;
          timerSampleCount += settle.timerSampleCount;
        } finally {
          logCount += restore();
        }
        return fleet;
      };

      // Arm A — the shipped configuration: a focused pane under a fleet burst.
      const focusedFleet = await drivePortArm(FOCUSED_ID);
      const focusedExpected = expectedVictimSet({
        ids: focusedFleet.ids,
        ownBytes: (id) => focusedFleet.ledgerBytes(id),
        totalBytes: focusedFleet.ledgerTotal,
        focusedId: FOCUSED_ID,
        focusExempt: true,
        marks,
      });
      addArm(
        total,
        gradeVictims(focusedFleet, focusedExpected, "port-queue", "paused-backpressure")
      );
      deliveryMisses += gradeDelivery(focusedFleet, focusedFleet.ledgerTotal, 1);
      if (focusedFleet.rawCountsFor(FOCUSED_ID).pauseCalls !== 0) focusExemptionMisses += 1;
      if (focusedFleet.portQueue.isPaused(FOCUSED_ID)) focusExemptionMisses += 1;
      if (focusedExpected.size !== AGGREGATE_FLEET_SIZE - 1) shortfall += 1;
      if (focusedFleet.ledgerTotal < marks.totalHighWatermarkBytes) shortfall += 1;
      focusedFleet.dispose();

      // Arm B — the control. Same fleet, same bytes, nothing focused. The one
      // terminal exempted above must now be paused like every other, which is
      // what makes arm A's exemption attributable to the focus.
      const controlFleet = await drivePortArm(null);
      const controlExpected = expectedVictimSet({
        ids: controlFleet.ids,
        ownBytes: (id) => controlFleet.ledgerBytes(id),
        totalBytes: controlFleet.ledgerTotal,
        focusedId: null,
        focusExempt: true,
        marks,
      });
      addArm(
        total,
        gradeVictims(controlFleet, controlExpected, "port-queue", "paused-backpressure")
      );
      deliveryMisses += gradeDelivery(controlFleet, controlFleet.ledgerTotal, 1);
      if (controlFleet.rawCountsFor(FOCUSED_ID).pauseCalls !== 1) focusControlMisses += 1;
      if (!controlFleet.portQueue.isPaused(FOCUSED_ID)) focusControlMisses += 1;
      if (controlExpected.size !== AGGREGATE_FLEET_SIZE) shortfall += 1;
      controlFleet.dispose();

      // Arm C — the IPC fallback, driven the way pty-host.ts drives it. This
      // path has no focused-terminal dep, so the focused pane is NOT exempt:
      // a product asymmetry, recorded rather than smoothed over.
      const ipcSpec = buildFleetSpec(AGGREGATE_FLEET_SIZE, { focusedId: FOCUSED_ID });
      const ipcFleet = await createFleet(ipcSpec);
      const restoreIpc = captureConsole();
      try {
        const flood = runIpcFlood(ipcFleet, {
          chunksById: buildPlan(ipcSpec),
          chunkBytes: CHUNK_BYTES,
          owned: false,
          freshChunks: false,
        });
        ipcArmMs += flood.ms;
        totalMs += flood.ms;
        totalWallMs += flood.wallMs;
        timerSampleCount += flood.timerSampleCount;
        chunkCount += flood.acceptedWriteCount;
        if (flood.rejectedWriteCount !== 0) shortfall += 1;
      } finally {
        logCount += restoreIpc();
      }
      const ipcExpected = expectedVictimSet({
        ids: ipcFleet.ids,
        ownBytes: (id) => ipcFleet.ledgerBytes(id),
        totalBytes: ipcFleet.ledgerTotal,
        focusedId: FOCUSED_ID,
        focusExempt: false,
        marks,
      });
      addArm(total, gradeVictims(ipcFleet, ipcExpected, "ipc-queue", "paused-backpressure"));
      if (ipcFleet.rawCountsFor(FOCUSED_ID).pauseCalls !== 1) ipcPathMisses += 1;
      if (!ipcFleet.ipcQueue.isPaused(FOCUSED_ID)) ipcPathMisses += 1;
      if (ipcExpected.size !== AGGREGATE_FLEET_SIZE) shortfall += 1;
      ipcFleet.dispose();

      return {
        durationMs: totalMs,
        metrics: {
          fleetSize: AGGREGATE_FLEET_SIZE,
          chunkCount,
          aggregateWatermarkBytes: marks.totalHighWatermarkBytes,
          perTerminalQueueBytes: perTerminalBytes,
          perChunkUsPort: perChunkUs(portArmMs, chunksPerTerminal * AGGREGATE_FLEET_SIZE * 2),
          perChunkUsIpcFallback: perChunkUs(ipcArmMs, chunksPerTerminal * AGGREGATE_FLEET_SIZE),
          cadenceImmediateDeliveryCount: cadence.immediateDeliveryCount,
          cadenceThroughputDeliveryCount: cadence.throughputDeliveryCount,
          floodWallMs: totalWallMs,
          fixtureOverheadRatio: ratio(totalWallMs, totalMs),
          timerSampleCount,
          timerSampleNs: timerOverheadNs,
          timerOverheadMs: (timerSampleCount / 2) * (timerOverheadNs / 1e6),
          suppressedLogCount: logCount,
          deliveryMisses,
          focusExemptionMisses,
          focusControlMisses,
          ipcPathMisses,
          ipcFallbackSequenceMisses: fallbackSequenceMisses,
          ipcFallbackMirrorMisses: fallbackMirrorMisses,
          immediateFlushMisses: cadence.immediateFlushMisses,
          throughputFlushMisses: cadence.throughputFlushMisses,
          cadenceShortfallCount: cadence.cadenceShortfallCount,
          aggregateShortfallCount: shortfall,
          victimSetMisses: total.victimSetMisses,
          coordinatorHoldMisses: total.coordinatorHoldMisses,
          pauseSignalMisses: total.pauseSignalMisses,
        },
        notes: `focused pane exempt on the port path, paused on the IPC fallback (${AGGREGATE_FLEET_SIZE - 1} vs ${AGGREGATE_FLEET_SIZE} victims over the same 18 MiB)`,
      };
    },
  },
  {
    id: "PERF-372",
    name: "Aggregate Drain and the Resume Sweep",
    description:
      "What a paused fleet costs to let go of. 18 MiB is queued across 12, 24 and 48 terminals until the window aggregate has paused every one of them, then acknowledged back in 64 KiB renderer-parse batches. The single ack that takes the aggregate below its 8 MiB low watermark is timed on its own, because that ack — and no other — pays for sweepAggregateResume's fan-out over every paused terminal, so the reading is how the recovery sweep scales with fleet size rather than an average that buries it. Graded against the fixture's ledger at the instant of each emission: every paused terminal must resume, none may resume while the fixture's own arithmetic says the aggregate was still over the low watermark, the focused terminal must be the first one released, and the manager's per-terminal and aggregate depths must track the ledger to the byte on every one of the ~1,700 acks.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [
      "resumeMisses",
      "prematureResumeMisses",
      "focusFirstResumeMisses",
      "queueAccountingMisses",
      "coordinatorHoldMisses",
      "sweepShortfallCount",
    ],
    async run() {
      const modules = await loadFlowControlModules();
      const marks = watermarks(modules);

      let totalMs = 0;
      let ackCount = 0;
      let resumeMisses = 0;
      let prematureResumeMisses = 0;
      let focusFirstResumeMisses = 0;
      let queueAccountingMisses = 0;
      let coordinatorHoldMisses = 0;
      let shortfall = 0;
      let logCount = 0;
      const sweepUsBySize = new Map<number, number>();
      const plainUsBySize = new Map<number, number>();

      for (const size of DRAIN_FLEET_SIZES) {
        const perTerminalBytes = Math.floor(AGGREGATE_TOTAL_BYTES / size);
        if (perTerminalBytes >= marks.highWatermarkBytes) shortfall += 1;
        // Nothing focused during the flood, so the aggregate gate pauses the
        // WHOLE fleet — the state the resume sweep exists to unwind.
        const spec = buildFleetSpec(size, { focusedId: null });
        const fleet = await createFleet(spec);
        const chunksById = new Map<string, number>();
        for (const terminal of spec.terminals) {
          chunksById.set(terminal.id, chunkPlanFor(CHUNK_BYTES, perTerminalBytes));
        }

        const restore = captureConsole();
        let drain;
        let pausedAtFloodEnd: Set<string>;
        let metricCursor = 0;
        try {
          runFlood(fleet, {
            chunksById,
            chunkBytes: CHUNK_BYTES,
            owned: true,
            freshChunks: false,
          });
          runFlood(fleet, {
            chunksById: new Map(spec.terminals.map((terminal) => [terminal.id, 1])),
            chunkBytes: CHUNK_BYTES,
            owned: true,
            freshChunks: false,
            flushEveryWrite: true,
          });
          pausedAtFloodEnd = heldByToken(fleet, "port-queue");
          metricCursor = fleet.metricEvents.length;
          // The pane the user is watching is focused for the recovery, so the
          // sweep's focused-first ordering has something to order.
          fleet.setFocusedId(FOCUSED_ID);
          drain = runDrain(fleet, fleet.ids, ACK_BYTES, marks.totalLowWatermarkBytes);
        } finally {
          logCount += restore();
        }

        // Corpus validity: the flood must really have paused the entire fleet,
        // and the drain must really have crossed the low watermark once.
        if (pausedAtFloodEnd.size !== size) shortfall += 1;
        if (drain.sweepAckCount !== 1) shortfall += 1;
        if (fleet.ledgerTotal !== 0) shortfall += 1;

        // Every terminal the flood paused must have been released, at the raw
        // PTY handle and not merely in the manager's bookkeeping.
        const stillHeld = heldByToken(fleet, "port-queue");
        resumeMisses += stillHeld.size;
        for (const id of pausedAtFloodEnd) {
          const raw = fleet.rawCountsFor(id);
          if (raw.resumeCalls !== raw.pauseCalls) coordinatorHoldMisses += 1;
        }

        const resumes = fleet.metricEvents
          .slice(metricCursor)
          .filter((event) => event.label === "pause-end");
        const resumedIds = new Set(resumes.map((event) => event.terminalId));
        resumeMisses += setDifferenceCount(pausedAtFloodEnd, resumedIds);

        // The independent half: a resume is only correct if the queue really
        // was below its watermarks when it fired, and the fixture knows that
        // from the bytes it wrote and acked. A manager that released the fleet
        // on the first ack would drain far faster and score here.
        for (const event of resumes) {
          if (event.ledgerTotalBytes >= marks.totalLowWatermarkBytes) prematureResumeMisses += 1;
          if (event.ledgerOwnBytes >= marks.lowWatermarkBytes) prematureResumeMisses += 1;
        }

        const first = resumes[0];
        if (first === undefined || first.terminalId !== FOCUSED_ID) focusFirstResumeMisses += 1;

        queueAccountingMisses += drain.accountingMisses;
        queueAccountingMisses += gradeQueueAccounting(fleet);

        sweepUsBySize.set(size, drain.sweepAckMs * 1000);
        plainUsBySize.set(
          size,
          drain.plainAckCount > 0 ? (drain.plainAckMs * 1000) / drain.plainAckCount : 0
        );
        totalMs += drain.ms;
        ackCount += drain.ackCount;
        fleet.dispose();
      }

      const smallSweep = sweepUsBySize.get(DRAIN_FLEET_SIZES[0]) ?? 0;
      const largeSweep = sweepUsBySize.get(DRAIN_FLEET_SIZES[DRAIN_FLEET_SIZES.length - 1]) ?? 0;

      return {
        durationMs: totalMs,
        metrics: {
          fleetSizeCount: DRAIN_FLEET_SIZES.length,
          ackCount,
          ackPayloadBytes: ACK_BYTES,
          lowWatermarkBytes: marks.totalLowWatermarkBytes,
          sweepAckUsAt12: sweepUsBySize.get(12) ?? 0,
          sweepAckUsAt24: sweepUsBySize.get(24) ?? 0,
          sweepAckUsAt48: sweepUsBySize.get(48) ?? 0,
          plainAckUsAt48: plainUsBySize.get(48) ?? 0,
          sweepScalingOverheadRatio: ratio(largeSweep, smallSweep),
          suppressedLogCount: logCount,
          resumeMisses,
          prematureResumeMisses,
          focusFirstResumeMisses,
          queueAccountingMisses,
          coordinatorHoldMisses,
          sweepShortfallCount: shortfall,
        },
        notes: `the one ack that crosses the low watermark costs ${largeSweep.toFixed(1)}us at 48 terminals against ${(plainUsBySize.get(48) ?? 0).toFixed(2)}us for an ordinary ack`,
      };
    },
  },
  {
    id: "PERF-373",
    name: "ResourceGovernor Sweep and Pause/Resume Triage",
    description:
      "The 2s fleet-wide sweep, driven through the same entry point its interval callback uses, over 48 terminals with loaded queues and four already under port-queue backpressure. A 23-tick utilization ladder climbs from calm through sustained 92% and back below the resume threshold, with the signal delivered through the analysis-worker memory term so the reading is scripted rather than dependent on this process's own heap. The whole schedule is predicted by arithmetic first: the EMA the governor must arrive at on every tick, the exact tick its smoothed signal first clears the 85% limit, the one-shot trim that must precede the pause by exactly one tick, and the tick the pause must be released on. A governor that pauses on tick one fails the warmup term, one that never pauses fails every engage term, and one that thresholds the raw reading instead of the EMA crosses several ticks early and fails both. Pause and resume ORDER are graded against the idle-first / agent-last triage recomputed from the fixture's own activity table, and the four backpressured terminals must come back as paused-backpressure rather than running.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [
      "smoothingMisses",
      "engageScheduleMisses",
      "trimScheduleMisses",
      "pauseOrderMisses",
      "resumeOrderMisses",
      "coordinatorHoldMisses",
      "backpressureRestoreMisses",
      "gaugeMisses",
      "governorShortfallCount",
    ],
    async run() {
      const modules = await loadFlowControlModules();
      const marks = watermarks(modules);
      const spec = buildFleetSpec(GOVERNOR_FLEET_SIZE, { focusedId: null, withGovernor: true });
      const fleet = await createFleet(spec);
      const governor = fleet.governor;
      if (governor === null) {
        fleet.dispose();
        return failClosed("the governor was not constructed", {
          smoothingMisses: GOVERNOR_LADDER.length,
          engageScheduleMisses: GOVERNOR_LADDER.length,
          trimScheduleMisses: 1,
          pauseOrderMisses: GOVERNOR_FLEET_SIZE,
          resumeOrderMisses: GOVERNOR_FLEET_SIZE,
          coordinatorHoldMisses: GOVERNOR_FLEET_SIZE,
          backpressureRestoreMisses: PRE_BACKPRESSURED,
          gaugeMisses: GOVERNOR_LADDER.length,
          governorShortfallCount: 1,
        });
      }

      const prediction = predictGovernorSchedule(GOVERNOR_LADDER, true);
      let shortfall = 0;

      const setupRestore = captureConsole();
      let backpressuredIds: string[] = [];
      try {
        // Load every queue so the pending-bytes, throughput and queue-depth
        // gauges have something to report — a sweep over empty queues skips
        // most of its own work and is not the sweep production runs.
        const chunksById = new Map<string, number>();
        for (const terminal of spec.terminals) {
          chunksById.set(terminal.id, chunkPlanFor(CHUNK_BYTES, 128 * 1024));
        }
        runFlood(fleet, { chunksById, chunkBytes: CHUNK_BYTES, owned: true, freshChunks: false });

        // Four terminals pushed over their own watermark, so the disengage path
        // has terminals whose backpressure hold must SURVIVE the governor's
        // resume — the branch that restores "paused-backpressure" instead of
        // reporting them running.
        backpressuredIds = fleet.ids.slice(0, PRE_BACKPRESSURED);
        const heavy = new Map<string, number>();
        for (const id of backpressuredIds) {
          heavy.set(id, chunkPlanFor(CHUNK_BYTES, Math.ceil(marks.highWatermarkBytes)));
        }
        runFlood(fleet, {
          chunksById: heavy,
          chunkBytes: CHUNK_BYTES,
          owned: true,
          freshChunks: false,
          flushEveryWrite: true,
        });
      } finally {
        setupRestore();
      }

      const heldBefore = heldByToken(fleet, "port-queue");
      if (heldBefore.size !== PRE_BACKPRESSURED) shortfall += 1;
      if (!modules.metricsEnabled) shortfall += 1;

      const statusCursor = fleet.statusEvents.length;
      const metricCursor = fleet.metricEvents.length;

      const observedSmoothed: number[] = [];
      const observedThrottling: boolean[] = [];
      const dropSnapshotsPerTick: number[] = [];
      const terminalCountCallsPerTick: number[] = [];
      const pauseGaugePerTick: number[] = [];
      const pausedBeforeTick: boolean[] = [];

      const restore = captureConsole();
      let sweepMs = 0;
      try {
        for (const percent of GOVERNOR_LADDER) {
          fleet.setWorkerHeapMb((percent / 100) * HEAP_BUDGET_MB);
          // Corpus validity: the scripted term must be the governor's binding
          // constraint, or the predicted series stops describing what it saw.
          if (!fleet.workerTermDominates()) shortfall += 1;
          pausedBeforeTick.push(fleet.ids.some((id) => fleet.coordinator(id)?.isPaused === true));
          const dropsBefore = fleet.governorDropSnapshotCalls;
          const countsBefore = fleet.governorTerminalCountCalls;
          const gaugeBefore = fleet.metricEvents.length;
          const at = performance.now();
          fleet.tickGovernor();
          sweepMs += performance.now() - at;
          dropSnapshotsPerTick.push(fleet.governorDropSnapshotCalls - dropsBefore);
          terminalCountCallsPerTick.push(fleet.governorTerminalCountCalls - countsBefore);
          pauseGaugePerTick.push(
            fleet.metricEvents
              .slice(gaugeBefore)
              .filter((event) => event.label === "pause-duration-gauge").length
          );
          const snapshot = governor.getSnapshot();
          observedSmoothed.push(snapshot.smoothedUtilizationPercent ?? Number.NaN);
          observedThrottling.push(snapshot.isThrottling);
        }
      } finally {
        restore();
      }

      // --- The EMA itself. A governor that thresholds the raw reading, or
      // seeds its average at zero, lands on a different series entirely.
      let smoothingMisses = 0;
      prediction.smoothed.forEach((expected, tick) => {
        const observed = observedSmoothed[tick];
        if (observed === undefined || !Number.isFinite(observed)) {
          smoothingMisses += 1;
          return;
        }
        if (Math.abs(observed - expected) > 1e-6) smoothingMisses += 1;
      });

      // --- The engage/disengage schedule, tick by tick.
      let engageScheduleMisses = 0;
      prediction.throttling.forEach((expected, tick) => {
        if (observedThrottling[tick] !== expected) engageScheduleMisses += 1;
      });

      // --- The one-shot trim, and what it asked for.
      const expectedTrims = expectedTrimOrder(spec);
      let trimScheduleMisses = Math.abs(fleet.trimRequests.length - prediction.trimTicks.length);
      trimScheduleMisses += fleet.uniformTrimCount;
      for (const request of fleet.trimRequests) {
        trimScheduleMisses += orderMisses(expectedTrims, request);
      }

      const statusEvents = fleet.statusEvents.slice(statusCursor);
      const pauseOrder = statusEvents
        .filter((event) => event.label === "paused-resource-governor")
        .map((event) => event.terminalId);
      const pauseOrderMisses = orderMisses(expectedEngageOrder(spec), pauseOrder);

      // Resume order is read off the release emissions, whichever branch each
      // terminal took — a backpressured terminal is released in the same sweep
      // and in the same position, it just wears a different status.
      const resumeOrder = statusEvents
        .filter((event) => event.label === "running" || event.label === "paused-backpressure")
        .map((event) => event.terminalId);
      const resumeOrderMisses = orderMisses(expectedDisengageOrder(spec), resumeOrder);

      // --- The holds themselves, at the raw PTY handle.
      let coordinatorHoldMisses = 0;
      const heldAfter = heldByToken(fleet, "resource-governor");
      coordinatorHoldMisses += heldAfter.size;
      for (const id of fleet.ids) {
        const raw = fleet.rawCountsFor(id);
        if (raw.pauseCalls < 1) coordinatorHoldMisses += 1;
        // Backpressured terminals keep their own hold, so the raw handle is
        // still suspended; every other terminal must be running again.
        const stillBackpressured = heldBefore.has(id);
        const coordinator = fleet.coordinator(id);
        if (coordinator === undefined) {
          coordinatorHoldMisses += 1;
        } else if (coordinator.isPaused !== stillBackpressured) {
          coordinatorHoldMisses += 1;
        }
      }
      if (
        fleet.governorReportedPauseCount !==
        GOVERNOR_FLEET_SIZE * prediction.engageTicks.length
      ) {
        coordinatorHoldMisses += 1;
      }

      // --- The disengage branch, both directions on one pass.
      let backpressureRestoreMisses = 0;
      const restored = new Set(
        statusEvents
          .filter((event) => event.label === "paused-backpressure")
          .map((event) => event.terminalId)
      );
      const running = new Set(
        statusEvents.filter((event) => event.label === "running").map((event) => event.terminalId)
      );
      backpressureRestoreMisses += setDifferenceCount(heldBefore, restored);
      for (const id of running) {
        if (heldBefore.has(id)) backpressureRestoreMisses += 1;
      }

      // --- The gauges. Two ungated readings (the drop counter is drained on
      // every tick regardless of the metrics gate; the pause-duration gauge is
      // load-bearing for the renderer's held-duration tooltip) plus the FD
      // sweep's terminal-count read, which only runs where FD monitoring is
      // supported.
      const fdSupported = process.platform === "darwin" || process.platform === "linux";
      let gaugeMisses = 0;
      dropSnapshotsPerTick.forEach((count) => {
        if (count !== 1) gaugeMisses += 1;
      });
      terminalCountCallsPerTick.forEach((count) => {
        if (count !== (fdSupported ? 1 : 0)) gaugeMisses += 1;
      });
      pauseGaugePerTick.forEach((count, tick) => {
        if (count !== (pausedBeforeTick[tick] === true ? 1 : 0)) gaugeMisses += 1;
      });

      const gaugeEvents = fleet.metricEvents.slice(metricCursor);
      const throughputGauges = gaugeEvents.filter(
        (event) => event.label === "throughput-rate"
      ).length;
      const queueDepthGauges = gaugeEvents.filter(
        (event) => event.label === "queue-depth-gauge"
      ).length;
      const bufferGauges = gaugeEvents.filter(
        (event) => event.label === "buffer-memory-gauge"
      ).length;
      // The first throughput snapshot seeds the baseline without emitting.
      if (throughputGauges !== GOVERNOR_LADDER.length - 1) gaugeMisses += 1;
      if (queueDepthGauges !== GOVERNOR_LADDER.length) gaugeMisses += 1;
      if (bufferGauges === 0) gaugeMisses += 1;

      if (prediction.engageTicks.length !== 1) shortfall += 1;
      if (prediction.trimTicks.length !== 1) shortfall += 1;
      if (prediction.disengageTicks.length !== 1) shortfall += 1;
      const firstEngage = prediction.engageTicks[0];
      if (firstEngage === undefined || firstEngage < GOVERNOR_WARMUP_TICKS) shortfall += 1;

      const ticks = GOVERNOR_LADDER.length;
      fleet.dispose();

      return {
        durationMs: sweepMs,
        metrics: {
          fleetSize: GOVERNOR_FLEET_SIZE,
          tickCount: ticks,
          gaugeEventCount: gaugeEvents.length,
          ticksBeforeEngageCount: firstEngage ?? -1,
          limitPercent: GOVERNOR_LIMIT_PERCENT,
          perSweepUs: (sweepMs * 1000) / ticks,
          smoothingMisses,
          engageScheduleMisses,
          trimScheduleMisses,
          pauseOrderMisses,
          resumeOrderMisses,
          coordinatorHoldMisses,
          backpressureRestoreMisses,
          gaugeMisses,
          governorShortfallCount: shortfall,
        },
        notes: `one sweep over ${GOVERNOR_FLEET_SIZE} terminals costs ${((sweepMs * 1000) / ticks).toFixed(1)}us; the EMA reaches the ${GOVERNOR_LIMIT_PERCENT}% limit on tick ${firstEngage ?? -1} of ${ticks}`,
      };
    },
  },
];
