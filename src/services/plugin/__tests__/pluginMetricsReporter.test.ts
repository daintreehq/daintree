import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRendererMetricsReport } from "@shared/types/pluginMetrics";
import type { PluginRendererMetricsEnvelope } from "@shared/types/ipc/pluginMetrics";
import {
  REPORT_DRAIN_DELAY_MS,
  VIEW_LOAD_DRAIN_DELAY_MS,
  startPluginMetricsReporter,
} from "../pluginMetricsReporter";
import { createPluginViewMetrics, generationOfViewUrl } from "../pluginViewMetrics";

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
    drainTaggedReports: vi.fn(() => {
      armed = true;
      drainArmed = true;
      const out = pending;
      pending = [];
      return out.map((r) => ({
        generation: r.pluginId === "untagged" ? null : `gen-${r.pluginId}`,
        report: r,
      }));
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
let send: ReturnType<typeof vi.fn<(reports: PluginRendererMetricsEnvelope[]) => void>>;
let doc: ReturnType<typeof makeTarget>;
let page: EventTarget;
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  registry = makeRegistry();
  send = vi.fn<(reports: PluginRendererMetricsEnvelope[]) => void>();
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
    expect(registry.drainTaggedReports).not.toHaveBeenCalled();
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
    expect(registry.drainTaggedReports).toHaveBeenCalledTimes(1);
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

  it("tags each report with its plugin's load and holds back one with none", () => {
    registry.record("acme.demo");
    registry.record("untagged");
    vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    const envelopes = send.mock.calls[0]![0];
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.generation).toBe("gen-acme.demo");
    expect(envelopes[0]!.report.pluginId).toBe("acme.demo");
  });
});

describe("startPluginMetricsReporter with the real registry", () => {
  const OLD_VIEW = "plugin://pi-old/__dtv-1/view.js";
  const NEW_VIEW = "plugin://pi-new/__dtv-2/view.js";
  const OLD = generationOfViewUrl(OLD_VIEW)!;
  const NEW = generationOfViewUrl(NEW_VIEW)!;

  function startReal() {
    const metrics = createPluginViewMetrics();
    const sent = vi.fn<(reports: PluginRendererMetricsEnvelope[]) => void>();
    const stopReal = startPluginMetricsReporter({
      registry: metrics,
      send: sent,
      target: null,
      pageTarget: null,
    });
    return { metrics, sent, stopReal };
  }

  it("reads a view URL's load and its order", () => {
    expect(OLD).toEqual({ token: "pi-old", order: 1 });
    expect(generationOfViewUrl("plugin://PI-X/dist/view.js")).toEqual({
      token: "pi-x",
      order: null,
    });
    expect(generationOfViewUrl("https://example.com/__dtv-3/v.js")).toBeUndefined();
  });

  it("does not let an older load that finishes activating late retire its successor", () => {
    const { metrics, sent, stopReal } = startReal();
    try {
      // The new load's view mounts first; the old load's view was still
      // waiting on activation and only now registers its origin.
      metrics.registerViewOrigin("acme.demo", NEW_VIEW);
      metrics.recordCommit("acme.demo", 7, 12, NEW);
      metrics.registerViewOrigin("acme.demo", OLD_VIEW);
      metrics.recordCommit("acme.demo", 50, 13, OLD);
      metrics.recordCommit("acme.demo", 8, 14, NEW);

      vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS);
      const envelopes = sent.mock.calls[0]![0];
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]!.generation).toBe("pi-new");
      expect(envelopes[0]!.report.commitDurationsMs).toEqual([7, 8]);
      expect(metrics.pluginIdForScriptUrl("plugin://pi-old/__dtv-1/chunk.js")).toBeUndefined();
    } finally {
      stopReal();
    }
  });

  it("keeps each report's load even when the drain evicts its entry", () => {
    const { metrics, sent, stopReal } = startReal();
    try {
      // More closed plugins with pending data than the registry keeps: the
      // drain evicts entries while it builds the reports.
      for (let i = 0; i < 80; i++) {
        metrics.recordCommit(
          `p${i}`,
          1,
          i,
          generationOfViewUrl(`plugin://pi-${i}/__dtv-${i}/v.js`)
        );
      }
      vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS);
      const envelopes = sent.mock.calls[0]![0];
      expect(envelopes).toHaveLength(80);
      expect(envelopes.every((e) => e.generation === `pi-${e.report.pluginId.slice(1)}`)).toBe(
        true
      );
    } finally {
      stopReal();
    }
  });

  it("retires a replaced load's pending observations and drops its stragglers", () => {
    const { metrics, sent, stopReal } = startReal();
    try {
      metrics.registerViewOrigin("acme.demo", OLD_VIEW);
      metrics.recordCommit("acme.demo", 5, 10, OLD);
      metrics.recordCommit("acme.demo", 6, 11, OLD);

      // The plugin is unloaded and reloaded inside one drain window: its new
      // view loads from a fresh authority before the old buffer is sent.
      metrics.registerViewOrigin("acme.demo", NEW_VIEW);
      metrics.recordCommit("acme.demo", 7, 12, NEW);
      // A commit the outgoing view makes after its successor mounted.
      metrics.recordCommit("acme.demo", 50, 13, OLD);
      expect(metrics.getLocalSnapshot("acme.demo")!.viewCommits!.count).toBe(1);

      vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS);
      expect(sent).toHaveBeenCalledTimes(1);
      const envelopes = sent.mock.calls[0]![0];
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]!.generation).toBe("pi-new");
      expect(envelopes[0]!.report.commitCount).toBe(1);
      expect(envelopes[0]!.report.commitDurationsMs).toEqual([7]);
      // The old load's scripts are no longer attributed to the plugin.
      expect(metrics.pluginIdForScriptUrl("plugin://pi-old/__dtv-1/chunk.js")).toBeUndefined();
      expect(metrics.pluginIdForScriptUrl("plugin://pi-new/__dtv-2/chunk.js")).toBe("acme.demo");
    } finally {
      stopReal();
    }
  });

  it("sends a view load after a short debounce rather than the commit delay", () => {
    vi.useFakeTimers();
    const { metrics, sent, stopReal } = startReal();
    try {
      metrics.registerViewOrigin("acme.demo", NEW_VIEW);
      metrics.recordCommit("acme.demo", 7, 12, NEW);
      metrics.recordViewLoad(
        "acme.demo",
        {
          kindId: "acme.demo.main",
          activateMs: 80,
          importMs: 40,
          stylesMs: 90,
          loadMs: 95,
          firstPaintMs: 120,
          retry: false,
          at: 1,
        },
        NEW
      );
      vi.advanceTimersByTime(VIEW_LOAD_DRAIN_DELAY_MS - 1);
      expect(sent).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(sent).toHaveBeenCalledTimes(1);
      const [envelope] = sent.mock.calls[0]![0];
      expect(envelope!.report.viewLoads.map((load) => load.loadMs)).toEqual([95]);
      // The commit went with it, and the commit timer it had armed is gone.
      expect(envelope!.report.commitCount).toBe(1);
      vi.advanceTimersByTime(REPORT_DRAIN_DELAY_MS);
      expect(sent).toHaveBeenCalledTimes(1);
    } finally {
      stopReal();
      vi.useRealTimers();
    }
  });
});
