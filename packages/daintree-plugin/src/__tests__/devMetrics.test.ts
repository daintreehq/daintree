import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEV_METRICS_METHOD,
  DEV_METRICS_POLL_MS,
  createDevMetricsPoller,
  formatBytes,
  formatDevMetrics,
  formatMs,
} from "../lib/devMetrics.js";
import type { PluginPerfSnapshot } from "../../../../shared/types/pluginMetrics.js";

function snapshot(overrides: Partial<PluginPerfSnapshot> = {}): PluginPerfSnapshot {
  return {
    pluginId: "acme.demo",
    isolation: "worker",
    activation: null,
    viewLoads: [],
    viewCommits: null,
    invokes: {
      count: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      lastMs: 0,
      errors: 0,
      timeouts: 0,
      oversized: 0,
      promptWaits: 0,
    },
    pushes: {
      messages: 0,
      bytes: 0,
      perSecond: 0,
      bytesPerSecond: 0,
      peakPerSecond: 0,
      peakBytesPerSecond: 0,
      oversized: 0,
    },
    longFrames: { count: 0, totalBlockingMs: 0, lastAt: null },
    workerMemory: null,
    overBudget: [],
    since: 0,
    ...overrides,
  };
}

describe("formatDevMetrics", () => {
  it("shows placeholders, not zeros, for what has not been measured", () => {
    const text = formatDevMetrics(snapshot());
    expect(text).toMatchInlineSnapshot(`
      "Performance — acme.demo (worker)
        activation        —
        view load         —
        view first paint  —
        view commits p95  —  none observed (production builds do not report commits)
        invokes p50/p95   —
        pushes/s          —
        long frames       0
        worker RSS        —  no memory sample"
    `);
  });

  it("marks each value against its budget, naming both numbers when over", () => {
    const text = formatDevMetrics(
      snapshot({
        activation: { lastMs: 612, count: 1, at: 1 },
        viewLoads: [
          {
            kindId: "acme.demo.panel",
            activateMs: 100,
            importMs: 90,
            stylesMs: 40,
            loadMs: 170,
            firstPaintMs: 250,
            retry: false,
            at: 1,
          },
        ],
        viewCommits: { count: 40, p50Ms: 2, p95Ms: 7.25, maxMs: 9, lastMs: 3 },
        invokes: {
          count: 12,
          p50Ms: 3,
          p95Ms: 300,
          maxMs: 400,
          lastMs: 3,
          errors: 2,
          timeouts: 1,
          oversized: 0,
          promptWaits: 0,
        },
        pushes: {
          messages: 50,
          bytes: 5_000,
          perSecond: 4.25,
          bytesPerSecond: 2048,
          peakPerSecond: 20,
          peakBytesPerSecond: 4096,
          oversized: 0,
        },
        longFrames: { count: 2, totalBlockingMs: 130, lastAt: 5 },
        workerMemory: { rssBytes: 84 * 1024 * 1024, at: 1 },
        overBudget: ["activationMs", "invokeP95Ms"],
      })
    );
    expect(text).toMatchInlineSnapshot(`
      "Performance — acme.demo (worker)
        activation        612ms                                      over budget: 612ms > 500ms
        view load         170ms (acme.demo.panel)                    ✓ (budget 300ms)
        view first paint  250ms                                      ✓ (budget 500ms)
        view commits p95  7.3ms (40)                                 ✓ (budget 16ms)
        invokes p50/p95   3.0ms / 300ms (12, 2 failed, 1 timed out)  over budget: 300ms > 250ms
        pushes/s          4.3/s, 2.0 KB/s (peak 20.0/s, 4.0 KB/s)    ✓
        long frames       2 (130ms blocking)                         plugin activity observed during these frames
        worker RSS        84.0 MB                                    ✓ (budget 256.0 MB)"
    `);
  });

  it("lists both push budgets when both are exceeded", () => {
    const text = formatDevMetrics(
      snapshot({
        pushes: {
          messages: 900,
          bytes: 1,
          perSecond: 90,
          bytesPerSecond: 2 * 1024 * 1024,
          peakPerSecond: 90,
          peakBytesPerSecond: 2 * 1024 * 1024,
          oversized: 0,
        },
        overBudget: ["pushesPerSecond", "pushBytesPerSecond"],
      })
    );
    expect(text).toContain("over budget: 90.0/s > 60.0/s; over budget: 2.0 MB/s > 1.0 MB/s");
  });

  it("prefers the host's measured view load over rebuilding it from phases", () => {
    const load = {
      kindId: "acme.demo.panel",
      activateMs: 100,
      importMs: 90,
      stylesMs: 140,
      loadMs: 150,
      firstPaintMs: 250,
      retry: false,
      at: 1,
    };
    expect(formatDevMetrics(snapshot({ viewLoads: [load] }))).toContain("view load         150ms");
    // A Daintree from before `loadMs` sends only the phases.
    const { loadMs: _omitted, ...older } = load;
    expect(formatDevMetrics(snapshot({ viewLoads: [older as typeof load] }))).toContain(
      "view load         240ms"
    );
  });

  it("says how many invokes waited on a prompt and does not judge untimed latency", () => {
    const text = formatDevMetrics(
      snapshot({
        invokes: {
          count: 2,
          p50Ms: 0,
          p95Ms: 0,
          maxMs: 0,
          lastMs: 0,
          errors: 0,
          timeouts: 0,
          oversized: 0,
          promptWaits: 2,
        },
      })
    );
    expect(text).toContain("invokes p50/p95   — (2, 2 waited on a prompt, untimed)");
    expect(text).not.toContain("budget 250ms");
  });

  it("omits the worker row for an in-process plugin", () => {
    expect(formatDevMetrics(snapshot({ isolation: "in-process" }))).not.toContain("worker RSS");
  });

  it("is stable: the same snapshot always prints the same text", () => {
    const s = snapshot({ activation: { lastMs: 12.345, count: 3, at: 99 } });
    expect(formatDevMetrics(s)).toBe(formatDevMetrics({ ...s, since: 12345 }));
  });

  it("formats units compactly", () => {
    expect(formatMs(4.26)).toBe("4.3ms");
    expect(formatMs(612.4)).toBe("612ms");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("createDevMetricsPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls the dev plugin's snapshot and prints only when the table changes", async () => {
    const request = vi.fn(async () => ({ snapshot: snapshot() }));
    const print = vi.fn();
    const poller = createDevMetricsPoller({ pluginId: "acme.demo", request, print });
    poller.start();
    expect(request).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEV_METRICS_POLL_MS);
    expect(request).toHaveBeenCalledWith(
      DEV_METRICS_METHOD,
      { pluginId: "acme.demo" },
      { signal: expect.any(AbortSignal) }
    );
    expect(print).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEV_METRICS_POLL_MS * 3);
    expect(request).toHaveBeenCalledTimes(4);
    expect(print).toHaveBeenCalledTimes(1);

    request.mockImplementation(async () => ({
      snapshot: snapshot({ activation: { lastMs: 80, count: 2, at: 1 } }),
    }));
    await vi.advanceTimersByTimeAsync(DEV_METRICS_POLL_MS);
    expect(print).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("says once that an older Daintree has no metrics, then stops polling", async () => {
    const request = vi.fn(async () => {
      throw new Error("Unknown method: plugin.dev.metrics");
    });
    const print = vi.fn();
    const poller = createDevMetricsPoller({ pluginId: "acme.demo", request, print });
    poller.start();
    await vi.advanceTimersByTimeAsync(DEV_METRICS_POLL_MS * 5);
    expect(request).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(1);
    expect(print.mock.calls[0]![0]).toMatch(/unavailable/);
    poller.stop();
  });

  it("rides out transient failures and missing snapshots without printing", async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("Daintree isn't running.");
      if (calls === 2) return { snapshot: null };
      if (calls === 3) return { garbage: true };
      return { snapshot: snapshot() };
    });
    const print = vi.fn();
    const poller = createDevMetricsPoller({ pluginId: "acme.demo", request, print });
    poller.start();
    await vi.advanceTimersByTimeAsync(DEV_METRICS_POLL_MS * 3);
    expect(print).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEV_METRICS_POLL_MS);
    expect(print).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("aborts an in-flight poll on stop and prints nothing for it", async () => {
    let resolve!: (value: unknown) => void;
    let signal: AbortSignal | undefined;
    const request = vi.fn(
      (_method: string, _params: unknown, opts: { signal: AbortSignal }) =>
        new Promise((r) => {
          signal = opts.signal;
          resolve = r;
        })
    );
    const print = vi.fn();
    const poller = createDevMetricsPoller({ pluginId: "acme.demo", request, print });
    poller.start();
    await vi.advanceTimersByTimeAsync(DEV_METRICS_POLL_MS);
    expect(signal?.aborted).toBe(false);
    poller.stop();
    expect(signal?.aborted).toBe(true);
    resolve({ snapshot: snapshot() });
    await vi.advanceTimersByTimeAsync(DEV_METRICS_POLL_MS * 2);
    expect(print).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
