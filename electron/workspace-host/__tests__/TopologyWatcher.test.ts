import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";

const { parcelWatcherCallbacks, mockGetGitCommonDir, mockParcelSubscribe } = vi.hoisted(() => {
  const callbacks: Array<(err: Error | null, events: unknown[]) => void> = [];
  return {
    parcelWatcherCallbacks: callbacks,
    mockGetGitCommonDir: vi.fn<(arg: string) => string | null>().mockReturnValue(null),
    mockParcelSubscribe: vi.fn(
      (
        _dir: string,
        cb: (err: Error | null, events: unknown[]) => void,
        _opts?: Record<string, unknown>
      ) => {
        callbacks.push(cb);
        return Promise.resolve({ unsubscribe: vi.fn() });
      }
    ),
  };
});

vi.mock("../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: mockParcelSubscribe,
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitCommonDir: mockGetGitCommonDir,
}));

// Only the code path under test needs a fake `.git/worktrees` — everything
// else falls through to the real fs implementation.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) => {
      if (typeof p === "string" && p.endsWith("/worktrees")) return true;
      return (actual.existsSync as (p: unknown) => boolean)(p);
    }),
  };
});

import { TopologyWatcher, type TopologyWatcherHost } from "../TopologyWatcher.js";

type FakeMonitor = Pick<WorktreeMonitor, "isMainWorktree">;

interface MutableHost {
  pollingEnabled: boolean;
  projectRootPath: string | null;
  activeWorktreeId: string | null;
  monitors: Map<string, FakeMonitor>;
  discoverAndSyncWorktrees: ReturnType<typeof vi.fn>;
  setActiveWorktree: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
}

function makeHost(overrides: Partial<MutableHost> = {}): MutableHost {
  return {
    pollingEnabled: true,
    projectRootPath: "/test/root",
    activeWorktreeId: null,
    monitors: new Map(),
    discoverAndSyncWorktrees: vi.fn().mockResolvedValue(undefined),
    setActiveWorktree: vi.fn(),
    sendEvent: vi.fn(),
    ...overrides,
  };
}

function makeWatcher(host: MutableHost): TopologyWatcher {
  return new TopologyWatcher(host as unknown as TopologyWatcherHost);
}

describe("TopologyWatcher", () => {
  let host: MutableHost;
  let watcher: TopologyWatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    parcelWatcherCallbacks.length = 0;
    mockGetGitCommonDir.mockReturnValue("/test/root/.git");
    host = makeHost();
    watcher = makeWatcher(host);
  });

  describe("watcher lifecycle", () => {
    it("starts watcher when metadata dir exists", async () => {
      watcher.startWatcher();
      await vi.waitFor(() => expect(mockParcelSubscribe).toHaveBeenCalled());
      expect(mockParcelSubscribe).toHaveBeenCalledWith(
        "/test/root/.git/worktrees",
        expect.any(Function),
        expect.any(Object)
      );
    });

    it("does not start watcher when already subscribed", async () => {
      watcher.startWatcher();
      await vi.waitFor(() => expect(mockParcelSubscribe).toHaveBeenCalledTimes(1));
      watcher.startWatcher();
      await new Promise((r) => setTimeout(r, 10));
      expect(mockParcelSubscribe).toHaveBeenCalledTimes(1);
    });

    it("skips watcher start when metadata dir is absent", async () => {
      mockGetGitCommonDir.mockReturnValue(null);
      await watcher.startWatcher();
      expect(mockParcelSubscribe).not.toHaveBeenCalled();
    });

    it("stops watcher and clears pending state", async () => {
      watcher.startWatcher();
      await vi.waitFor(() => expect(mockParcelSubscribe).toHaveBeenCalledTimes(1));
      watcher.scheduleReconcile(true);

      watcher.stop();

      expect((watcher as any).subscription.value).toBeUndefined();
      expect((watcher as any).reconcilePending).toBe(false);
    });

    it("fires reconciliation when watcher callback triggers after debounce", async () => {
      vi.useFakeTimers();
      try {
        watcher.startWatcher();
        await vi.runAllTimersAsync();
        expect(parcelWatcherCallbacks.length).toBeGreaterThanOrEqual(1);

        parcelWatcherCallbacks[0]!(null, [
          { type: "delete", path: "/test/root/.git/worktrees/phantom" },
        ]);

        expect(host.discoverAndSyncWorktrees).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(350);

        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("coalesces burst events into a single reconciliation pass", async () => {
      vi.useFakeTimers();
      try {
        watcher.startWatcher();
        await vi.runAllTimersAsync();

        const cb = parcelWatcherCallbacks[0]!;
        cb(null, [{ type: "delete", path: "/test/root/.git/worktrees/a" }]);
        cb(null, [{ type: "delete", path: "/test/root/.git/worktrees/b" }]);
        cb(null, [{ type: "delete", path: "/test/root/.git/worktrees/c" }]);

        await vi.advanceTimersByTimeAsync(350);

        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not process watcher events when polling is disabled", async () => {
      vi.useFakeTimers();
      try {
        watcher.startWatcher();
        await vi.runAllTimersAsync();
        const armedCallbacks = parcelWatcherCallbacks.length;
        expect(armedCallbacks).toBeGreaterThan(0);
        host.pollingEnabled = false;

        parcelWatcherCallbacks[armedCallbacks - 1]!(null, [
          { type: "delete", path: "/test/root/.git/worktrees/wt-1" },
        ]);
        await vi.advanceTimersByTimeAsync(350);
        // scheduleReconcile itself still fires (the callback doesn't know the
        // service paused) but non-force calls are gated by pollingEnabled.
        expect(host.discoverAndSyncWorktrees).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("pending-set suppression (#8412)", () => {
    it("suppresses the app-owned create event and drains the pending entry", async () => {
      vi.useFakeTimers();
      try {
        watcher.markPendingCreate("new-wt");

        watcher.startWatcher();
        await vi.advanceTimersByTimeAsync(0);

        parcelWatcherCallbacks[0]!(null, [
          { type: "create", path: "/test/root/.git/worktrees/new-wt" },
        ]);
        await vi.advanceTimersByTimeAsync(350);

        expect(host.discoverAndSyncWorktrees).not.toHaveBeenCalled();
        expect((watcher as any).pendingCreate.has("new-wt")).toBe(false);
        expect((watcher as any).pendingSafetyTimers.has("new-wt")).toBe(false);

        // A later external change to the same name is no longer masked.
        parcelWatcherCallbacks[0]!(null, [
          { type: "delete", path: "/test/root/.git/worktrees/new-wt" },
        ]);
        await vi.advanceTimersByTimeAsync(350);
        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not swallow an external delete during an app-owned create (#8412)", async () => {
      vi.useFakeTimers();
      try {
        watcher.markPendingCreate("my-wt");

        watcher.startWatcher();
        await vi.advanceTimersByTimeAsync(0);

        parcelWatcherCallbacks[0]!(null, [
          { type: "delete", path: "/test/root/.git/worktrees/other-wt" },
        ]);
        await vi.advanceTimersByTimeAsync(350);

        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);
        expect((watcher as any).pendingCreate.has("my-wt")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reconciles a mixed batch with a matched create and an unmatched delete", async () => {
      vi.useFakeTimers();
      try {
        watcher.markPendingCreate("my-wt");

        watcher.startWatcher();
        await vi.advanceTimersByTimeAsync(0);

        const cb = parcelWatcherCallbacks[0]!;
        cb(null, [{ type: "create", path: "/test/root/.git/worktrees/my-wt" }]);
        cb(null, [{ type: "delete", path: "/test/root/.git/worktrees/other-wt" }]);
        await vi.advanceTimersByTimeAsync(350);

        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);
        expect((watcher as any).pendingCreate.has("my-wt")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not let a pending create swallow an external delete of the same basename", async () => {
      vi.useFakeTimers();
      try {
        watcher.markPendingCreate("foo");

        watcher.startWatcher();
        await vi.advanceTimersByTimeAsync(0);

        parcelWatcherCallbacks[0]!(null, [
          { type: "delete", path: "/test/root/.git/worktrees/foo" },
        ]);
        await vi.advanceTimersByTimeAsync(350);

        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);
        expect((watcher as any).pendingCreate.has("foo")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("safety valve clears a pending entry after 5s with no reconcile", async () => {
      vi.useFakeTimers();
      try {
        watcher.markPendingDelete("stuck-wt");
        expect((watcher as any).pendingDelete.has("stuck-wt")).toBe(true);

        await vi.advanceTimersByTimeAsync(5000);

        expect((watcher as any).pendingDelete.has("stuck-wt")).toBe(false);
        expect((watcher as any).pendingSafetyTimers.has("stuck-wt")).toBe(false);
        expect(host.discoverAndSyncWorktrees).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears pending entries and safety timers on stop", async () => {
      vi.useFakeTimers();
      try {
        watcher.markPendingDelete("paused-wt");
        expect((watcher as any).pendingDelete.has("paused-wt")).toBe(true);
        expect((watcher as any).pendingSafetyTimers.has("paused-wt")).toBe(true);

        watcher.stop();
        expect((watcher as any).pendingDelete.has("paused-wt")).toBe(false);
        expect((watcher as any).pendingSafetyTimers.has("paused-wt")).toBe(false);

        // After resume, an external change to that same name still reconciles.
        watcher.startWatcher();
        await vi.advanceTimersByTimeAsync(0);
        parcelWatcherCallbacks.at(-1)!(null, [
          { type: "delete", path: "/test/root/.git/worktrees/paused-wt" },
        ]);
        await vi.advanceTimersByTimeAsync(350);

        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("defers events inside the post-reconciliation cooldown and drains them at expiry", async () => {
      vi.useFakeTimers();
      try {
        watcher.startWatcher();
        await vi.runAllTimersAsync();

        parcelWatcherCallbacks[0]!(null, [
          { type: "delete", path: "/test/root/.git/worktrees/wt-1" },
        ]);
        await vi.advanceTimersByTimeAsync(150);
        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);

        parcelWatcherCallbacks[0]!(null, [
          { type: "delete", path: "/test/root/.git/worktrees/wt-2" },
        ]);
        await vi.advanceTimersByTimeAsync(150);
        // The debounced drain landed inside the cooldown — deferred, not run.
        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);

        // The cooldown drain must pick the deferred event up at expiry on its
        // own — before the drain timer existed it stranded until the next
        // unrelated event or the 90s safety net.
        await vi.advanceTimersByTimeAsync(600);
        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a forced reconcile absorbs a pending deferred drain", async () => {
      vi.useFakeTimers();
      try {
        watcher.startWatcher();
        await vi.runAllTimersAsync();

        parcelWatcherCallbacks[0]!(null, [
          { type: "delete", path: "/test/root/.git/worktrees/wt-1" },
        ]);
        await vi.advanceTimersByTimeAsync(150);
        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);

        parcelWatcherCallbacks[0]!(null, [
          { type: "delete", path: "/test/root/.git/worktrees/wt-2" },
        ]);
        await vi.advanceTimersByTimeAsync(150);
        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(1);

        // The forced pass observes everything the deferred event wanted
        // verified — the armed drain must not run a redundant follow-up.
        watcher.scheduleReconcile(true);
        await vi.advanceTimersByTimeAsync(700);
        expect(host.discoverAndSyncWorktrees).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("dark state (#9908)", () => {
    function darkEventCount(): number {
      return host.sendEvent.mock.calls.filter(
        (call: any[]) => (call[0] as { type?: string })?.type === "topology-watcher-dark"
      ).length;
    }
    function recoveredEventCount(): number {
      return host.sendEvent.mock.calls.filter(
        (call: any[]) => (call[0] as { type?: string })?.type === "topology-watcher-recovered"
      ).length;
    }

    it("emits topology-watcher-dark when subscribe() rejects at cold start", async () => {
      mockParcelSubscribe.mockReturnValueOnce(Promise.reject(new Error("EPERM")));

      watcher.startWatcher();

      await vi.waitFor(() => expect(darkEventCount()).toBe(1));
      expect(watcher.isDark()).toBe(true);
    });

    it("emits the dark event at most once while already dark", async () => {
      mockParcelSubscribe.mockReturnValueOnce(Promise.reject(new Error("EPERM")));
      watcher.startWatcher();
      await vi.waitFor(() => expect(darkEventCount()).toBe(1));

      (watcher as any).handleDark();
      expect(darkEventCount()).toBe(1);
      expect(watcher.isDark()).toBe(true);
    });

    it("emits topology-watcher-dark when a pending-event safety valve expires", async () => {
      vi.useFakeTimers();
      try {
        watcher.markPendingCreate("missed-wt");
        expect(darkEventCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(5001);

        expect(darkEventCount()).toBe(1);
        expect(watcher.isDark()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the dark state on a successful reconcile and emits recovered", async () => {
      (watcher as any).handleDark();
      expect(watcher.isDark()).toBe(true);

      await (watcher as any).runReconcile();

      expect(watcher.isDark()).toBe(false);
      expect(recoveredEventCount()).toBe(1);
    });

    it("does not emit recovered from a reconcile when never dark", async () => {
      await (watcher as any).runReconcile();

      expect(recoveredEventCount()).toBe(0);
      expect(watcher.isDark()).toBe(false);
    });

    it("does NOT recover on watcher re-arm — only a reconcile clears the dark state", async () => {
      mockParcelSubscribe.mockReturnValueOnce(Promise.reject(new Error("EPERM")));
      watcher.startWatcher();
      await vi.waitFor(() => expect(watcher.isDark()).toBe(true));

      watcher.startWatcher();
      await vi.waitFor(() => expect(mockParcelSubscribe).toHaveBeenCalledTimes(2));

      expect(watcher.isDark()).toBe(true);
      expect(recoveredEventCount()).toBe(0);
    });

    it("emits recovered on stop while dark so the renderer can clear", async () => {
      (watcher as any).handleDark();
      expect(watcher.isDark()).toBe(true);

      watcher.stop();

      expect(watcher.isDark()).toBe(false);
      expect(recoveredEventCount()).toBe(1);
    });

    it("does not emit recovered on stop when not dark", () => {
      watcher.stop();
      expect(recoveredEventCount()).toBe(0);
    });

    it("goes dark when the watcher callback reports a runtime error", async () => {
      watcher.startWatcher();
      await vi.waitFor(() => expect(parcelWatcherCallbacks.length).toBeGreaterThanOrEqual(1));

      parcelWatcherCallbacks.at(-1)!(new Error("watcher backend error"), []);

      expect(darkEventCount()).toBe(1);
      expect(watcher.isDark()).toBe(true);
    });

    it("can re-dark after a stop/resume cycle clears the guard", async () => {
      vi.useFakeTimers();
      try {
        (watcher as any).handleDark();
        expect(darkEventCount()).toBe(1);

        watcher.stop();
        expect(watcher.isDark()).toBe(false);

        watcher.markPendingDelete("again-wt");
        await vi.advanceTimersByTimeAsync(5001);

        expect(darkEventCount()).toBe(2);
        expect(watcher.isDark()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("isDark() defaults to false", () => {
      expect(watcher.isDark()).toBe(false);
    });
  });

  describe("periodic safety-net timer (#8510)", () => {
    it("calls scheduleReconcile on each interval tick", async () => {
      vi.useFakeTimers();
      try {
        const reconcileSpy = vi.spyOn(watcher, "scheduleReconcile").mockImplementation(() => {});

        watcher.startSafetyTimer();

        expect(reconcileSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(90_000);
        expect(reconcileSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(90_000);
        expect(reconcileSpy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("is idempotent — a second start does not create a duplicate interval", async () => {
      vi.useFakeTimers();
      try {
        const reconcileSpy = vi.spyOn(watcher, "scheduleReconcile").mockImplementation(() => {});

        watcher.startSafetyTimer();
        watcher.startSafetyTimer();

        await vi.advanceTimersByTimeAsync(90_000);
        expect(reconcileSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stop clears the timer so no further ticks fire", async () => {
      vi.useFakeTimers();
      try {
        const reconcileSpy = vi.spyOn(watcher, "scheduleReconcile").mockImplementation(() => {});

        watcher.startSafetyTimer();
        watcher.stop();

        await vi.advanceTimersByTimeAsync(90_000 * 2);
        expect(reconcileSpy).not.toHaveBeenCalled();
        expect((watcher as any).periodicSafetyTimer).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("restarts after a stop clears it, resuming ticks", async () => {
      vi.useFakeTimers();
      try {
        const reconcileSpy = vi.spyOn(watcher, "scheduleReconcile").mockImplementation(() => {});

        watcher.startSafetyTimer();
        watcher.stop();
        await vi.advanceTimersByTimeAsync(90_000);
        expect(reconcileSpy).not.toHaveBeenCalled();

        watcher.startSafetyTimer();
        await vi.advanceTimersByTimeAsync(90_000);
        expect(reconcileSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("scheduleReconcile force / recovery", () => {
    let reconcileSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      reconcileSpy = vi.spyOn(watcher as any, "runReconcile").mockResolvedValue(undefined);
    });

    it("force bypasses the post-reconcile cooldown; non-force coalesces", async () => {
      (watcher as any).watchCooldownUntil = Date.now() + 60_000;

      watcher.scheduleReconcile(false);
      await (watcher as any).reconcileQueue.onIdle();
      expect(reconcileSpy).not.toHaveBeenCalled();
      expect((watcher as any).watchCooldownDirty).toBe(true);

      watcher.scheduleReconcile(true);
      await (watcher as any).reconcileQueue.onIdle();
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    });

    it("force bypasses the pollingEnabled gate that silences background reconciles", async () => {
      host.pollingEnabled = false;

      watcher.scheduleReconcile(false);
      await (watcher as any).reconcileQueue.onIdle();
      expect(reconcileSpy).not.toHaveBeenCalled();

      watcher.scheduleReconcile(true);
      await (watcher as any).reconcileQueue.onIdle();
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    });

    it("clears the pending flag after a reconcile so the next one can run", async () => {
      watcher.scheduleReconcile(true);
      await (watcher as any).reconcileQueue.onIdle();
      expect((watcher as any).reconcilePending).toBe(false);

      watcher.scheduleReconcile(true);
      await (watcher as any).reconcileQueue.onIdle();
      expect(reconcileSpy).toHaveBeenCalledTimes(2);
    });

    it("clears the pending flag even when the reconcile hangs (watchdog)", async () => {
      vi.useFakeTimers();
      try {
        reconcileSpy.mockReturnValue(new Promise<never>(() => {}) as never);

        watcher.scheduleReconcile(true);
        expect((watcher as any).reconcilePending).toBe(true);

        // Past TOPOLOGY_RECONCILE_TIMEOUT_MS (60s): the watchdog abandons the
        // hung pass and the finally clears the flag.
        await vi.advanceTimersByTimeAsync(61_000);

        expect((watcher as any).reconcilePending).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("reconcile auto-switch", () => {
    it("auto-switches to main worktree when active worktree is externally removed", async () => {
      host.monitors.set("/test/main", { isMainWorktree: true });
      host.monitors.set("/test/active", { isMainWorktree: false });
      host.activeWorktreeId = "/test/active";

      host.discoverAndSyncWorktrees.mockImplementation(async () => {
        host.monitors.delete("/test/active");
        host.activeWorktreeId = null;
      });

      await (watcher as any).runReconcile();

      expect(host.setActiveWorktree).toHaveBeenCalledWith(
        "topology-reconcile-auto-switch",
        "/test/main"
      );
    });

    it("does not switch when removal did not affect active worktree", async () => {
      host.monitors.set("/test/main", { isMainWorktree: true });
      host.monitors.set("/test/other", { isMainWorktree: false });
      host.activeWorktreeId = "/test/main";

      host.discoverAndSyncWorktrees.mockImplementation(async () => {
        host.monitors.delete("/test/other");
      });

      await (watcher as any).runReconcile();

      expect(host.setActiveWorktree).not.toHaveBeenCalled();
    });
  });
});
