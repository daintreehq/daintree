import { beforeEach, describe, expect, it } from "vitest";
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
    useResourceMonitoringStore.setState({ enabled: true, metrics: new Map() });
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

  it("still publishes a new metrics map for every batch, settled or not", () => {
    // The leak detector evaluates every entry once per published map; its
    // cadence must not depend on whether a sample moved.
    for (let i = 0; i < CPU_HISTORY_SIZE; i++) poll();

    let notified = 0;
    const unsubscribe = useResourceMonitoringStore.subscribe((curr, prev) => {
      if (curr.metrics !== prev.metrics) notified++;
    });
    for (let i = 0; i < 5; i++) poll();
    useResourceMonitoringStore.getState().updateMetrics({});
    unsubscribe();

    expect(notified).toBe(6);
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
});
