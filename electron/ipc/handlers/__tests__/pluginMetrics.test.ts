// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: unknown, payload?: unknown) => void>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn((channel: string, fn: (event: unknown, payload?: unknown) => void) => {
      listeners.set(channel, fn);
    }),
    removeListener: vi.fn((channel: string) => {
      listeners.delete(channel);
    }),
  },
}));

vi.mock("../../utils.js", () => ({
  typedHandle: vi.fn(() => () => {}),
  typedHandleValidated: vi.fn(() => () => {}),
  typedHandleWithContext: vi.fn(() => () => {}),
  typedHandleWithContextValidated: vi.fn(() => () => {}),
}));

import { CHANNELS } from "../../channels.js";
import { MAX_REPORTS_PER_SECOND, registerPluginMetricsHandlers } from "../pluginMetrics.js";
import {
  MAX_REPORTED_COMMITS,
  MAX_REPORTS_PER_MESSAGE,
  parseRendererMetricsEnvelopes,
} from "../../../schemas/pluginMetrics.js";
import { PluginMetricsService } from "../../../services/plugin/PluginMetricsService.js";
import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";

const PROJECT_A_PLUGIN = makeProjectPluginInstanceKey("proj-a", "acme.local");
const senderProjects = new Map<number, string>();

interface FakeSender extends EventEmitter {
  id: number;
  destroyed: boolean;
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
}

let nextId = 1;
function makeSender(): FakeSender {
  const wc = new EventEmitter() as FakeSender;
  wc.id = nextId++;
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  wc.send = vi.fn();
  return wc;
}

function validReport(pluginId = "acme.demo") {
  return {
    pluginId,
    viewLoads: [
      {
        kindId: "acme.demo.panel",
        activateMs: 10,
        importMs: 20,
        stylesMs: 5,
        loadMs: 25,
        firstPaintMs: 40,
        retry: false,
        at: 1,
      },
    ],
    commitDurationsMs: [3, 4],
    commitCount: 2,
    longFramesDropped: { count: 0, blockingMs: 0 },
    longFrames: [{ durationMs: 70, blockingMs: 20, source: "commit", at: 5 }],
  };
}

/** The live load's `plugin://` authority, per plugin; see `isCurrentGeneration`. */
const liveGenerations = new Map<string, string>();
const generationFor = (pluginId: string) => liveGenerations.get(pluginId) ?? `pi-${pluginId}`;

/** Tag reports the way the renderer's reporter does. */
function envelopes(...reports: Array<ReturnType<typeof validReport>>) {
  return reports.map((report) => ({ generation: generationFor(report.pluginId), report }));
}

/** The report-level parse, through the envelope parser the channel uses. */
function parseRendererMetricsReports(payload: unknown) {
  const wrapped = Array.isArray(payload)
    ? payload.map((report: unknown) => ({ generation: "pi-test", report }))
    : payload;
  return parseRendererMetricsEnvelopes(wrapped).map((envelope) => envelope.report);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

let metrics: PluginMetricsService;
let cleanup: () => void;

beforeEach(() => {
  listeners.clear();
  senderProjects.clear();
  liveGenerations.clear();
  metrics = new PluginMetricsService({
    host: {
      isKnownPlugin: (id) => id === "acme.demo" || id === PROJECT_A_PLUGIN,
      isCurrentGeneration: (id, generation) => generation === generationFor(id),
      isolationOf: () => "worker",
      workerPids: () => [],
    },
    sampleProcessMemory: () => [],
  });
  cleanup = registerPluginMetricsHandlers({
    resolveMetrics: async () => metrics,
    projectFor: (id) => senderProjects.get(id) ?? null,
  });
});

afterEach(() => {
  cleanup();
  metrics.dispose();
});

function emit(channel: string, sender: FakeSender, payload?: unknown): void {
  const fn = listeners.get(channel);
  if (!fn) throw new Error(`no listener for ${channel}`);
  fn({ sender }, payload);
}

describe("parseRendererMetricsReports", () => {
  it("accepts a well-formed report and strips unknown keys", () => {
    const [parsed] = parseRendererMetricsReports([{ ...validReport(), extra: "x" }]);
    expect(parsed).toEqual(validReport());
  });

  it("drops a malformed report without dropping the rest of the message", () => {
    const parsed = parseRendererMetricsReports([
      { ...validReport(), commitCount: "lots" },
      { ...validReport(), pluginId: "" },
      { ...validReport(), longFrames: [{ durationMs: 1, blockingMs: 1, source: "evil", at: 1 }] },
      validReport(),
    ]);
    expect(parsed).toHaveLength(1);
  });

  it("drops a whole message whose combined arrays exceed the per-message budget", () => {
    const heavy = { ...validReport(), commitDurationsMs: new Array(1_000).fill(1) };
    expect(parseRendererMetricsReports(new Array(17).fill(heavy))).toEqual([]);
    expect(parseRendererMetricsReports(new Array(16).fill(heavy))).toHaveLength(16);
  });

  it("rejects non-finite numbers and oversize arrays", () => {
    expect(
      parseRendererMetricsReports([{ ...validReport(), commitDurationsMs: [Number.NaN] }])
    ).toEqual([]);
    expect(
      parseRendererMetricsReports([
        { ...validReport(), commitDurationsMs: [Number.POSITIVE_INFINITY] },
      ])
    ).toEqual([]);
    expect(
      parseRendererMetricsReports([
        { ...validReport(), commitDurationsMs: new Array(MAX_REPORTED_COMMITS + 1).fill(1) },
      ])
    ).toEqual([]);
  });

  it("clamps negative and absurd values instead of storing them", () => {
    const [parsed] = parseRendererMetricsReports([
      {
        ...validReport(),
        commitDurationsMs: [-5, 1e12],
        commitCount: 2.7,
        longFramesDropped: { count: -3, blockingMs: -1 },
      },
    ]);
    expect(parsed!.commitDurationsMs[0]).toBe(0);
    expect(parsed!.commitDurationsMs[1]).toBeLessThanOrEqual(10 * 60_000);
    expect(parsed!.commitCount).toBe(2);
    expect(parsed!.longFramesDropped).toEqual({ count: 0, blockingMs: 0 });
  });

  it("ignores a non-array payload and caps the reports per message", () => {
    expect(parseRendererMetricsReports({ pluginId: "acme.demo" })).toEqual([]);
    expect(parseRendererMetricsReports(null)).toEqual([]);
    const many = new Array(MAX_REPORTS_PER_MESSAGE + 20).fill(validReport());
    expect(parseRendererMetricsReports(many)).toHaveLength(MAX_REPORTS_PER_MESSAGE);
  });
});

describe("plugin:report-view-metrics", () => {
  it("records reports for loaded plugins and drops the rest", async () => {
    const sender = makeSender();
    emit(
      CHANNELS.PLUGIN_REPORT_VIEW_METRICS,
      sender,
      envelopes(validReport(), validReport("acme.unloaded"))
    );
    await flush();
    const snap = metrics.getSnapshot("acme.demo")!;
    expect(snap.viewLoads).toHaveLength(1);
    expect(snap.viewCommits?.count).toBe(2);
    expect(snap.longFrames.count).toBe(1);
    expect(metrics.getSnapshot("acme.unloaded")).toBeNull();
  });

  it("rate-limits a sender that floods reports", async () => {
    const sender = makeSender();
    for (let i = 0; i < MAX_REPORTS_PER_SECOND + 10; i++) {
      emit(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, sender, envelopes(validReport()));
    }
    await flush();
    expect(metrics.getSnapshot("acme.demo")!.longFrames.count).toBe(MAX_REPORTS_PER_SECOND);
    // Another renderer has its own budget.
    emit(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, makeSender(), envelopes(validReport()));
    await flush();
    expect(metrics.getSnapshot("acme.demo")!.longFrames.count).toBe(MAX_REPORTS_PER_SECOND + 1);
  });
});

describe("plugin:report-view-metrics load generations", () => {
  it("drops a report buffered across an unload and same-id reload", async () => {
    const sender = makeSender();
    liveGenerations.set("acme.demo", "pi-first");
    // Observed and buffered against the first load...
    const stale = envelopes(validReport());
    // ...which is unloaded (its metrics evicted) and reloaded under a fresh
    // authority before the renderer's drain lands.
    metrics.evict("acme.demo");
    liveGenerations.set("acme.demo", "pi-second");
    emit(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, sender, stale);
    await flush();
    expect(metrics.getAll()).toEqual([]);

    emit(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, sender, envelopes(validReport()));
    await flush();
    expect(metrics.getSnapshot("acme.demo")!.viewLoads).toHaveLength(1);
  });

  it("drops a report whose load is retired while the metrics service is still loading", async () => {
    cleanup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup = registerPluginMetricsHandlers({
      resolveMetrics: async () => {
        await gate;
        return metrics;
      },
      projectFor: (id) => senderProjects.get(id) ?? null,
    });
    liveGenerations.set("acme.demo", "pi-first");
    emit(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, makeSender(), envelopes(validReport()));
    liveGenerations.set("acme.demo", "pi-second");
    release();
    await flush();
    expect(metrics.getAll()).toEqual([]);
  });

  it("rejects an entry without a generation or with a bare report", async () => {
    emit(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, makeSender(), [
      validReport(),
      { report: validReport() },
      { generation: "", report: validReport() },
    ]);
    await flush();
    expect(metrics.getAll()).toEqual([]);
  });
});

describe("project scoping", () => {
  it("accepts reports for a project instance only from that project's views", async () => {
    const other = makeSender();
    senderProjects.set(other.id, "proj-b");
    emit(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, other, envelopes(validReport(PROJECT_A_PLUGIN)));
    await flush();
    expect(metrics.getAll()).toEqual([]);

    const own = makeSender();
    senderProjects.set(own.id, "proj-a");
    emit(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, own, envelopes(validReport(PROJECT_A_PLUGIN)));
    await flush();
    expect(metrics.getSnapshot(PROJECT_A_PLUGIN)!.viewLoads).toHaveLength(1);
  });

  it("pushes each subscriber only the plugins its project can see", async () => {
    vi.useFakeTimers();
    try {
      const a = makeSender();
      const b = makeSender();
      senderProjects.set(a.id, "proj-a");
      senderProjects.set(b.id, "proj-b");
      emit(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, a);
      emit(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, b);
      await vi.advanceTimersByTimeAsync(0);
      metrics.recordInvoke("acme.demo", 1, "ok");
      metrics.recordInvoke(PROJECT_A_PLUGIN, 1, "ok");
      await vi.advanceTimersByTimeAsync(1_000);
      const idsSentTo = (wc: FakeSender) =>
        (wc.send.mock.calls.at(-1)![1] as Array<{ pluginId: string }>).map((s) => s.pluginId);
      expect(idsSentTo(a).sort()).toEqual(["acme.demo", PROJECT_A_PLUGIN].sort());
      expect(idsSentTo(b)).toEqual(["acme.demo"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("perf snapshot subscription", () => {
  it("pushes snapshots only to subscribers, and only while subscribed", async () => {
    vi.useFakeTimers();
    try {
      const subscriber = makeSender();
      const bystander = makeSender();
      emit(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, subscriber);
      await vi.advanceTimersByTimeAsync(0);

      metrics.recordInvoke("acme.demo", 5, "ok");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(subscriber.send).toHaveBeenCalledWith(
        CHANNELS.PLUGIN_PERF_SNAPSHOTS_CHANGED,
        expect.arrayContaining([expect.objectContaining({ pluginId: "acme.demo" })])
      );
      expect(bystander.send).not.toHaveBeenCalled();

      emit(CHANNELS.PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE, subscriber);
      subscriber.send.mockClear();
      metrics.recordInvoke("acme.demo", 5, "ok");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(subscriber.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a subscriber whose renderer is destroyed or navigates", async () => {
    vi.useFakeTimers();
    try {
      const gone = makeSender();
      const reloaded = makeSender();
      emit(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, gone);
      emit(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, reloaded);
      await vi.advanceTimersByTimeAsync(0);
      gone.destroyed = true;
      gone.emit("destroyed");
      reloaded.emit("did-navigate");
      metrics.recordInvoke("acme.demo", 5, "ok");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(gone.send).not.toHaveBeenCalled();
      expect(reloaded.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds worker memory sampling only while someone subscribes", async () => {
    const acquire = vi.spyOn(metrics, "acquireSampling");
    const sender = makeSender();
    emit(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, sender);
    emit(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, sender);
    await flush();
    expect(acquire).toHaveBeenCalledTimes(1);
    const release = acquire.mock.results[0]!.value as () => void;
    expect(typeof release).toBe("function");
    emit(CHANNELS.PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE, sender);
    // Re-subscribing starts a fresh hold.
    emit(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, sender);
    await flush();
    expect(acquire).toHaveBeenCalledTimes(2);
  });
});
