import { describe, expect, it, vi } from "vitest";
import type { PluginViewLoadSample } from "@shared/types/pluginMetrics";
import {
  MAX_PENDING_COMMITS,
  MAX_PENDING_LONG_FRAMES,
  MAX_PENDING_VIEW_LOADS,
  MAX_RECENT_VIEW_LOADS,
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
    metrics.recordCommit("acme", 4, 100, 104);
    metrics.recordCommit("beta", 2, 200, 202);
    metrics.recordLongFrame("acme", { durationMs: 80, blockingMs: 30, source: "commit", at: 5 });

    const reports = metrics.drainReports();
    expect(reports).toHaveLength(2);
    expect(reports.find((r) => r.pluginId === "acme")).toEqual({
      pluginId: "acme",
      viewLoads: [sample()],
      commitDurationsMs: [4],
      longFrames: [{ durationMs: 80, blockingMs: 30, source: "commit", at: 5 }],
    });
    expect(reports.find((r) => r.pluginId === "beta")?.commitDurationsMs).toEqual([2]);

    expect(metrics.drainReports()).toEqual([]);
    metrics.recordCommit("beta", 7, 300, 307);
    expect(metrics.drainReports()).toEqual([
      { pluginId: "beta", viewLoads: [], commitDurationsMs: [7], longFrames: [] },
    ]);
  });

  it("keeps the local snapshot across drains", () => {
    const metrics = createPluginViewMetrics();
    expect(metrics.getLocalSnapshot("acme")).toBeNull();
    metrics.recordViewLoad("acme", sample());
    for (const d of [1, 2, 3, 4, 100]) metrics.recordCommit("acme", d, 0, d);
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
      metrics.recordCommit("acme", i === total / 2 ? 999 : 1 + (i % 10), i, i + 1);
    }
    const [report] = metrics.drainReports();
    expect(report!.commitDurationsMs).toHaveLength(MAX_PENDING_COMMITS);
    expect(Math.max(...report!.commitDurationsMs)).toBe(999);
    expect(metrics.getLocalSnapshot("acme")!.viewCommits!.count).toBe(total);
  });

  it("bounds pending view loads, recent view loads and long frames", () => {
    const metrics = createPluginViewMetrics();
    for (let i = 0; i < MAX_PENDING_VIEW_LOADS + 10; i++)
      metrics.recordViewLoad("acme", sample({ at: i }));
    for (let i = 0; i < MAX_PENDING_LONG_FRAMES + 10; i++) {
      metrics.recordLongFrame("acme", { durationMs: 60, blockingMs: 10, source: "commit", at: i });
    }
    expect(metrics.getLocalSnapshot("acme")!.viewLoads).toHaveLength(MAX_RECENT_VIEW_LOADS);
    expect(metrics.getLocalSnapshot("acme")!.viewLoads.at(-1)!.at).toBe(MAX_PENDING_VIEW_LOADS + 9);
    const [report] = metrics.drainReports();
    expect(report!.viewLoads).toHaveLength(MAX_PENDING_VIEW_LOADS);
    expect(report!.viewLoads[0]!.at).toBe(10);
    expect(report!.longFrames).toHaveLength(MAX_PENDING_LONG_FRAMES);
    // The running totals are not bounded by the pending buffer.
    expect(metrics.getLocalSnapshot("acme")!.longFrames.count).toBe(MAX_PENDING_LONG_FRAMES + 10);
  });

  it("notifies subscribers once per drain window, not once per record", () => {
    const metrics = createPluginViewMetrics();
    const listener = vi.fn();
    const unsubscribe = metrics.subscribe(listener);
    metrics.recordCommit("acme", 1, 0, 1);
    metrics.recordCommit("acme", 1, 1, 2);
    metrics.recordCommit("beta", 1, 2, 3);
    expect(listener).toHaveBeenCalledTimes(1);
    metrics.drainReports();
    metrics.recordCommit("acme", 1, 3, 4);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    metrics.drainReports();
    metrics.recordCommit("acme", 1, 4, 5);
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

  it("finds plugins whose commit windows overlap a time range", () => {
    const metrics = createPluginViewMetrics();
    metrics.recordCommit("acme", 5, 100, 105);
    metrics.recordCommit("beta", 5, 300, 305);
    expect(metrics.pluginsCommittingDuring(90, 101)).toEqual(["acme"]);
    expect(metrics.pluginsCommittingDuring(0, 400).sort()).toEqual(["acme", "beta"]);
    expect(metrics.pluginsCommittingDuring(200, 250)).toEqual([]);
  });

  it("keeps a fixed number of commit windows", () => {
    const metrics = createPluginViewMetrics();
    metrics.recordCommit("old", 1, 0, 1);
    for (let i = 0; i < 64; i++) metrics.recordCommit("new", 1, 1000 + i, 1001 + i);
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
    for (let i = 0; i < total; i++) metrics.recordCommit("acme", i, i, i + 1);
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
    metrics.recordCommit("open", 1, 0, 1);
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

  it("confines a commit window to the render's own duration before the commit", () => {
    const metrics = createPluginViewMetrics();
    // Render began at 0, yielded, and did 5ms of work ending in a commit at 500.
    metrics.recordCommit("acme", 5, 0, 500);
    expect(metrics.pluginsCommittingDuring(100, 200)).toEqual([]);
    expect(metrics.pluginsCommittingDuring(490, 600)).toEqual(["acme"]);
  });
});
