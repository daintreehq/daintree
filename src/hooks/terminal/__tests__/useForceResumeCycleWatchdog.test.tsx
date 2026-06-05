// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TerminalReliabilityMetricPayload } from "@shared/types/pty-host";

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (payload: unknown) => notifyMock(payload),
}));

const forceResumeMock = vi.fn((_id: string) => Promise.resolve());
vi.mock("@/clients", () => ({
  terminalClient: {
    forceResume: (id: string) => forceResumeMock(id),
  },
}));

// Registry of bus subscribers keyed by event name, so tests can drive metrics.
type MetricListener = (payload: TerminalReliabilityMetricPayload) => void;
let listeners: Map<string, Set<MetricListener>>;
const unsubSpy = vi.fn();

const eventsOn = vi.fn((name: string, cb: MetricListener) => {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    unsubSpy();
  };
});

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    events: { on: eventsOn },
  },
});

function emitMetric(payload: Partial<TerminalReliabilityMetricPayload>): void {
  const full: TerminalReliabilityMetricPayload = {
    terminalId: "t1",
    metricType: "pause-end",
    timestamp: 0,
    ...payload,
  };
  act(() => {
    for (const cb of listeners.get("terminal:reliability-metric") ?? []) {
      cb(full);
    }
  });
}

import { useForceResumeCycleWatchdog } from "../useForceResumeCycleWatchdog";

beforeEach(() => {
  listeners = new Map();
  notifyMock.mockClear();
  forceResumeMock.mockClear();
  unsubSpy.mockClear();
  eventsOn.mockClear();
});

describe("useForceResumeCycleWatchdog", () => {
  it("subscribes to the reliability-metric bus for the terminal", () => {
    renderHook(() => useForceResumeCycleWatchdog("t1"));
    expect(eventsOn).toHaveBeenCalledWith("terminal:reliability-metric", expect.any(Function));
  });

  it("promotes to the banner only after three consecutive force-resumes", () => {
    const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(false);
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(false);
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(true);
  });

  it("emits the grid-bar warning exactly once when the threshold is crossed", () => {
    renderHook(() => useForceResumeCycleWatchdog("t1"));

    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        priority: "low",
        placement: "grid-bar",
        supersedeKey: "terminal-force-resume-stalled:t1",
      })
    );

    // Subsequent force-resumes keep the banner up but stay silent.
    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("resets the counter on a confirmed natural drain", () => {
    const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    // Natural drain before the third force-resume — counter resets.
    emitMetric({ durationMs: 120 });
    expect(result.current.showBanner).toBe(false);

    // It now takes three fresh force-resumes again, not one.
    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(false);
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(true);
  });

  it("hides the banner and re-arms the notify on a drain after promotion", () => {
    const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(true);

    emitMetric({ durationMs: 120 });
    expect(result.current.showBanner).toBe(false);

    // A fresh stall fires the notify again (re-armed).
    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(true);
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it("does not count a metric with no durationMs, and does not reset on one", () => {
    const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    // Ambiguous metric: neither increments nor resets.
    emitMetric({ durationMs: undefined });
    expect(result.current.showBanner).toBe(false);
    // The next force-resume still completes the threshold (count preserved).
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(true);
  });

  it("ignores metrics for other terminals and non-pause-end types", () => {
    const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

    emitMetric({ terminalId: "other", durationMs: 9950 });
    emitMetric({ metricType: "suspend", durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(false);
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(true);
  });

  it("resetQueue force-resumes the terminal and clears the banner", () => {
    const { result } = renderHook(() => useForceResumeCycleWatchdog("t1"));

    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(true);

    act(() => result.current.resetQueue());
    expect(forceResumeMock).toHaveBeenCalledWith("t1");
    expect(result.current.showBanner).toBe(false);
  });

  it("tears down the old subscription and resets state when the id changes", () => {
    const { result, rerender } = renderHook(({ id }) => useForceResumeCycleWatchdog(id), {
      initialProps: { id: "t1" },
    });

    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    emitMetric({ durationMs: 9950 });
    expect(result.current.showBanner).toBe(true);

    rerender({ id: "t2" });
    expect(unsubSpy).toHaveBeenCalled();
    expect(result.current.showBanner).toBe(false);
    expect(eventsOn).toHaveBeenLastCalledWith("terminal:reliability-metric", expect.any(Function));
  });
});
