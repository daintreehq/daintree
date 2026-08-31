import { describe, expect, it } from "vitest";

import { ptyFlowControlScenarios } from "../scenarios/ptyFlowControl";
import { soakScenarios } from "../scenarios/soak";
import {
  buildFleetSpec,
  expectedDisengageOrder,
  expectedEngageOrder,
  expectedTrimOrder,
  expectedVictimSet,
  FOCUSED_ID,
  loadFlowControlModules,
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
    expect(metrics[name], `${id}.${name} must be emitted`).toBeTypeOf("number");
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
    expect(metrics.minorGcCountZeroCopy).toBeGreaterThan(0);
    expect(metrics.minorGcCountCopyPath).toBeGreaterThan(0);
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
