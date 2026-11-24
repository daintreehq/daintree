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
  ALERT_COOLDOWN_MS,
  CONSECUTIVE_REQUIRED,
  MIN_MEMORY_KB,
  STARTUP_SKIP_SAMPLES,
  useMemoryLeakDetection,
} from "../useMemoryLeakDetection";

const GROWTH_KB = 1024;
const T0 = 1_700_000_000_000;
const NOMINAL_MS = 2_500;
// One sample past startup counts the first increase, so the alert lands here.
const ALERT_SAMPLE = STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED - 1;

// The host's sampling time for the nth poll at the nominal cadence.
const at = (n: number) => T0 + n * NOMINAL_MS;
// Another shard polls on its own clock, not at the same instant.
const OTHER_SHARD_OFFSET_MS = 1_000;

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
      update({ leaky: sample(MIN_MEMORY_KB + i * GROWTH_KB) }, at(i));
      update({ steady: sample(MIN_MEMORY_KB * 2) }, at(i) + OTHER_SHARD_OFFSET_MS);
      update({}, at(i) + OTHER_SHARD_OFFSET_MS);
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
      update({ alone: sample(memoryKb) }, at(i));
      update({ beside: sample(memoryKb), flat: sample(MIN_MEMORY_KB) }, at(i));
      update({ elsewhere: sample(MIN_MEMORY_KB) }, at(i) + OTHER_SHARD_OFFSET_MS);
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
    for (let i = 0; i < STARTUP_SKIP_SAMPLES; i++) store.updateMetrics(flat, at(i));
    expect(useResourceMonitoringStore.getState().metrics).toBe(settledMap);

    for (let i = 1; i <= CONSECUTIVE_REQUIRED; i++) {
      expect(leakAlertsFor("settled")).toBe(0);
      store.updateMetrics(
        { settled: sample(MIN_MEMORY_KB + i * GROWTH_KB) },
        at(STARTUP_SKIP_SAMPLES + i)
      );
    }
    expect(leakAlertsFor("settled")).toBe(1);
  });

  it("doesn't count another panel's removal as a sample for the rest", () => {
    const store = useResourceMonitoringStore.getState();
    store.updateMetrics({ gone: sample(MIN_MEMORY_KB) }, at(0));
    for (let i = 0; i < ALERT_SAMPLE; i++) {
      store.updateMetrics({ leaky: sample(MIN_MEMORY_KB + i * GROWTH_KB) }, at(i));
      if (i === ALERT_SAMPLE - 5) store.removePanel("gone");
    }

    expect(leakAlertsFor("leaky")).toBe(1);
  });

  it("starts a removed terminal's history over if it reports again", () => {
    const store = useResourceMonitoringStore.getState();
    let i = 0;
    const grow = (n: number) => {
      for (const end = i + n; i < end; i++) {
        store.updateMetrics({ leaky: sample(MIN_MEMORY_KB + i * GROWTH_KB) }, at(i));
      }
    };
    grow(ALERT_SAMPLE - 1);
    store.removePanel("leaky");

    grow(ALERT_SAMPLE - 1);
    expect(leakAlertsFor("leaky")).toBe(0);
    grow(1);
    expect(leakAlertsFor("leaky")).toBe(1);
  });

  describe("growth rate from sampling time", () => {
    // 128 KB/s is 450 MB/hour and 80 KB/s is 281 MB/hour, however often the
    // census polled.
    const cases = [
      ["128 KB/s polled every 2.5s", [2_500], 128, "450 MB/hr"],
      ["128 KB/s polled every 15s", [15_000], 128, "450 MB/hr"],
      ["128 KB/s polled irregularly", [2_500, 15_000, 4_000, 9_000], 128, "450 MB/hr"],
      ["80 KB/s polled every 2.5s", [2_500], 80, "281 MB/hr"],
      ["80 KB/s polled every 15s", [15_000], 80, "281 MB/hr"],
    ] as const;

    it.each(cases)(
      "reports the same rate in the toast and the inbox for %s",
      (_name, intervals, kbPerSecond, expected) => {
        const update = useResourceMonitoringStore.getState().updateMetrics;
        let elapsedMs = 0;
        for (let i = 0; i < ALERT_SAMPLE; i++) {
          if (i > 0) elapsedMs += intervals[(i - 1) % intervals.length]!;
          expect(leakAlertsFor("leaky")).toBe(0);
          update(
            { leaky: sample(MIN_MEMORY_KB + (kbPerSecond * elapsedMs) / 1000) },
            T0 + elapsedMs
          );
        }

        const alerts = notify.mock.calls.filter(([n]) => n.correlationId === "memory-leak-leaky");
        expect(alerts).toHaveLength(1);
        expect(alerts[0]![0].message).toContain(`growing ${expected}`);
        expect(alerts[0]![0].inboxMessage).toContain(`growing ${expected}`);
      }
    );

    it("takes the sampling time from the batch, not from when the view receives it", () => {
      const update = useResourceMonitoringStore.getState().updateMetrics;
      // Every batch arrives within one tick, as when a thawed view drains its
      // queue; the host sampled them 15 seconds apart.
      for (let i = 0; i < ALERT_SAMPLE; i++) {
        update({ leaky: sample(MIN_MEMORY_KB + i * 1_200) }, T0 + i * 15_000);
      }

      const alerts = notify.mock.calls.filter(([n]) => n.correlationId === "memory-leak-leaky");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]![0].message).toContain("growing 281 MB/hr");
      expect(alerts[0]![0].inboxMessage).toContain("growing 281 MB/hr");
    });

    it("holds the cooldown on this view's clock while the host's sampling time runs on", () => {
      const update = useResourceMonitoringStore.getState().updateMetrics;
      const RENDERER_T0 = 1_800_000_000_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(RENDERER_T0);
      let poll = 0;
      const growFor = (count: number) => {
        for (const end = poll + count; poll < end; poll++) {
          update({ leaky: sample(MIN_MEMORY_KB + poll * 320) }, at(poll));
        }
      };
      try {
        growFor(ALERT_SAMPLE);
        expect(leakAlertsFor("leaky")).toBe(1);

        // More than a cooldown's worth of host time passes, still growing.
        growFor(Math.ceil(ALERT_COOLDOWN_MS / NOMINAL_MS) + 10);
        expect(leakAlertsFor("leaky")).toBe(1);

        now.mockReturnValue(RENDERER_T0 + ALERT_COOLDOWN_MS - 1);
        growFor(1);
        expect(leakAlertsFor("leaky")).toBe(1);

        now.mockReturnValue(RENDERER_T0 + ALERT_COOLDOWN_MS);
        growFor(1);
        expect(leakAlertsFor("leaky")).toBe(2);
      } finally {
        now.mockRestore();
      }
    });
  });
});
