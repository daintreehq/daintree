import { describe, expect, it, vi } from "vitest";
import type { PluginViewLoadSample } from "@shared/types/pluginMetrics";
import {
  MAX_PENDING_COMMITS,
  MAX_PENDING_LONG_FRAMES,
  MAX_PENDING_VIEW_LOADS,
  MAX_RECENT_VIEW_LOADS,
  MAX_TRACKED_PLUGINS,
  createPluginViewMetrics,
} from "../pluginViewMetrics";

function sample(overrides: Partial<PluginViewLoadSample> = {}): PluginViewLoadSample {
  return {
    kindId: "acme.dashboard",
    activateMs: 1,
    importMs: 2,
    stylesMs: 3,
    firstPaintMs: 10,
    retry: false,
    at: 1,
    ...overrides,
  };
}

describe("pluginViewMetrics", () => {
  it("drains per-plugin deltas once and then reports nothing", () => {
    const metrics = createPluginViewMetrics();
    metrics.recordViewLoad("acme", sample());
    metrics.recordCommit("acme", 4, 104);
    metrics.recordCommit("beta", 2, 202);
    metrics.recordLongFrame("acme", { durationMs: 80, blockingMs: 30, source: "commit", at: 5 });

    const reports = metrics.drainReports();
    expect(reports).toHaveLength(2);
    expect(reports.find((r) => r.pluginId === "acme")).toEqual({
      pluginId: "acme",
      viewLoads: [sample()],
      commitDurationsMs: [4],
      commitCount: 1,
      longFrames: [{ durationMs: 80, blockingMs: 30, source: "commit", at: 5 }],
      longFramesDropped: { count: 0, blockingMs: 0 },
    });
    expect(reports.find((r) => r.pluginId === "beta")?.commitDurationsMs).toEqual([2]);

    expect(metrics.drainReports()).toEqual([]);
    metrics.recordCommit("beta", 7, 307);
    expect(metrics.drainReports()).toEqual([
      {
        pluginId: "beta",
        viewLoads: [],
        commitDurationsMs: [7],
        commitCount: 1,
        longFrames: [],
        longFramesDropped: { count: 0, blockingMs: 0 },
      },
    ]);
  });

  it("keeps the local snapshot across drains", () => {
    const metrics = createPluginViewMetrics();
    expect(metrics.getLocalSnapshot("acme")).toBeNull();
    metrics.recordViewLoad("acme", sample());
    for (const d of [1, 2, 3, 4, 100]) metrics.recordCommit("acme", d, d);
    metrics.recordLongFrame("acme", { durationMs: 90, blockingMs: 40, source: "script", at: 9 });
    metrics.drainReports();

    const snapshot = metrics.getLocalSnapshot("acme")!;
    expect(snapshot.viewLoads).toEqual([sample()]);
    expect(snapshot.viewCommits).toEqual({
      count: 5,
      p50Ms: 3,
      p95Ms: 100,
      maxMs: 100,
      lastMs: 100,
    });
    expect(snapshot.longFrames).toEqual({ count: 1, totalBlockingMs: 40, lastAt: 9 });
  });

  it("bounds pending commits between drains and keeps the window's worst", () => {
    const metrics = createPluginViewMetrics();
    const total = MAX_PENDING_COMMITS * 4;
    for (let i = 0; i < total; i++) {
      metrics.recordCommit("acme", i === total / 2 ? 999 : 1 + (i % 10), i + 1);
    }
    const [report] = metrics.drainReports();
    expect(report!.commitDurationsMs).toHaveLength(MAX_PENDING_COMMITS);
    expect(report!.commitCount).toBe(total);
    expect(Math.max(...report!.commitDurationsMs)).toBe(999);
    expect(metrics.getLocalSnapshot("acme")!.viewCommits!.count).toBe(total);
  });

  it("bounds pending view loads, recent view loads and long frames", () => {
    const metrics = createPluginViewMetrics();
    for (let i = 0; i < MAX_PENDING_VIEW_LOADS + 10; i++)
      metrics.recordViewLoad("acme", sample({ at: i }));
    for (let i = 0; i < MAX_PENDING_LONG_FRAMES + 10; i++) {
      metrics.recordLongFrame("acme", {
        durationMs: 60,
        blockingMs: i < MAX_PENDING_LONG_FRAMES ? 10 : 7,
        source: "commit",
        at: i,
      });
    }
    expect(metrics.getLocalSnapshot("acme")!.viewLoads).toHaveLength(MAX_RECENT_VIEW_LOADS);
    expect(metrics.getLocalSnapshot("acme")!.viewLoads.at(-1)!.at).toBe(MAX_PENDING_VIEW_LOADS + 9);
    const [report] = metrics.drainReports();
    expect(report!.viewLoads).toHaveLength(MAX_PENDING_VIEW_LOADS);
    expect(report!.viewLoads[0]!.at).toBe(10);
    expect(report!.longFrames).toHaveLength(MAX_PENDING_LONG_FRAMES);
    expect(report!.longFrames.at(-1)!.at).toBe(MAX_PENDING_LONG_FRAMES - 1);
    expect(report!.longFramesDropped).toEqual({ count: 10, blockingMs: 70 });
    // The running totals are not bounded by the pending buffer.
    expect(metrics.getLocalSnapshot("acme")!.longFrames.count).toBe(MAX_PENDING_LONG_FRAMES + 10);
  });

  it("notifies subscribers once per drain window, not once per record", () => {
    const metrics = createPluginViewMetrics();
    const listener = vi.fn();
    const unsubscribe = metrics.subscribe(listener);
    metrics.recordCommit("acme", 1, 1);
    metrics.recordCommit("acme", 1, 2);
    metrics.recordCommit("beta", 1, 3);
    expect(listener).toHaveBeenCalledTimes(1);
    metrics.drainReports();
    metrics.recordCommit("acme", 1, 4);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    metrics.drainReports();
    metrics.recordCommit("acme", 1, 5);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("maps plugin:// script URLs to the plugin that loaded views from that authority", () => {
    const metrics = createPluginViewMetrics();
    metrics.registerViewOrigin("acme@1", "plugin://acme-auth/__dtv-1/view.js");
    expect(metrics.pluginIdForScriptUrl("plugin://acme-auth/__dtv-1/chunk.js")).toBe("acme@1");
    expect(metrics.pluginIdForScriptUrl("plugin://other/view.js")).toBeUndefined();
    expect(metrics.pluginIdForScriptUrl("app://daintree/assets/index.js")).toBeUndefined();
    expect(metrics.pluginIdForScriptUrl("")).toBeUndefined();
  });

  it("finds plugins whose commit time falls in a time range", () => {
    const metrics = createPluginViewMetrics();
    metrics.recordCommit("acme", 5, 105);
    metrics.recordCommit("beta", 5, 305);
    expect(metrics.pluginsCommittingDuring(100, 106)).toEqual(["acme"]);
    expect(metrics.pluginsCommittingDuring(90, 101)).toEqual([]);
    expect(metrics.pluginsCommittingDuring(0, 400).sort()).toEqual(["acme", "beta"]);
    expect(metrics.pluginsCommittingDuring(200, 250)).toEqual([]);
  });

  it("keeps a fixed number of commit windows", () => {
    const metrics = createPluginViewMetrics();
    metrics.recordCommit("old", 1, 1);
    for (let i = 0; i < 64; i++) metrics.recordCommit("new", 1, 1001 + i);
    expect(metrics.pluginsCommittingDuring(0, 2)).toEqual([]);
  });

  it("tracks long frames only while a view is mounted", () => {
    const metrics = createPluginViewMetrics();
    expect(metrics.isTracking()).toBe(false);
    const releaseA = metrics.retainView("acme");
    const releaseB = metrics.retainView("acme");
    expect(metrics.isTracking()).toBe(true);
    releaseA();
    releaseA();
    expect(metrics.isTracking()).toBe(true);
    releaseB();
    expect(metrics.isTracking()).toBe(false);
  });

  it("keeps the window's worst commit even when costs keep climbing", () => {
    const metrics = createPluginViewMetrics();
    const total = MAX_PENDING_COMMITS * 8;
    for (let i = 0; i < total; i++) metrics.recordCommit("acme", i, i + 1);
    const [report] = metrics.drainReports();
    expect(report!.commitDurationsMs).toHaveLength(MAX_PENDING_COMMITS);
    expect(Math.max(...report!.commitDurationsMs)).toBe(total - 1);
    // A uniform sample of 0..total spreads across the range rather than
    // bunching at the most recent commits.
    const belowHalf = report!.commitDurationsMs.filter((d) => d < total / 2).length;
    expect(belowHalf).toBeGreaterThan(MAX_PENDING_COMMITS / 4);
  });

  it("bounds the plugins and authorities it remembers", () => {
    const metrics = createPluginViewMetrics();
    const releaseOpen = metrics.retainView("open");
    metrics.recordCommit("open", 1, 1);
    metrics.drainReports();
    for (let i = 0; i < 200; i++) {
      metrics.recordViewLoad(`p${i}`, sample());
      metrics.drainReports();
      metrics.registerViewOrigin(`p${i}`, `plugin://auth-${i}/view.js`);
    }
    expect(metrics.getLocalSnapshot("open")).not.toBeNull();
    expect(metrics.getLocalSnapshot("p0")).toBeNull();
    expect(metrics.getLocalSnapshot("p199")).not.toBeNull();
    expect(metrics.pluginIdForScriptUrl("plugin://auth-0/view.js")).toBeUndefined();
    expect(metrics.pluginIdForScriptUrl("plugin://auth-199/view.js")).toBe("p199");
    releaseOpen();
  });

  it("attributes by commit time, not by a window rebuilt from actualDuration", () => {
    const metrics = createPluginViewMetrics();
    // 40ms of render work summed across yields, committing at 500: the frame
    // that ended at 470 did not contain the commit.
    metrics.recordCommit("acme", 40, 500);
    expect(metrics.pluginsCommittingDuring(420, 470)).toEqual([]);
    expect(metrics.pluginsCommittingDuring(490, 600)).toEqual(["acme"]);
  });

  it("requests an early drain once per window as pending buffers near their caps", () => {
    const metrics = createPluginViewMetrics();
    const requested = vi.fn();
    const off = metrics.onDrainRequested(requested);
    const highWater = Math.floor(MAX_PENDING_COMMITS * 0.75);
    for (let i = 0; i < highWater - 1; i++) metrics.recordCommit("acme", 1, i);
    expect(requested).not.toHaveBeenCalled();
    metrics.recordCommit("acme", 1, highWater);
    expect(requested).toHaveBeenCalledTimes(1);
    for (let i = 0; i < MAX_PENDING_COMMITS; i++) metrics.recordCommit("acme", 1, i);
    for (let i = 0; i < MAX_PENDING_LONG_FRAMES; i++) {
      metrics.recordLongFrame("beta", { durationMs: 60, blockingMs: 1, source: "commit", at: i });
    }
    expect(requested).toHaveBeenCalledTimes(1);

    metrics.drainReports();
    for (let i = 0; i < Math.floor(MAX_PENDING_LONG_FRAMES * 0.75); i++) {
      metrics.recordLongFrame("beta", { durationMs: 60, blockingMs: 1, source: "commit", at: i });
    }
    expect(requested).toHaveBeenCalledTimes(2);

    metrics.drainReports();
    for (let i = 0; i < Math.floor(MAX_PENDING_VIEW_LOADS * 0.75); i++) {
      metrics.recordViewLoad("gamma", sample({ at: i }));
    }
    expect(requested).toHaveBeenCalledTimes(3);
    off();
    metrics.drainReports();
    for (let i = 0; i < MAX_PENDING_COMMITS; i++) metrics.recordCommit("acme", 1, i);
    expect(requested).toHaveBeenCalledTimes(3);
  });

  it("finishes the record before a drain listener that drains synchronously", () => {
    const metrics = createPluginViewMetrics();
    const drained: number[][] = [];
    const notified = vi.fn();
    metrics.subscribe(notified);
    metrics.onDrainRequested(() => {
      for (const r of metrics.drainReports()) drained.push(r.commitDurationsMs);
    });
    const highWater = Math.floor(MAX_PENDING_COMMITS * 0.75);
    for (let i = 0; i < highWater; i++)
      metrics.recordCommit("acme", i === highWater - 1 ? 50 : 1, i);
    expect(drained).toHaveLength(1);
    expect(drained[0]).toHaveLength(highWater);
    expect(drained[0]!.at(-1)).toBe(50);
    // Nothing is pending after that drain, so no stale max and no empty notification.
    expect(metrics.drainReports()).toEqual([]);
    expect(notified).toHaveBeenCalledTimes(1);
    metrics.recordCommit("acme", 2, 1000);
    expect(metrics.drainReports()[0]!.commitDurationsMs).toEqual([2]);
  });

  it("ignores a view release left over from before reset()", () => {
    const metrics = createPluginViewMetrics();
    const stale = metrics.retainView("acme");
    metrics.reset();
    const release = metrics.retainView("acme");
    stale();
    expect(metrics.isTracking()).toBe(true);
    release();
    expect(metrics.isTracking()).toBe(false);
  });

  it("evicts closed plugins once their data has drained, keeping open ones", () => {
    const metrics = createPluginViewMetrics();
    const releases = Array.from({ length: MAX_TRACKED_PLUGINS + 20 }, (_, i) => {
      const release = metrics.retainView(`p${i}`);
      metrics.recordCommit(`p${i}`, 1, i);
      return release;
    });
    metrics.drainReports();
    // Every entry is open, so none can go even past the cap.
    expect(metrics.getLocalSnapshot("p0")).not.toBeNull();

    // Closing views brings the map back under the cap without another drain.
    for (const release of releases.slice(0, 40)) release();
    let kept = 0;
    for (let i = 0; i < MAX_TRACKED_PLUGINS + 20; i++) {
      if (metrics.getLocalSnapshot(`p${i}`)) kept++;
    }
    expect(kept).toBe(MAX_TRACKED_PLUGINS);
    expect(metrics.getLocalSnapshot("p0")).toBeNull();
    expect(metrics.getLocalSnapshot("p83")).not.toBeNull();
  });

  it("keeps pending data of closed plugins until it drains, then evicts", () => {
    const metrics = createPluginViewMetrics();
    for (let i = 0; i < MAX_TRACKED_PLUGINS + 10; i++) metrics.recordCommit(`p${i}`, 1, i);
    // Nothing drained yet: every entry still holds a pending delta.
    expect(metrics.getLocalSnapshot("p0")).not.toBeNull();
    const reports = metrics.drainReports();
    expect(reports).toHaveLength(MAX_TRACKED_PLUGINS + 10);
    expect(metrics.getLocalSnapshot("p0")).toBeNull();
    expect(metrics.getLocalSnapshot(`p${MAX_TRACKED_PLUGINS + 9}`)).not.toBeNull();
  });

  it("never evicts the entry it is creating, even when every other entry is protected", () => {
    const metrics = createPluginViewMetrics();
    for (let i = 0; i < MAX_TRACKED_PLUGINS; i++) metrics.retainView(`open${i}`);
    for (let i = 0; i < MAX_TRACKED_PLUGINS; i++) metrics.recordCommit(`open${i}`, 1, i);
    metrics.drainReports();
    metrics.recordViewLoad("fresh", sample());
    const [report] = metrics.drainReports();
    expect(report!.pluginId).toBe("fresh");
    expect(report!.viewLoads).toEqual([sample()]);
  });
});
