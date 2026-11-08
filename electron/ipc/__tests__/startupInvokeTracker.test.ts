import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import {
  _resetStartupInvokeTrackerForTesting,
  claimStartupWaitSnapshot,
  endStartupTracking,
  startupStepper,
  trackStartupInvoke,
} from "../startupInvokeTracker.js";
import { getIpcDispatcher } from "../dispatcher.js";
import { wrapSuccess } from "../../../shared/utils/ipcErrorSerialization.js";

const REPORT = "app:report-startup-stuck";

function sender(id: number, destroyed = false) {
  return {
    id,
    destroyed,
    isDestroyed(): boolean {
      return this.destroyed;
    },
  };
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

    expect(claimStartupWaitSnapshot(view, REPORT, true)).toEqual({
      bootRequested: false,
      sinceBootMs: null,
      pendingCount: 0,
      pending: [],
    });
  });

  it("lists the invokes still open since app:boot, oldest first, with the boot step", async () => {
    const view = sender(2);
    trackStartupInvoke(view, "app:boot", () => {
      startupStepper(2)("project-state-read");
      return never();
    });
    vi.advanceTimersByTime(1_000);
    trackStartupInvoke(view, "worktree:get-all-with-status", never);
    trackStartupInvoke(view, "terminal:get-for-project", () => Promise.resolve([]));
    trackStartupInvoke(view, REPORT, never);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(claimStartupWaitSnapshot(view, REPORT, true)).toEqual({
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

    expect(claimStartupWaitSnapshot(view, REPORT, true)?.pending).toEqual([]);
  });

  it("starts over at a reload's app:boot, and reports once per document", () => {
    const view = sender(4);
    trackStartupInvoke(view, "app:boot", never);
    trackStartupInvoke(view, "worktree:get-all-with-status", never);
    expect(claimStartupWaitSnapshot(view, REPORT, true)).not.toBeNull();
    expect(claimStartupWaitSnapshot(view, REPORT, true)).toBeNull();

    vi.advanceTimersByTime(10_000);
    trackStartupInvoke(view, "app:boot", never);
    vi.advanceTimersByTime(1_000);

    expect(claimStartupWaitSnapshot(view, REPORT, true)).toEqual({
      bootRequested: true,
      sinceBootMs: 1_000,
      pendingCount: 1,
      pending: [{ channel: "app:boot", pendingMs: 1_000 }],
    });
  });

  it("keeps a previous document's late hydration from relabelling the current boot", () => {
    const view = sender(5);
    let firstStep: (step: string) => void = () => {};
    trackStartupInvoke(view, "app:boot", () => {
      firstStep = startupStepper(5);
      return never();
    });
    trackStartupInvoke(view, "app:boot", () => {
      startupStepper(5)("gpu-report");
      return never();
    });

    firstStep("project-state-write");

    expect(claimStartupWaitSnapshot(view, REPORT, true)?.pending).toEqual([
      { channel: "app:boot", pendingMs: 0, step: "gpu-report" },
    ]);
  });

  it("does not hand a document that never booted the previous document's record", () => {
    const view = sender(6);
    trackStartupInvoke(view, "app:boot", never);
    expect(claimStartupWaitSnapshot(view, REPORT, true)?.bootRequested).toBe(true);

    // The reload's entry graph never ran, so no app:boot replaced the session.
    expect(claimStartupWaitSnapshot(view, REPORT, false)).toEqual({
      bootRequested: false,
      sinceBootMs: null,
      pendingCount: 0,
      pending: [],
    });
    expect(claimStartupWaitSnapshot(view, REPORT, false)).toBeNull();
  });

  it("stops tracking when startup ends", () => {
    const view = sender(7);
    trackStartupInvoke(view, "app:boot", never);
    trackStartupInvoke(view, "worktree:get-all-with-status", never);
    endStartupTracking(7);
    trackStartupInvoke(view, "terminal:get-for-project", never);

    expect(claimStartupWaitSnapshot(view, REPORT, true)).toEqual({
      bootRequested: false,
      sinceBootMs: null,
      pendingCount: 0,
      pending: [],
    });
  });

  it("records no new invokes long after the boot payload settled, keeping the early ones", async () => {
    const view = sender(8);
    trackStartupInvoke(view, "app:boot", () => Promise.resolve());
    trackStartupInvoke(view, "worktree:get-all-with-status", never);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    trackStartupInvoke(view, "canopy:list", never);

    expect(claimStartupWaitSnapshot(view, REPORT, true)?.pending.map((p) => p.channel)).toEqual([
      "worktree:get-all-with-status",
    ]);
  });

  it("keeps recording after a boot payload that took minutes", async () => {
    const view = sender(14);
    let finishBoot: () => void = () => {};
    trackStartupInvoke(
      view,
      "app:boot",
      () =>
        new Promise<void>((resolve) => {
          finishBoot = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    finishBoot();
    await vi.advanceTimersByTimeAsync(1_000);
    trackStartupInvoke(view, "worktree:get-all-with-status", never);

    expect(claimStartupWaitSnapshot(view, REPORT, true)?.pending.map((p) => p.channel)).toEqual([
      "worktree:get-all-with-status",
    ]);
  });

  it("forgets a view destroyed mid-startup when the next session opens", () => {
    const gone = sender(9);
    trackStartupInvoke(gone, "app:boot", never);
    gone.destroyed = true;
    trackStartupInvoke(sender(10), "app:boot", never);

    expect(claimStartupWaitSnapshot(gone, REPORT, true)?.bootRequested).toBe(false);
  });

  it("caps the list while counting everything open", () => {
    const view = sender(11);
    trackStartupInvoke(view, "app:boot", never);
    for (let i = 0; i < 30; i++) trackStartupInvoke(view, `x:${i}`, never);

    const snapshot = claimStartupWaitSnapshot(view, REPORT, true);
    expect(snapshot?.pendingCount).toBe(31);
    expect(snapshot?.pending).toHaveLength(20);
    expect(snapshot?.pending[0]?.channel).toBe("app:boot");
  });

  it("passes calls with no sender straight through", () => {
    expect(trackStartupInvoke(undefined, "app:boot", () => "ok")).toBe("ok");
  });

  it("sees a local view's invokes through the dispatcher", async () => {
    const view = sender(12);
    const event = { sender: view } as unknown as IpcMainInvokeEvent;
    const dispatcher = getIpcDispatcher();
    dispatcher.setInvokeEnveloper(async (_channel, _args, run) => wrapSuccess(await run()));
    try {
      void dispatcher.dispatchLocalInvoke("app:boot", event, [], never);
      await dispatcher.dispatchLocalInvoke("app:get-version", event, [], () => "1.0.0");

      expect(claimStartupWaitSnapshot(view, REPORT, true)?.pending.map((p) => p.channel)).toEqual([
        "app:boot",
      ]);
    } finally {
      dispatcher.setInvokeEnveloper(null);
    }
  });

  it("sees a remote-bound view's split boot and forwarded invokes through the dispatcher", () => {
    const view = sender(15);
    const event = { sender: view } as unknown as IpcMainInvokeEvent;
    const dispatcher = getIpcDispatcher();
    const forwardInvoke = vi.fn(() => never());
    const localListener = vi.fn(never);
    dispatcher.setInvokeEnveloper(async (_channel, _args, run) => wrapSuccess(await run()));
    dispatcher.setRemoteRouter({
      hostForSender: () => "host-1",
      forwardInvoke,
      forwardSend: () => {},
    });
    const unregisterSplit = dispatcher.registerHybridSplit("app:boot", ({ remote }) => remote());
    try {
      void dispatcher.dispatchLocalInvoke("app:boot", event, [], localListener);
      void dispatcher.dispatchLocalInvoke("worktree:get-all-with-status", event, [], localListener);

      expect(claimStartupWaitSnapshot(view, REPORT, true)?.pending.map((p) => p.channel)).toEqual([
        "app:boot",
        "worktree:get-all-with-status",
      ]);
      expect(forwardInvoke).toHaveBeenCalledTimes(2);
      expect(localListener).not.toHaveBeenCalled();
    } finally {
      unregisterSplit();
      dispatcher.setRemoteRouter(null);
      dispatcher.setInvokeEnveloper(null);
    }
  });
});
