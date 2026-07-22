import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PluginInstallJobRegistry,
  PLUGIN_INSTALL_PROGRESS_THROTTLE_MS,
  isInstallCancellation,
} from "../PluginInstallJobRegistry.js";
import type { PluginInstallProgressEvent } from "../../../../shared/types/plugin.js";

describe("PluginInstallJobRegistry (#11302)", () => {
  let registry: PluginInstallJobRegistry;
  let events: PluginInstallProgressEvent[];
  const emit = (e: PluginInstallProgressEvent) => events.push(e);

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new PluginInstallJobRegistry();
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands back a live signal for a registered job and nothing for an unknown one", () => {
    const signal = registry.begin("job-1", emit);
    expect(signal?.aborted).toBe(false);
    expect(registry.signal("job-1")).toBe(signal);
    expect(registry.signal("job-2")).toBeUndefined();
    expect(registry.signal(undefined)).toBeUndefined();
  });

  it("refuses to re-register a live id so a second caller can't hijack the job", () => {
    const first = registry.begin("job-1", emit);
    expect(registry.begin("job-1", emit)).toBeNull();
    // The original job keeps its own controller — cancelling still targets it.
    registry.cancel("job-1");
    expect(first?.aborted).toBe(true);
  });

  it("aborts with a reason the installer can recognise as a cancel", () => {
    const signal = registry.begin("job-1", emit);
    expect(registry.cancel("job-1")).toBe(true);
    expect(isInstallCancellation(signal?.reason)).toBe(true);
    expect(isInstallCancellation(new Error("something else"))).toBe(false);
  });

  it("reports failure when cancelling an unknown job", () => {
    expect(registry.cancel("never-registered")).toBe(false);
  });

  it("cancels only once — a second cancel reports that nothing was done", () => {
    registry.begin("job-1", emit);
    expect(registry.cancel("job-1")).toBe(true);
    expect(registry.cancel("job-1")).toBe(false);
  });

  it("pushes phase changes immediately, without waiting on the entry throttle", () => {
    registry.begin("job-1", emit);
    registry.setPhase("job-1", "extracting");
    registry.setPhase("job-1", "validating");
    expect(events.map((e) => e.phase)).toEqual(["extracting", "validating"]);
  });

  it("coalesces an entry burst down to the first and the last", () => {
    registry.begin("job-1", emit);
    registry.setPhase("job-1", "extracting");
    events.length = 0;

    registry.reportEntry("job-1", "a.js");
    registry.reportEntry("job-1", "b.js");
    registry.reportEntry("job-1", "c.js");
    // Leading edge only so far — the rest are still behind the trailing timer.
    expect(events.map((e) => e.entry)).toEqual(["a.js"]);

    vi.advanceTimersByTime(PLUGIN_INSTALL_PROGRESS_THROTTLE_MS);
    // The burst settles on the newest entry, not a stale middle one.
    expect(events.map((e) => e.entry)).toEqual(["a.js", "c.js"]);
  });

  it("drops a queued entry when the phase moves on, so no stale row outlives it", () => {
    registry.begin("job-1", emit);
    registry.setPhase("job-1", "extracting");
    registry.reportEntry("job-1", "a.js");
    registry.reportEntry("job-1", "b.js");
    events.length = 0;

    registry.setPhase("job-1", "validating");
    vi.advanceTimersByTime(PLUGIN_INSTALL_PROGRESS_THROTTLE_MS * 2);
    expect(events).toEqual([{ jobId: "job-1", phase: "validating", cancellable: true }]);
  });

  it("ignores progress for a job that was never registered", () => {
    registry.setPhase("ghost", "extracting");
    registry.reportEntry("ghost", "a.js");
    vi.advanceTimersByTime(PLUGIN_INSTALL_PROGRESS_THROTTLE_MS);
    expect(events).toEqual([]);
  });

  it("closes the cancel window at commit and reports it on later events", () => {
    registry.begin("job-1", emit);
    expect(registry.isCancellable("job-1")).toBe(true);
    expect(registry.commit("job-1")).toBe(true);
    expect(registry.isCancellable("job-1")).toBe(false);

    registry.setPhase("job-1", "activating");
    expect(events.at(-1)).toEqual({
      jobId: "job-1",
      phase: "activating",
      cancellable: false,
    });
  });

  it("refuses a cancel once the job has committed", () => {
    registry.begin("job-1", emit);
    registry.commit("job-1");
    expect(registry.cancel("job-1")).toBe(false);
  });

  it("reports a lost commit race so the installer bails instead of committing", () => {
    registry.begin("job-1", emit);
    registry.cancel("job-1");
    expect(registry.commit("job-1")).toBe(false);
  });

  it("treats commit for an untracked job as permission to proceed", () => {
    // Installs without a jobId must not be blocked by the registry.
    expect(registry.commit(undefined)).toBe(true);
    expect(registry.commit("ghost")).toBe(true);
  });

  it("drops the record and its pending timer on end", () => {
    registry.begin("job-1", emit);
    registry.setPhase("job-1", "extracting");
    registry.reportEntry("job-1", "a.js");
    registry.reportEntry("job-1", "b.js");
    events.length = 0;

    registry.end("job-1");
    expect(registry.size).toBe(0);
    expect(registry.signal("job-1")).toBeUndefined();

    // The queued trailing emission must not fire after the job is gone.
    vi.advanceTimersByTime(PLUGIN_INSTALL_PROGRESS_THROTTLE_MS * 2);
    expect(events).toEqual([]);
  });

  it("is idempotent on end", () => {
    registry.begin("job-1", emit);
    registry.end("job-1");
    registry.end("job-1");
    registry.end(undefined);
    expect(registry.size).toBe(0);
  });

  it("keeps concurrent jobs isolated", () => {
    const a = registry.begin("job-a", emit);
    const b = registry.begin("job-b", emit);
    registry.cancel("job-a");
    expect(a?.aborted).toBe(true);
    expect(b?.aborted).toBe(false);
    expect(registry.size).toBe(2);
  });
});
