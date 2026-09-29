import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRendererMetricsReport } from "@shared/types/pluginMetrics";
import { REPORT_DRAIN_DELAY_MS, startPluginMetricsReporter } from "../pluginMetricsReporter";

/** A registry double that follows the real drain protocol's re-arming rules. */
function makeRegistry() {
  const subscribers = new Set<() => void>();
  const drainListeners = new Set<() => void>();
  let pending: PluginRendererMetricsReport[] = [];
  let armed = true;
  let drainArmed = true;
  const report = (pluginId = "acme.demo"): PluginRendererMetricsReport => ({
    pluginId,
    viewLoads: [],
    commitDurationsMs: [1],
    commitCount: 1,
    longFramesDropped: { count: 0, blockingMs: 0 },
    longFrames: [],
  });
  return {
    subscribe: vi.fn((fn: () => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }),
    onDrainRequested: vi.fn((fn: () => void) => {
      drainListeners.add(fn);
      return () => drainListeners.delete(fn);
    }),
    drainReports: vi.fn(() => {
      armed = true;
      drainArmed = true;
      const out = pending;
      pending = [];
      return out;
    }),
    record(pluginId?: string) {
      pending.push(report(pluginId));
      if (armed) {
        armed = false;
        for (const fn of subscribers) fn();
      }
    },
    requestDrain() {
      if (!drainArmed) return;
      drainArmed = false;
      for (const fn of drainListeners) fn();
    },
    listenerCounts: () => ({ subscribers: subscribers.size, drain: drainListeners.size }),
  };
}

function makeTarget(): EventTarget & { visibilityState: DocumentVisibilityState } {
  return Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
}

let registry: ReturnType<typeof makeRegistry>;
let send: ReturnType<typeof vi.fn<(reports: PluginRendererMetricsReport[]) => void>>;
let doc: ReturnType<typeof makeTarget>;
let page: EventTarget;
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  registry = makeRegistry();
  send = vi.fn<(reports: PluginRendererMetricsReport[]) => void>();
  doc = makeTarget();
  page = new EventTarget();
  stop = startPluginMetricsReporter({
    registry,
    send,
    target: doc,
    pageTarget: page,
  });
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("startPluginMetricsReporter", () => {
  it("does nothing while no plugin view records anything", () => {
    vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS * 5);
    expect(registry.drainReports).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains lazily, once per window, after the first delta", () => {
    registry.record();
    registry.record();
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toHaveLength(2);

    // Re-armed by the drain: the next delta schedules the next report.
    registry.record();
    vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drains promptly, off the recording stack, when the registry asks", async () => {
    registry.record();
    registry.requestDrain();
    expect(send).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    // The lazy timer was cancelled by the early drain.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains when the page is hidden or goes away", () => {
    registry.record();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(send).toHaveBeenCalledTimes(1);

    registry.record();
    page.dispatchEvent(new Event("pagehide"));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("ignores a visibility change back to visible", () => {
    registry.record();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing for an empty drain", () => {
    page.dispatchEvent(new Event("pagehide"));
    expect(registry.drainReports).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("survives a send that throws", () => {
    send.mockImplementation(() => {
      throw new Error("ipc gone");
    });
    registry.record();
    expect(() => vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS)).not.toThrow();
    registry.record();
    vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("flushes what is pending on stop and detaches every listener", () => {
    registry.record();
    stop();
    expect(send).toHaveBeenCalledTimes(1);
    expect(registry.listenerCounts()).toEqual({ subscribers: 0, drain: 0 });
    registry.record();
    page.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    stop = () => {};
  });
});
