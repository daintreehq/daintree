import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CPU_HISTORY_SIZE,
  isSettledResourceState,
  useResourceMonitoringStore,
} from "../resourceMonitoringStore";
import type { TerminalResourceSample } from "@shared/types/pty-host";

function sample(overrides: Partial<TerminalResourceSample> = {}): TerminalResourceSample {
  return {
    cpuPercent: 3,
    memoryKb: 1024,
    processCount: 2,
    breakdown: [{ pid: 1, comm: "zsh", cpuPercent: 3, memoryKb: 1024 }],
    ...overrides,
  };
}

function poll(s: TerminalResourceSample = sample()) {
  useResourceMonitoringStore.getState().updateMetrics({ t1: s });
  return useResourceMonitoringStore.getState().metrics.get("t1")!;
}

describe("resourceMonitoringStore.updateMetrics", () => {
  beforeEach(() => {
    useResourceMonitoringStore.setState({ enabled: true, metrics: new Map(), lastBatch: null });
  });

  it("builds a new entry for every repeated sample until the history window is flat", () => {
    const seen = new Set<unknown>();
    for (let i = 0; i < CPU_HISTORY_SIZE; i++) seen.add(poll());

    expect(seen.size).toBe(CPU_HISTORY_SIZE);
    expect(poll().cpuHistory).toEqual(Array(CPU_HISTORY_SIZE).fill(3));
  });

  it("keeps the entry once a sample has held for the whole window", () => {
    const entries: unknown[] = [];
    for (let i = 0; i < CPU_HISTORY_SIZE; i++) entries.push(poll());
    const settled = entries.at(-1) as ReturnType<typeof poll>;

    expect(isSettledResourceState(settled)).toBe(true);
    expect(entries.slice(0, -1).some((e) => isSettledResourceState(e as typeof settled))).toBe(
      false
    );
    for (let i = 0; i < 5; i++) expect(poll()).toBe(settled);
  });

  it("publishes every non-empty batch, settled or not, without replacing a settled map", () => {
    // The leak detector evaluates each published batch; its cadence must not
    // depend on whether a sample moved.
    const batches: unknown[] = [];
    const unsubscribe = useResourceMonitoringStore.subscribe((curr, prev) => {
      if (curr.lastBatch !== prev.lastBatch) batches.push(curr.lastBatch);
    });
    for (let i = 0; i < CPU_HISTORY_SIZE; i++) poll();
    const settledMap = useResourceMonitoringStore.getState().metrics;

    const reused = { t1: sample() };
    for (let i = 0; i < 3; i++) poll();
    for (let i = 0; i < 2; i++) useResourceMonitoringStore.getState().updateMetrics(reused);
    unsubscribe();

    expect(batches).toHaveLength(CPU_HISTORY_SIZE + 5);
    expect(new Set(batches).size).toBe(CPU_HISTORY_SIZE + 5);
    expect(useResourceMonitoringStore.getState().lastBatch?.samples).toBe(reused);
    expect(useResourceMonitoringStore.getState().metrics).toBe(settledMap);
  });

  it("publishes the sampling time the host stamped on the batch", () => {
    useResourceMonitoringStore.getState().updateMetrics({ t1: sample() }, 1_234);
    expect(useResourceMonitoringStore.getState().lastBatch?.sampledAt).toBe(1_234);

    useResourceMonitoringStore.getState().updateMetrics({ t1: sample() }, 17_234);
    expect(useResourceMonitoringStore.getState().lastBatch?.sampledAt).toBe(17_234);
  });

  it("stamps a batch with its arrival time when the caller gives none", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(9_876);
    try {
      useResourceMonitoringStore.getState().updateMetrics({ t1: sample() });
      expect(useResourceMonitoringStore.getState().lastBatch?.sampledAt).toBe(9_876);

      now.mockReturnValue(24_876);
      useResourceMonitoringStore.getState().updateMetrics({ t1: sample() });
      expect(useResourceMonitoringStore.getState().lastBatch?.sampledAt).toBe(24_876);
    } finally {
      now.mockRestore();
    }
  });

  it("leaves the store untouched for an empty batch (#17194)", () => {
    poll();
    const before = useResourceMonitoringStore.getState();

    let notified = 0;
    const unsubscribe = useResourceMonitoringStore.subscribe(() => notified++);
    useResourceMonitoringStore.getState().updateMetrics({});
    unsubscribe();

    expect(notified).toBe(0);
    expect(useResourceMonitoringStore.getState()).toBe(before);
  });

  it("publishes no batch when a panel is removed, the store cleared, or monitoring disabled", () => {
    useResourceMonitoringStore.getState().updateMetrics({ t1: sample(), t2: sample() });
    const batch = useResourceMonitoringStore.getState().lastBatch;

    useResourceMonitoringStore.getState().removePanel("t2");
    expect(useResourceMonitoringStore.getState().lastBatch).toBe(batch);
    expect([...useResourceMonitoringStore.getState().metrics.keys()]).toEqual(["t1"]);

    useResourceMonitoringStore.getState().clear();
    expect(useResourceMonitoringStore.getState().lastBatch).toBeNull();

    poll();
    useResourceMonitoringStore.getState().setEnabled(false);
    expect(useResourceMonitoringStore.getState().lastBatch).toBeNull();
    expect(useResourceMonitoringStore.getState().metrics.size).toBe(0);
  });

  it("appends to the history as soon as a settled sample moves", () => {
    for (let i = 0; i < CPU_HISTORY_SIZE + 3; i++) poll();

    const moved = poll(sample({ cpuPercent: 50 }));

    expect(moved.cpuPercent).toBe(50);
    expect(moved.cpuHistory).toEqual([...Array(CPU_HISTORY_SIZE - 1).fill(3), 50]);
  });

  it.each([
    ["memory", { memoryKb: 2048 }],
    ["process count", { processCount: 3 }],
    ["breakdown", { breakdown: [{ pid: 1, comm: "zsh", cpuPercent: 3, memoryKb: 900 }] }],
  ])("restarts the window when only the %s changes", (_label, change) => {
    for (let i = 0; i < CPU_HISTORY_SIZE - 2; i++) poll();
    poll(sample(change));

    const entries = new Set<unknown>();
    for (let i = 0; i < CPU_HISTORY_SIZE - 1; i++) entries.add(poll());

    expect(entries.size).toBe(CPU_HISTORY_SIZE - 1);
  });

  it("still replaces entries whose sample changed alongside settled ones", () => {
    const both = (a: TerminalResourceSample) => {
      useResourceMonitoringStore.getState().updateMetrics({ t1: sample(), t2: a });
      return useResourceMonitoringStore.getState().metrics;
    };
    for (let i = 0; i < CPU_HISTORY_SIZE; i++) both(sample());
    const before = both(sample());

    const after = both(sample({ cpuPercent: 9 }));

    expect(after.get("t1")).toBe(before.get("t1"));
    expect(after.get("t2")).not.toBe(before.get("t2"));
  });

  it("keeps the store and map when the removed panel has no metrics", () => {
    useResourceMonitoringStore.getState().updateMetrics({ t1: sample() });
    const before = useResourceMonitoringStore.getState();
    const metricsBefore = before.metrics;
    let notified = 0;
    const unsubscribe = useResourceMonitoringStore.subscribe(() => notified++);

    useResourceMonitoringStore.getState().removePanel("absent");
    unsubscribe();

    expect(notified).toBe(0);
    expect(useResourceMonitoringStore.getState()).toBe(before);
    expect(useResourceMonitoringStore.getState().metrics).toBe(metricsBefore);
  });

  it("notifies and preserves other panels when an existing sample is removed", () => {
    useResourceMonitoringStore.getState().updateMetrics({ t1: sample(), t2: sample() });
    const before = useResourceMonitoringStore.getState().metrics;
    let notified = 0;
    const unsubscribe = useResourceMonitoringStore.subscribe(() => notified++);

    useResourceMonitoringStore.getState().removePanel("t2");
    unsubscribe();

    const after = useResourceMonitoringStore.getState().metrics;
    expect(notified).toBe(1);
    expect(after).not.toBe(before);
    expect([...after.keys()]).toEqual(["t1"]);
    expect(after.get("t1")).toBe(before.get("t1"));
  });
});
