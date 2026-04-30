import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSnapshotter, type SessionSnapshotterHost } from "../SessionSnapshotter.js";

const persistAsyncMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const persistSyncMock = vi.hoisted(() => vi.fn());
const isSuppressedMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../terminalSessionPersistence.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    TERMINAL_SESSION_PERSISTENCE_ENABLED: true,
    persistSessionSnapshotSync: persistSyncMock,
    persistSessionSnapshotAsync: persistAsyncMock,
    isSessionPersistSuppressed: isSuppressedMock,
  };
});

interface MutableHost extends SessionSnapshotterHost {
  wasKilled: boolean;
  launchAgentId: string | undefined;
  bannerMarkers: boolean;
  serializedState: string | null;
  serializedStateAsync: string | null;
  serializedForPersistence: string | null;
  asyncResolve: () => void;
  asyncResolved: boolean;
}

function createHost(overrides: Partial<MutableHost> = {}): MutableHost {
  // Allow tests to install a deferred async serializer when they need to
  // observe in-flight behavior.
  let asyncResolve: () => void = () => {};
  let asyncResolved = true;

  const host: MutableHost = {
    id: "t-test",
    wasKilled: false,
    launchAgentId: undefined,
    bannerMarkers: false,
    serializedState: "sync-state",
    serializedStateAsync: "async-state",
    serializedForPersistence: "banner-state",
    hasBannerMarkers() {
      return this.bannerMarkers;
    },
    getSerializedState() {
      return this.serializedState;
    },
    async getSerializedStateAsync() {
      if (asyncResolved) return this.serializedStateAsync;
      await new Promise<void>((resolve) => {
        asyncResolve = () => {
          asyncResolved = true;
          resolve();
        };
      });
      return this.serializedStateAsync;
    },
    serializeForPersistence() {
      return this.serializedForPersistence;
    },
    asyncResolve: () => asyncResolve(),
    get asyncResolved() {
      return asyncResolved;
    },
    set asyncResolved(v: boolean) {
      asyncResolved = v;
    },
    ...overrides,
  };
  return host;
}

describe("SessionSnapshotter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    persistAsyncMock.mockReset();
    persistAsyncMock.mockResolvedValue(undefined);
    persistSyncMock.mockReset();
    isSuppressedMock.mockReset();
    isSuppressedMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("schedule + debounced async persist", () => {
    it("debounces and persists once after 5s", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      snap.schedule();
      snap.schedule();

      expect(persistAsyncMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).toHaveBeenCalledWith("t-test", "async-state");
    });

    it("uses banner-aware sync serialize when banner markers are present", async () => {
      const host = createHost({ bannerMarkers: true });
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      await vi.advanceTimersByTimeAsync(5000);

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).toHaveBeenCalledWith("t-test", "banner-state");
    });

    it("skips scheduling when launchAgentId is set (agent terminal)", async () => {
      const host = createHost({ launchAgentId: "claude" });
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      await vi.advanceTimersByTimeAsync(5000);

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("skips scheduling when wasKilled is true", async () => {
      const host = createHost({ wasKilled: true });
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      await vi.advanceTimersByTimeAsync(5000);

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("does not persist when serialized state is null", async () => {
      const host = createHost({ serializedStateAsync: null });
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      await vi.advanceTimersByTimeAsync(5000);

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("does not persist when serialized state exceeds max bytes", async () => {
      const oversized = "x".repeat(6 * 1024 * 1024);
      const host = createHost({ serializedStateAsync: oversized });
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      await vi.advanceTimersByTimeAsync(5000);

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("clears pending timer and prevents persist callback from firing", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      snap.dispose();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("is safe to call multiple times", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      expect(() => {
        snap.dispose();
        snap.dispose();
        snap.dispose();
      }).not.toThrow();
    });

    it("blocks reschedule and post-await persist when disposed mid-flight", async () => {
      const host = createHost();
      host.asyncResolved = false;
      const snap = new SessionSnapshotter(host);

      // Schedule and let the timer fire — the persistAsync starts and stalls
      // on the deferred getSerializedStateAsync().
      snap.schedule();
      await vi.advanceTimersByTimeAsync(5000);

      // Mark dirty mid-flight so the finally block would normally reschedule.
      snap.schedule();

      // Dispose while the async serialize is still pending.
      snap.dispose();

      // Resolve the in-flight promise — neither persist nor reschedule should
      // fire: the post-await disposed check bails before persistSessionSnapshotAsync.
      host.asyncResolve();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(vi.getTimerCount()).toBe(0);
      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("blocks post-await persist when wasKilled is set mid-flight", async () => {
      const host = createHost();
      host.asyncResolved = false;
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      await vi.advanceTimersByTimeAsync(5000);

      // Simulate kill: flushSyncOnKill writes a sync snapshot, then wasKilled
      // is set. The post-await guard must prevent the in-flight async from
      // overwriting the sync snapshot.
      snap.flushSyncOnKill();
      host.wasKilled = true;

      host.asyncResolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(persistSyncMock).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("schedule after dispose is a no-op", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.dispose();
      snap.schedule();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(persistAsyncMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("flushEventDriven", () => {
    it("persists with sync serialized state", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).toHaveBeenCalledWith("t-test", "sync-state");
    });

    it("throttles repeated calls within 2s", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      snap.flushEventDriven();
      snap.flushEventDriven();

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
    });

    it("allows another flush after throttle window elapses", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      vi.advanceTimersByTime(2001);
      snap.flushEventDriven();

      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT skip for agent terminals (snapshots agents on event)", () => {
      const host = createHost({ launchAgentId: "claude" });
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
    });

    it("skips when wasKilled is true", () => {
      const host = createHost({ wasKilled: true });
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("skips when disposed", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.dispose();
      snap.flushEventDriven();

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("skips when serialized state is null", () => {
      const host = createHost({ serializedState: null });
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("skips when serialized state exceeds max bytes", () => {
      const oversized = "x".repeat(6 * 1024 * 1024);
      const host = createHost({ serializedState: oversized });
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });
  });

  describe("flushSyncOnKill", () => {
    it("persists synchronously regardless of dirty flag", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushSyncOnKill();

      expect(persistSyncMock).toHaveBeenCalledTimes(1);
      expect(persistSyncMock).toHaveBeenCalledWith("t-test", "sync-state");
    });

    it("skips for agent terminals", () => {
      const host = createHost({ launchAgentId: "claude" });
      const snap = new SessionSnapshotter(host);

      snap.flushSyncOnKill();

      expect(persistSyncMock).not.toHaveBeenCalled();
    });

    it("ignores serialize errors silently", () => {
      const host = createHost();
      host.getSerializedState = () => {
        throw new Error("serialize boom");
      };
      const snap = new SessionSnapshotter(host);

      expect(() => snap.flushSyncOnKill()).not.toThrow();
      expect(persistSyncMock).not.toHaveBeenCalled();
    });

    it("uses plain sync serialize (not banner-aware)", () => {
      const host = createHost({ bannerMarkers: true });
      const snap = new SessionSnapshotter(host);

      snap.flushSyncOnKill();

      expect(persistSyncMock).toHaveBeenCalledTimes(1);
      expect(persistSyncMock).toHaveBeenCalledWith("t-test", "sync-state");
    });
  });

  describe("flushSyncOnDispose", () => {
    it("skips when not dirty", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushSyncOnDispose();

      expect(persistSyncMock).not.toHaveBeenCalled();
    });

    it("persists when dirty (after schedule)", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule(); // sets dirty=true
      snap.flushSyncOnDispose();

      expect(persistSyncMock).toHaveBeenCalledTimes(1);
      expect(persistSyncMock).toHaveBeenCalledWith("t-test", "banner-state");
    });

    it("skips when wasKilled is true", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      host.wasKilled = true;
      snap.flushSyncOnDispose();

      expect(persistSyncMock).not.toHaveBeenCalled();
    });

    it("falls back to plain sync serialize when banner-aware returns null", () => {
      const host = createHost({ serializedForPersistence: null });
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      snap.flushSyncOnDispose();

      expect(persistSyncMock).toHaveBeenCalledTimes(1);
      expect(persistSyncMock).toHaveBeenCalledWith("t-test", "sync-state");
    });

    it("clears dirty flag after persist so a second call is a no-op", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      snap.flushSyncOnDispose();
      snap.flushSyncOnDispose();

      expect(persistSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("isSessionPersistSuppressed gate", () => {
    it("blocks all persistence paths when suppression is active", async () => {
      isSuppressedMock.mockReturnValue(true);
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      await vi.advanceTimersByTimeAsync(5000);
      snap.flushEventDriven();
      snap.flushSyncOnKill();
      // schedule was no-op so dirty is false; force dirty for the dispose path.
      isSuppressedMock.mockReturnValue(false);
      snap.schedule();
      isSuppressedMock.mockReturnValue(true);
      snap.flushSyncOnDispose();

      expect(persistAsyncMock).not.toHaveBeenCalled();
      expect(persistSyncMock).not.toHaveBeenCalled();
    });
  });
});
