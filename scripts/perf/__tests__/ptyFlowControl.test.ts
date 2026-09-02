import { describe, expect, it } from "vitest";
import { isTimingDependent } from "./timingDependentTerms";

import { ptyFlowControlScenarios } from "../scenarios/ptyFlowControl";
import { soakScenarios } from "../scenarios/soak";
import {
  buildFleetSpec,
  expectedDisengageOrder,
  expectedEngageOrder,
  expectedTrimOrder,
  expectedVictimSet,
  extractIpcFallbackSequence,
  extractIpcFallbackSequences,
  FOCUSED_ID,
  gradeFlushCadence,
  ipcFallbackMirrorMisses,
  ipcFallbackMirrorMissesIn,
  ipcFallbackSequenceMisses,
  ipcFallbackSequenceMissesIn,
  observeIpcFallbackSequences,
  IPC_FALLBACK_HOST_SEQUENCE,
  loadFlowControlModules,
  measureTimerOverheadNs,
  orderMisses,
  predictGovernorSchedule,
  setDifferenceCount,
  watermarks,
  type WatermarkConstants,
} from "../lib/ptyFlowControlFixture";
import type { PerfScenario, ScenarioContext } from "../types";

const context: ScenarioContext = { mode: "smoke", now: () => performance.now() };

function scenario(id: string): PerfScenario {
  const found = [...ptyFlowControlScenarios, ...soakScenarios].find(
    (candidate) => candidate.id === id
  );
  expect(found, `${id} is not registered`).toBeDefined();
  return found as PerfScenario;
}

/**
 * Every predicate must be emitted on EVERY run and read zero on a healthy one.
 * `MetricStat.count` tallies emitting iterations rather than runs, so a
 * predicate that is only computed on the failing branch aggregates to a clean
 * `max: 0` — which is why presence is asserted here as well as value.
 */
async function expectCleanPredicates(id: string): Promise<Record<string, number>> {
  const found = scenario(id);
  const sample = await found.run(context);
  const metrics = sample.metrics ?? {};
  for (const name of found.correctness ?? []) {
    // Presence is asserted for every term, including the timing-dependent ones:
    // a predicate that stopped being emitted is a defect on any machine.
    expect(metrics[name], `${id}.${name} must be emitted`).toBeTypeOf("number");
    // The VALUE is not, for the two PortBatcher cadence terms. Their
    // expectation includes "the timer had not fired yet", which a loaded box can
    // break with nothing wrong — this file asserted them anyway and failed three
    // times across six full-suite runs while `scenarioLiveness.test.ts`, which
    // honours the same list, passed. `run.ts` still grades them in full.
    if (isTimingDependent(id, name)) continue;
    expect(metrics[name], `${id}.${name}`).toBe(0);
  }
  expect(Number.isFinite(sample.durationMs)).toBe(true);
  return metrics;
}

describe("pty flow-control scenarios drive the real subject", () => {
  it("PERF-370 pauses the flooder and nothing else", async () => {
    const metrics = await expectCleanPredicates("PERF-370");
    // 4 + 12 + 24 + 48 terminals, each writing its planned chunk budget.
    expect(metrics.chunkCount).toBeGreaterThan(9_000);
    expect(metrics.writtenBytes).toBeGreaterThan(20_000_000);
    expect(metrics.perChunkUsAt48).toBeGreaterThan(0);
  }, 60_000);

  it("PERF-371 exempts the focused pane on the port path and not on the IPC path", async () => {
    const metrics = await expectCleanPredicates("PERF-371");
    expect(metrics.aggregateWatermarkBytes).toBe(16 * 1024 * 1024);
    expect(metrics.perTerminalQueueBytes).toBeLessThan(16 * 1024 * 1024);
  }, 60_000);

  it("PERF-372 releases every paused terminal and isolates the sweep ack", async () => {
    const metrics = await expectCleanPredicates("PERF-372");
    // The sweep ack fans out over every paused terminal; an ordinary ack does
    // not. If they ever converge, the sweep stopped sweeping.
    expect(metrics.sweepAckUsAt48).toBeGreaterThan(metrics.plainAckUsAt48 ?? 0);
    expect(metrics.ackCount).toBeGreaterThan(100);
  }, 60_000);

  it("PERF-373 lands the governor's engage on the predicted tick", async () => {
    const metrics = await expectCleanPredicates("PERF-373");
    // The warmup gate blocks engage for the first five ticks; the EMA takes
    // several more to clear 85%. An engage inside the warmup window would be a
    // different governor.
    expect(metrics.ticksBeforeEngageCount).toBeGreaterThanOrEqual(5);
    expect(metrics.ticksBeforeEngageCount).toBeLessThan(metrics.tickCount ?? 0);
    expect(metrics.gaugeEventCount).toBeGreaterThan(0);
  }, 60_000);

  it("PERF-063 takes the zero-copy path with one window and the copy path with two", async () => {
    const metrics = await expectCleanPredicates("PERF-063");
    expect(metrics.zeroCopyDeliveryCount).toBeGreaterThan(0);
    expect(metrics.copiedDeliveryCount).toBe((metrics.zeroCopyDeliveryCount ?? 0) * 2);
    // Presence and shape stay structural here. The real perf runner grades
    // gcObservationMisses in full; a unit worker cannot force V8 to schedule a
    // minor collection without contaminating the allocation measurement.
    expect(Number.isFinite(metrics.minorGcCountZeroCopy)).toBe(true);
    expect(Number.isFinite(metrics.minorGcCountCopyPath)).toBe(true);
  }, 120_000);
});

/**
 * The oracles, exercised against the two failures a flow controller can post a
 * perfect duration with: pausing nothing, and pausing everything. Neither is
 * hypothetical — the first is what a dropped watermark check produces and the
 * second is what a dropped focus exemption produces.
 */
describe("expectedVictimSet is an oracle a no-op cannot satisfy", () => {
  let marks: WatermarkConstants;
  const ids = ["a", "b", "c", "focus"];

  async function load(): Promise<WatermarkConstants> {
    marks ??= watermarks(await loadFlowControlModules());
    return marks;
  }

  it("names exactly the terminals over the aggregate watermark, focus excepted", async () => {
    const wm = await load();
    // Under its own watermark, so the aggregate is the only trigger available.
    const per = wm.highWatermarkBytes / 2;
    const expected = expectedVictimSet({
      ids,
      ownBytes: () => per,
      totalBytes: wm.totalHighWatermarkBytes,
      focusedId: "focus",
      focusExempt: true,
      marks: wm,
    });
    expect([...expected].sort()).toEqual(["a", "b", "c"]);
  });

  it("scores a controller that paused nothing", async () => {
    const wm = await load();
    const per = wm.highWatermarkBytes / 2;
    const expected = expectedVictimSet({
      ids,
      ownBytes: () => per,
      totalBytes: wm.totalHighWatermarkBytes,
      focusedId: "focus",
      focusExempt: true,
      marks: wm,
    });
    expect(setDifferenceCount(expected, new Set())).toBe(3);
  });

  it("scores a controller that paused everything, focused pane included", async () => {
    const wm = await load();
    const per = wm.highWatermarkBytes / 2;
    const expected = expectedVictimSet({
      ids,
      ownBytes: () => per,
      totalBytes: wm.totalHighWatermarkBytes,
      focusedId: "focus",
      focusExempt: true,
      marks: wm,
    });
    expect(setDifferenceCount(expected, new Set(ids))).toBe(1);
  });

  it("still pauses the focused pane when it is over its OWN watermark", async () => {
    const wm = await load();
    const expected = expectedVictimSet({
      ids: ["focus"],
      ownBytes: () => wm.highWatermarkBytes,
      totalBytes: wm.highWatermarkBytes,
      focusedId: "focus",
      focusExempt: true,
      marks: wm,
    });
    expect([...expected]).toEqual(["focus"]);
  });

  it("does not exempt anything on the IPC path, which has no focus dep", async () => {
    const wm = await load();
    const per = wm.highWatermarkBytes / 2;
    const expected = expectedVictimSet({
      ids,
      ownBytes: () => per,
      totalBytes: wm.totalHighWatermarkBytes,
      focusedId: "focus",
      focusExempt: false,
      marks: wm,
    });
    expect([...expected].sort()).toEqual(["a", "b", "c", "focus"]);
  });
});

describe("predictGovernorSchedule is an oracle an eager governor fails", () => {
  const ladder = [
    20, 20, 20, 20, 20, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 92, 30,
  ];

  it("holds engage until the EMA clears the limit, not the raw reading", () => {
    const prediction = predictGovernorSchedule(ladder, true);
    expect(prediction.trimTicks).toHaveLength(1);
    expect(prediction.engageTicks).toHaveLength(1);
    expect(prediction.disengageTicks).toHaveLength(1);
    const engage = prediction.engageTicks[0] as number;
    const trim = prediction.trimTicks[0] as number;
    // The raw signal is over the limit from tick 5. The EMA is not, for many
    // ticks after — that gap is the whole point of the smoothing.
    expect(trim).toBeGreaterThan(5);
    expect(engage).toBe(trim + 1);
    expect(prediction.smoothed[5]).toBeLessThan(85);
  });

  it("refuses to engage during the warmup window even at a sustained 92%", () => {
    const prediction = predictGovernorSchedule([92, 92, 92], true);
    expect(prediction.engageTicks).toHaveLength(0);
    expect(prediction.trimTicks).toHaveLength(0);
  });

  it("bypasses warmup, smoothing and the trim at critical pressure", () => {
    const prediction = predictGovernorSchedule([96], true);
    expect(prediction.engageTicks).toEqual([0]);
    expect(prediction.trimTicks).toHaveLength(0);
  });

  it("seeds the EMA with the first reading rather than ramping from zero", () => {
    const prediction = predictGovernorSchedule([40, 40], true);
    expect(prediction.smoothed[0]).toBe(40);
    expect(prediction.smoothed[1]).toBeCloseTo(40, 10);
  });
});

describe("triage orderings are recomputed, not read back", () => {
  const spec = buildFleetSpec(12);

  it("pauses idle terminals before agent-active ones", () => {
    const order = expectedEngageOrder(spec);
    const activeIds = new Set(
      spec.terminals.filter((terminal) => terminal.agentActive).map((terminal) => terminal.id)
    );
    expect(activeIds.size).toBeGreaterThan(0);
    const firstActive = order.findIndex((id) => activeIds.has(id));
    const lastIdle = order.reduce((last, id, index) => (activeIds.has(id) ? last : index), -1);
    expect(firstActive).toBeGreaterThan(lastIdle);
  });

  it("resumes in the reverse triage", () => {
    expect(expectedDisengageOrder(spec)).not.toEqual(expectedEngageOrder(spec));
    expect([...expectedDisengageOrder(spec)].sort()).toEqual([...expectedEngageOrder(spec)].sort());
  });

  it("trims only the terminals above the scrollback floor, heaviest first", () => {
    const order = expectedTrimOrder(spec);
    expect(order.length).toBeGreaterThan(0);
    expect(order.length).toBeLessThan(spec.terminals.length);
    // A trim that flattened the whole fleet, and one that trimmed nothing, are
    // both a mismatch against this ordering.
    expect(orderMisses(order, order)).toBe(0);
    expect(orderMisses(order, [])).toBe(order.length);
    expect(
      orderMisses(
        order,
        spec.terminals.map((terminal) => terminal.id)
      )
    ).toBeGreaterThan(0);
    expect(orderMisses(order, [...order].reverse())).toBeGreaterThan(0);
  });

  it("keeps the focused terminal out of the trim ranking's identity", () => {
    // Guards a fixture edit that renamed the focused terminal out of the fleet.
    expect(spec.terminals.some((terminal) => terminal.id === FOCUSED_ID)).toBe(true);
  });
});

/**
 * The IPC fallback arm mirrors `pty-host.ts`'s call sequence because that file
 * has no seam to import — zero exports, and a module body that throws outside a
 * UtilityProcess. The mirror is only worth having if drift in the original is
 * caught, so the extraction is driven against synthetic sources here and
 * against the real file below.
 */
describe("pty-host IPC fallback drift guard", () => {
  const block = (body: string): string =>
    `      if (!visualWritten && !isBackgrounded && !isSuspended) {\n${body}\n      }\n`;

  const SHIPPED = block(`        if (ipcQueueManager.isAtCapacity(id, dataBytes)) {
          const utilization = ipcQueueManager.getUtilization(id);
          console.warn(\`full (\${utilization}%)\`);
          return;
        }
        ipcQueueManager.addBytes(id, dataBytes);
        const utilization = ipcQueueManager.getUtilization(id);
        ipcQueueManager.applyBackpressure(id, utilization);`);

  it("reads the ordered calls out of a block shaped like the shipped one", () => {
    expect(extractIpcFallbackSequence(SHIPPED)).toEqual([...IPC_FALLBACK_HOST_SEQUENCE]);
    expect(ipcFallbackSequenceMissesIn(SHIPPED)).toBe(0);
  });

  it("scores a gate that moved after the accounting", () => {
    const moved = block(`        ipcQueueManager.addBytes(id, dataBytes);
        if (ipcQueueManager.isAtCapacity(id, dataBytes)) return;
        const utilization = ipcQueueManager.getUtilization(id);
        ipcQueueManager.applyBackpressure(id, utilization);`);
    expect(ipcFallbackSequenceMissesIn(moved)).toBeGreaterThan(0);
  });

  it("scores a dropped step and an added one", () => {
    const dropped = block(`        if (ipcQueueManager.isAtCapacity(id, dataBytes)) return;
        ipcQueueManager.addBytes(id, dataBytes);
        ipcQueueManager.applyBackpressure(id, 0);`);
    expect(ipcFallbackSequenceMissesIn(dropped)).toBeGreaterThan(0);

    const added = block(`        if (ipcQueueManager.isAtCapacity(id, dataBytes)) {
          const utilization = ipcQueueManager.getUtilization(id);
          return;
        }
        ipcQueueManager.addBytes(id, dataBytes);
        const utilization = ipcQueueManager.getUtilization(id);
        ipcQueueManager.clearQueue(id);
        ipcQueueManager.applyBackpressure(id, utilization);`);
    expect(ipcFallbackSequenceMissesIn(added)).toBeGreaterThan(0);
  });

  it("fails closed when the block cannot be found or its braces do not balance", () => {
    expect(extractIpcFallbackSequence("nothing here")).toBeNull();
    expect(ipcFallbackSequenceMissesIn("nothing here")).toBe(IPC_FALLBACK_HOST_SEQUENCE.length);
    const unbalanced = "if (!visualWritten && !isBackgrounded && !isSuspended) {\n  foo(";
    expect(extractIpcFallbackSequence(unbalanced)).toBeNull();
  });

  it("agrees with the shipped pty-host.ts today", () => {
    expect(ipcFallbackSequenceMisses()).toBe(0);
  });

  /**
   * The half the constant check cannot do.
   *
   * `ipcFallbackSequenceMissesIn` compares the HOST SOURCE against
   * `IPC_FALLBACK_HOST_SEQUENCE`, both of which sit still while `runIpcFlood`'s
   * own calls are reordered or dropped — the mirror could diverge from both and
   * score zero. `ipcFallbackMirrorMissesIn` compares what the mirror EXECUTES,
   * recorded as it enters each `ipcQueueManager` member, against the branch of
   * the host it is mirroring.
   */
  it("splits the shipped block into the accept and drop paths", () => {
    expect(extractIpcFallbackSequences(SHIPPED)).toEqual({
      accept: ["isAtCapacity", "addBytes", "getUtilization", "applyBackpressure"],
      drop: ["isAtCapacity", "getUtilization"],
    });
  });

  it("observes the mirror's own two paths rather than declaring them", () => {
    expect(observeIpcFallbackSequences()).toEqual({
      accept: ["isAtCapacity", "addBytes", "getUtilization", "applyBackpressure"],
      drop: ["isAtCapacity", "getUtilization"],
    });
  });

  it("scores a host whose accepting path the mirror no longer performs", () => {
    // The gate stays put and both branches still exist, so the flat sequence is
    // a permutation the constant check happens to tolerate in length — but the
    // mirror does not call `clearQueue`, and it calls `addBytes` first.
    const reordered = block(`        if (ipcQueueManager.isAtCapacity(id, dataBytes)) {
          const utilization = ipcQueueManager.getUtilization(id);
          return;
        }
        const utilization = ipcQueueManager.getUtilization(id);
        ipcQueueManager.applyBackpressure(id, utilization);
        ipcQueueManager.addBytes(id, dataBytes);`);
    expect(ipcFallbackMirrorMissesIn(reordered)).toBeGreaterThan(0);
  });

  it("scores a host whose drop branch grew a step the mirror does not take", () => {
    const grown = block(`        if (ipcQueueManager.isAtCapacity(id, dataBytes)) {
          const utilization = ipcQueueManager.getUtilization(id);
          ipcQueueManager.clearQueue(id);
          return;
        }
        ipcQueueManager.addBytes(id, dataBytes);
        const utilization = ipcQueueManager.getUtilization(id);
        ipcQueueManager.applyBackpressure(id, utilization);`);
    expect(ipcFallbackMirrorMissesIn(grown)).toBe(1);
  });

  it("fails closed when the drop branch has no braced body", () => {
    // `if (…) return;` — a real restructure, and one this lexical matcher
    // cannot split. Reported, never resolved in the convenient direction.
    const braceless = block(`        if (ipcQueueManager.isAtCapacity(id, dataBytes)) return;
        ipcQueueManager.addBytes(id, dataBytes);
        const utilization = ipcQueueManager.getUtilization(id);
        ipcQueueManager.applyBackpressure(id, utilization);`);
    expect(extractIpcFallbackSequences(braceless)).toBeNull();
    expect(ipcFallbackMirrorMissesIn(braceless)).toBe(6);
    expect(extractIpcFallbackSequences("nothing here")).toBeNull();
    expect(ipcFallbackMirrorMissesIn("nothing here")).toBe(6);
  });

  it("agrees with what the shipped pty-host.ts actually contains today", () => {
    expect(ipcFallbackMirrorMisses()).toBe(0);
  });
});

/**
 * The batcher's `(idle → latency → throughput)` cadence machine runs on every
 * flood write and nothing else in this family can see it: the drive loops all
 * end in a threshold or forced flush, so the timers are armed, cancelled and
 * never fire. These are the terms that make deleting the scheduling score.
 */
/**
 * How far past its intended window the fixture's wait may stretch before a
 * cadence miss stops being a statement about the batcher.
 *
 * A MULTIPLE of the fixture's own target rather than a constant: it sleeps
 * `PORT_BATCH_THROUGHPUT_DELAY_MS * 2 + 8`, and a fixed millisecond ceiling
 * here would silently stop tracking that if the production delay ever moved.
 * Double is the point at which the box, not the batcher, is deciding when the
 * timers run.
 */
const CADENCE_WAIT_TOLERANCE = 2;

describe("PortBatcher flush cadence", () => {
  it("delivers on the scheduled turns and not before", async () => {
    const modules = await loadFlowControlModules();
    const grade = await gradeFlushCadence(modules, 2048);
    // Emitted, and read as numbers, on any machine.
    expect(grade.immediateFlushMisses).toBeTypeOf("number");
    expect(grade.throughputFlushMisses).toBeTypeOf("number");

    // The cadence terms' VALUES are asserted only when the fixture's wait ran
    // to something like its intended length. `waitedMs` is its own record of
    // the wall clock it spent waiting for the two scheduled turns, and the
    // target is the same expression it sleeps for; when the box stretches that,
    // a miss says the machine was busy rather than that the batcher is wrong.
    //
    // The polarity is the safe one: a batcher regression that delivers late
    // still produces a SHORT wait and a miss, so it fails here. What the gate
    // skips is a stretched window, where the reading is about the runner. The
    // delivery counts and the corpus-validity term below hold unconditionally,
    // and `run.ts` grades every term in full on a box that is not contended.
    const targetWaitMs = modules.constants.PORT_BATCH_THROUGHPUT_DELAY_MS * 2 + 8;
    const waitWasClean = grade.waitedMs < targetWaitMs * CADENCE_WAIT_TOLERANCE;
    if (waitWasClean) {
      expect(grade.immediateFlushMisses, `waited ${grade.waitedMs}ms`).toBe(0);
      expect(grade.throughputFlushMisses, `waited ${grade.waitedMs}ms`).toBe(0);
    }
    expect(grade.cadenceShortfallCount).toBe(0);
    expect(grade.immediateDeliveryCount).toBe(1);
    expect(grade.throughputDeliveryCount).toBe(1);
    expect(grade.waitedMs).toBeGreaterThan(0);
  }, 20_000);

  it("flags a probe whose writes would reach the synchronous threshold", async () => {
    const modules = await loadFlowControlModules();
    // Over `PORT_BATCH_THRESHOLD_BYTES`, so a delivery would prove nothing about
    // the cadence — the corpus term says so rather than the run passing.
    const grade = await gradeFlushCadence(modules, modules.constants.PORT_BATCH_THRESHOLD_BYTES);
    expect(grade.cadenceShortfallCount).toBeGreaterThan(0);
  }, 20_000);
});

describe("timer overhead calibration", () => {
  it("reports a positive per-call cost", () => {
    const ns = measureTimerOverheadNs(2_000);
    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });
});
