import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetStartupInvokeTrackerForTesting,
  claimStartupWaitSnapshot,
  endStartupTracking,
  markStartupStep,
  trackStartupInvoke,
} from "../startupInvokeTracker.js";

const REPORT = "app:report-startup-stuck";

function sender(id: number, destroyed = false) {
  return { id, isDestroyed: () => destroyed };
}

function never(): Promise<never> {
  return new Promise(() => {});
}

describe("startupInvokeTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    _resetStartupInvokeTrackerForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks nothing for a view that never asked for its boot payload", () => {
    const view = sender(1);
    trackStartupInvoke(view, "worktree:get-all-with-status", never);

    expect(claimStartupWaitSnapshot(view, REPORT)).toEqual({
      bootRequested: false,
      sinceBootMs: null,
      pendingCount: 0,
      pending: [],
    });
  });

  it("lists the invokes still open since app:boot, oldest first, with the boot step", async () => {
    const view = sender(2);
    trackStartupInvoke(view, "app:boot", never);
    vi.advanceTimersByTime(1_000);
    markStartupStep(2, "project-state-read");
    trackStartupInvoke(view, "worktree:get-all-with-status", never);
    trackStartupInvoke(view, "terminal:get-for-project", () => Promise.resolve([]));
    trackStartupInvoke(view, REPORT, never);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(claimStartupWaitSnapshot(view, REPORT)).toEqual({
      bootRequested: true,
      sinceBootMs: 6_000,
      pendingCount: 2,
      pending: [
        { channel: "app:boot", pendingMs: 6_000, step: "project-state-read" },
        { channel: "worktree:get-all-with-status", pendingMs: 5_000 },
      ],
    });
  });

  it("drops invokes as they settle, whether they resolve, reject or throw", async () => {
    const view = sender(3);
    trackStartupInvoke(view, "app:boot", () => Promise.resolve("boot"));
    const rejected = trackStartupInvoke(view, "a:rejects", () => Promise.reject(new Error("no")));
    expect(() =>
      trackStartupInvoke(view, "a:throws", () => {
        throw new Error("sync");
      })
    ).toThrow("sync");
    expect(trackStartupInvoke(view, "a:sync", () => 42)).toBe(42);
    await expect(rejected).rejects.toThrow("no");

    expect(claimStartupWaitSnapshot(view, REPORT)?.pending).toEqual([]);
  });

  it("reports once per document, and again after a reload's app:boot", () => {
    const view = sender(4);
    trackStartupInvoke(view, "app:boot", never);
    expect(claimStartupWaitSnapshot(view, REPORT)).not.toBeNull();
    expect(claimStartupWaitSnapshot(view, REPORT)).toBeNull();

    trackStartupInvoke(view, "app:boot", never);
    const afterReload = claimStartupWaitSnapshot(view, REPORT);
    // The first document's open app:boot belongs to a session nothing reads.
    expect(afterReload?.pendingCount).toBe(1);
  });

  it("stops tracking at first-interactive", () => {
    const view = sender(5);
    trackStartupInvoke(view, "app:boot", () => Promise.resolve());
    endStartupTracking(5);
    trackStartupInvoke(view, "worktree:get-all-with-status", never);

    expect(claimStartupWaitSnapshot(view, REPORT)?.bootRequested).toBe(false);
  });

  it("forgets a view destroyed mid-startup when the next session opens", () => {
    const gone = sender(6, true);
    trackStartupInvoke(gone, "app:boot", never);
    trackStartupInvoke(sender(7), "app:boot", never);

    expect(claimStartupWaitSnapshot(gone, REPORT)?.bootRequested).toBe(false);
  });

  it("caps the list while counting everything open", () => {
    const view = sender(8);
    trackStartupInvoke(view, "app:boot", never);
    for (let i = 0; i < 30; i++) trackStartupInvoke(view, `x:${i}`, never);

    const snapshot = claimStartupWaitSnapshot(view, REPORT);
    expect(snapshot?.pendingCount).toBe(31);
    expect(snapshot?.pending).toHaveLength(20);
    expect(snapshot?.pending[0]?.channel).toBe("app:boot");
  });

  it("passes calls with no sender straight through", () => {
    expect(trackStartupInvoke(undefined, "app:boot", () => "ok")).toBe("ok");
  });
});
