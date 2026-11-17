// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalResourceSample } from "@shared/types/pty-host";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById: {}, restartTerminal: vi.fn() }) },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

import { CPU_HISTORY_SIZE, useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import {
  CONSECUTIVE_REQUIRED,
  MIN_MEMORY_KB,
  STARTUP_SKIP_SAMPLES,
  useMemoryLeakDetection,
} from "../useMemoryLeakDetection";

const GROWTH_KB = 1024;
// One sample past startup counts the first increase, so the alert lands here.
const ALERT_SAMPLE = STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED - 1;

function sample(memoryKb: number): TerminalResourceSample {
  return { cpuPercent: 1, memoryKb, breakdown: [], processCount: 1 };
}

function leakAlertsFor(id: string): number {
  return notify.mock.calls.filter(([n]) => n.correlationId === `memory-leak-${id}`).length;
}

describe("useMemoryLeakDetection across PTY shards (#17194)", () => {
  let unmount: () => void;

  beforeEach(() => {
    notify.mockClear();
    (window as unknown as { electron: unknown }).electron = {
      events: { on: () => () => {} },
      terminal: { onBackendReady: () => () => {} },
    };
    useResourceMonitoringStore.setState({ enabled: true, metrics: new Map(), lastBatch: null });
    unmount = renderHook(() => useMemoryLeakDetection(true)).unmount;
  });

  afterEach(() => {
    unmount();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("alerts on steady growth while another shard's batches interleave", () => {
    const update = useResourceMonitoringStore.getState().updateMetrics;
    for (let i = 0; i < ALERT_SAMPLE; i++) {
      // Shard A carries the leaking terminal; shard B a flat one, each tick.
      update({ leaky: sample(MIN_MEMORY_KB + i * GROWTH_KB) });
      update({ steady: sample(MIN_MEMORY_KB * 2) });
      update({});
      if (i < ALERT_SAMPLE - 1) expect(leakAlertsFor("leaky")).toBe(0);
    }

    expect(leakAlertsFor("leaky")).toBe(1);
    expect(leakAlertsFor("steady")).toBe(0);
  });

  it("alerts on the same sample whether a terminal reports alone or beside others", () => {
    const update = useResourceMonitoringStore.getState().updateMetrics;
    let aloneAt = -1;
    let besideAt = -1;
    for (let i = 0; i < ALERT_SAMPLE + 5; i++) {
      const memoryKb = MIN_MEMORY_KB + i * GROWTH_KB;
      update({ alone: sample(memoryKb) });
      update({ beside: sample(memoryKb), flat: sample(MIN_MEMORY_KB) });
      update({ elsewhere: sample(MIN_MEMORY_KB) });
      if (aloneAt < 0 && leakAlertsFor("alone") > 0) aloneAt = i;
      if (besideAt < 0 && leakAlertsFor("beside") > 0) besideAt = i;
    }

    expect(aloneAt).toBe(ALERT_SAMPLE - 1);
    expect(besideAt).toBe(aloneAt);
  });

  it("counts a settled terminal's repeated polls, even when one batch object is reused", () => {
    // Settle the store entry before the detector watches, so every flat poll
    // below leaves the metrics map untouched.
    unmount();
    const store = useResourceMonitoringStore.getState();
    const flat = { settled: sample(MIN_MEMORY_KB) };
    for (let i = 0; i < CPU_HISTORY_SIZE; i++) store.updateMetrics(flat);
    unmount = renderHook(() => useMemoryLeakDetection(true)).unmount;

    const settledMap = useResourceMonitoringStore.getState().metrics;
    for (let i = 0; i < STARTUP_SKIP_SAMPLES; i++) store.updateMetrics(flat);
    expect(useResourceMonitoringStore.getState().metrics).toBe(settledMap);

    for (let i = 1; i <= CONSECUTIVE_REQUIRED; i++) {
      expect(leakAlertsFor("settled")).toBe(0);
      store.updateMetrics({ settled: sample(MIN_MEMORY_KB + i * GROWTH_KB) });
    }
    expect(leakAlertsFor("settled")).toBe(1);
  });

  it("doesn't count another panel's removal as a sample for the rest", () => {
    const store = useResourceMonitoringStore.getState();
    store.updateMetrics({ gone: sample(MIN_MEMORY_KB) });
    for (let i = 0; i < ALERT_SAMPLE; i++) {
      store.updateMetrics({ leaky: sample(MIN_MEMORY_KB + i * GROWTH_KB) });
      if (i === ALERT_SAMPLE - 5) store.removePanel("gone");
    }

    expect(leakAlertsFor("leaky")).toBe(1);
  });

  it("starts a removed terminal's history over if it reports again", () => {
    const store = useResourceMonitoringStore.getState();
    let i = 0;
    const grow = (n: number) => {
      for (const end = i + n; i < end; i++) {
        store.updateMetrics({ leaky: sample(MIN_MEMORY_KB + i * GROWTH_KB) });
      }
    };
    grow(ALERT_SAMPLE - 1);
    store.removePanel("leaky");

    grow(ALERT_SAMPLE - 1);
    expect(leakAlertsFor("leaky")).toBe(0);
    grow(1);
    expect(leakAlertsFor("leaky")).toBe(1);
  });
});
