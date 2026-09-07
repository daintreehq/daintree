import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSnapshotter, type SessionSnapshotterHost } from "../SessionSnapshotter.js";
import type { SerializedTerminalSnapshot } from "../../../../shared/types/terminal.js";

// Snapshots now carry the grid they were captured at, so persistence writers
// receive an object rather than a bare payload string (#11552).
const SYNC_STATE: SerializedTerminalSnapshot = { data: "sync-state", cols: 80, rows: 24 };
const ASYNC_STATE: SerializedTerminalSnapshot = { data: "async-state", cols: 80, rows: 24 };
const BANNER_STATE: SerializedTerminalSnapshot = { data: "banner-state", cols: 80, rows: 24 };

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
  contentEpoch: number;
  bannerMarkers: boolean;
  serializedState: SerializedTerminalSnapshot | null;
  serializedStateAsync: SerializedTerminalSnapshot | null;
  serializedForPersistence: SerializedTerminalSnapshot | null;
  asyncResolve: () => void;
  asyncResolved: boolean;
}

// Event-driven flush is fire-and-forget; drain its microtask chain
// (getSerializedStateAsync → persistSessionSnapshotAsync) so assertions see the
// completed persist.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// A capture that completes can hand a deferred follow-up straight back into the
// same path, so the chain is longer than one flush drains. Advancing the fake
// clock by zero yields through a real task, draining the whole chain without
// making any armed deadline due — deterministic where a tick count is a guess.
async function drainFollowUp(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
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
    contentEpoch: 1,
    bannerMarkers: false,
    serializedState: SYNC_STATE,
    serializedStateAsync: ASYNC_STATE,
    serializedForPersistence: BANNER_STATE,
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
      expect(persistAsyncMock).toHaveBeenCalledWith("t-test", ASYNC_STATE);
    });

    it("uses banner-aware sync serialize when banner markers are present", async () => {
      const host = createHost({ bannerMarkers: true });
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      await vi.advanceTimersByTimeAsync(5000);

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).toHaveBeenCalledWith("t-test", BANNER_STATE);
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
    it("uses async serialization for the non-banner path", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).toHaveBeenCalledWith("t-test", ASYNC_STATE);
    });

    it("strips restore banner via sync serializeForPersistence when banner markers are present", async () => {
      const host = createHost({ bannerMarkers: true });
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).toHaveBeenCalledWith("t-test", BANNER_STATE);
    });

    it("throttles repeated calls within 2s", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      await flushMicrotasks();
      // Content changed but the throttle window has not elapsed → suppressed.
      host.contentEpoch = 2;
      snap.flushEventDriven();
      host.contentEpoch = 3;
      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
    });

    it("allows another flush after throttle window elapses when content changed", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      await flushMicrotasks();

      vi.advanceTimersByTime(2001);
      host.contentEpoch = 2;
      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("skips serialization when contentEpoch is unchanged since the last persist", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // Same epoch, and past the throttle window — still skipped (buffer unchanged).
      vi.advanceTimersByTime(2001);
      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
    });

    it("checks the epoch before the throttle so an unchanged call never starves a later changed flush", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      await flushMicrotasks(); // persists epoch 1, stamps throttle

      // An unchanged call inside the throttle window must not re-stamp the
      // throttle clock; a changed flush after the window still goes through.
      snap.flushEventDriven();
      await flushMicrotasks();

      vi.advanceTimersByTime(2001);
      host.contentEpoch = 2;
      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT skip for agent terminals (snapshots agents on event)", async () => {
      const host = createHost({ launchAgentId: "claude" });
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
    });

    it("skips when wasKilled is true", async () => {
      const host = createHost({ wasKilled: true });
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("skips when disposed", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.dispose();
      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("skips when serialized state is null", async () => {
      const host = createHost({ serializedStateAsync: null });
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("re-checks lifecycle after the await and skips persist when killed mid-serialize", async () => {
      const host = createHost();
      host.asyncResolved = false;
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      // Kill lands while the async serialize is still pending.
      host.wasKilled = true;
      host.asyncResolve();
      await flushMicrotasks();

      expect(persistAsyncMock).not.toHaveBeenCalled();
    });

    it("defers a re-entrant flush while one is already in flight", async () => {
      const host = createHost();
      host.asyncResolved = false;
      const serializeSpy = vi.spyOn(host, "getSerializedStateAsync");
      const snap = new SessionSnapshotter(host);

      snap.flushEventDriven();
      await Promise.resolve(); // let the first flush reach its stalled serialize

      // Advance past the throttle window and change content so the second call
      // clears the epoch + throttle gates and actually reaches the in-flight
      // guard — which must not start a second serialize alongside the first.
      vi.advanceTimersByTime(2001);
      host.contentEpoch = 2;
      snap.flushEventDriven();
      await Promise.resolve();

      expect(serializeSpy).toHaveBeenCalledTimes(1);

      // The deferred request is remembered, not dropped: the changed content it
      // asked for is written once the in-flight capture releases.
      host.asyncResolve();
      await drainFollowUp();

      expect(serializeSpy).toHaveBeenCalledTimes(2);
      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("does not mark the epoch flushed when persist fails (retries after throttle)", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);
      persistAsyncMock.mockRejectedValueOnce(new Error("disk full"));

      snap.flushEventDriven();
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // Same epoch, but the failed persist left it uncovered → a later flush retries.
      vi.advanceTimersByTime(2001);
      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("flushSyncOnKill", () => {
    it("persists synchronously regardless of dirty flag", () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.flushSyncOnKill();

      expect(persistSyncMock).toHaveBeenCalledTimes(1);
      expect(persistSyncMock).toHaveBeenCalledWith("t-test", BANNER_STATE);
    });

    it("skips for agent terminals", () => {
      const host = createHost({ launchAgentId: "claude" });
      const snap = new SessionSnapshotter(host);

      snap.flushSyncOnKill();

      expect(persistSyncMock).not.toHaveBeenCalled();
    });

    it("ignores serialize errors silently", () => {
      const host = createHost();
      host.serializeForPersistence = () => {
        throw new Error("serialize boom");
      };
      const snap = new SessionSnapshotter(host);

      expect(() => snap.flushSyncOnKill()).not.toThrow();
      expect(persistSyncMock).not.toHaveBeenCalled();
    });

    it("uses banner-aware serialize so restore banner is stripped before persist", () => {
      // Hibernation calls flushSyncOnKill with banner markers present from a
      // prior restore. The banner must NOT be baked into the snapshot or it
      // will stack on the next hibernate→restore cycle.
      const host = createHost({ bannerMarkers: true });
      const snap = new SessionSnapshotter(host);

      snap.flushSyncOnKill();

      expect(persistSyncMock).toHaveBeenCalledTimes(1);
      expect(persistSyncMock).toHaveBeenCalledWith("t-test", BANNER_STATE);
    });

    it("skips when serialized state is null", () => {
      const host = createHost({ serializedForPersistence: null });
      const snap = new SessionSnapshotter(host);

      snap.flushSyncOnKill();

      expect(persistSyncMock).not.toHaveBeenCalled();
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
      expect(persistSyncMock).toHaveBeenCalledWith("t-test", BANNER_STATE);
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
      expect(persistSyncMock).toHaveBeenCalledWith("t-test", SYNC_STATE);
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

  // The two triggers used to keep entirely separate state, so the end of an
  // agent turn — last output chunk arms the debounce, FSM settle fires the
  // event flush — serialized and wrote the same buffer twice, in either order
  // (#12237). These pin the coalescing without loosening the cases that must
  // still produce two writes.
  describe("unified periodic + event-driven scheduling", () => {
    it("persists once when an event flush covers a scheduled periodic snapshot", async () => {
      const host = createHost();
      const serializeSpy = vi.spyOn(host, "getSerializedStateAsync");
      const snap = new SessionSnapshotter(host);

      // Output burst arms the 5s debounce; the agent settles 2s later.
      snap.schedule();
      vi.advanceTimersByTime(2000);
      snap.flushEventDriven();
      await flushMicrotasks();

      expect(serializeSpy).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // The debounce still expires, on content already on disk.
      vi.advanceTimersByTime(3001);
      await flushMicrotasks();

      expect(serializeSpy).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
    });

    it("persists once when a debounced snapshot covers a later event flush", async () => {
      const host = createHost();
      const serializeSpy = vi.spyOn(host, "getSerializedStateAsync");
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      vi.advanceTimersByTime(5000);
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // The mirror direction: the periodic write now stamps the shared epoch,
      // so a settle on unchanged content has nothing left to write.
      snap.flushEventDriven();
      await flushMicrotasks();

      expect(serializeSpy).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
    });

    it("persists twice when output arrives after the event flush", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      vi.advanceTimersByTime(2000);
      snap.flushEventDriven();
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // A different buffer, so the debounce that follows is real work.
      host.contentEpoch = 2;
      snap.schedule();
      vi.advanceTimersByTime(5001);
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("persists twice when output arrives after the debounced snapshot", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      vi.advanceTimersByTime(5000);
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // The 2s throttle stays event-driven only: a periodic write does not
      // stamp it, so a settle on changed content is eligible immediately.
      host.contentEpoch = 2;
      snap.flushEventDriven();
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("starts no second serialize when the debounce expires mid-capture", async () => {
      const host = createHost();
      host.asyncResolved = false;
      const serializeSpy = vi.spyOn(host, "getSerializedStateAsync");
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      snap.flushEventDriven();
      await Promise.resolve(); // the event capture reaches its stalled serialize

      // The debounce expires while that capture is still serializing. One
      // in-flight flag covers both triggers, so nothing starts alongside it.
      vi.advanceTimersByTime(5001);
      expect(serializeSpy).toHaveBeenCalledTimes(1);

      host.asyncResolve();
      await drainFollowUp();

      expect(serializeSpy).toHaveBeenCalledTimes(1);
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);
    });

    it("still persists content that changed while a capture was serializing", async () => {
      const host = createHost();
      host.asyncResolved = false;
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      vi.advanceTimersByTime(5000);
      await Promise.resolve();

      // Output lands mid-serialize. Coverage is stamped with the ENTRY epoch,
      // so it cannot claim the newer buffer.
      host.contentEpoch = 2;
      snap.schedule();
      host.asyncResolve();
      await drainFollowUp();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5001);
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("re-arms the debounce when output outlives the event capture in flight", async () => {
      const host = createHost();
      host.asyncResolved = false;
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      snap.flushEventDriven();
      await Promise.resolve(); // the event capture stalls in serialize

      // Newer output arrives, then the armed deadline expires while the capture
      // still holds the gate — so it fires, defers, and leaves nothing armed.
      host.contentEpoch = 2;
      snap.schedule();
      vi.advanceTimersByTime(5001);
      expect(persistAsyncMock).not.toHaveBeenCalled();

      // The capture covers only its entry epoch, so the newer output needs a
      // fresh deadline armed on the way out.
      host.asyncResolve();
      await drainFollowUp();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5001);
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("still persists a geometry-only change after an event flush covered the output", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      snap.flushEventDriven();
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // A resize reflow bumps contentEpoch without calling schedule(). The
      // capture must not have cleared the pending debounce out from under it,
      // or the timer bails at `!dirty` before ever seeing the newer epoch.
      host.contentEpoch = 2;
      vi.advanceTimersByTime(5001);
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("does not let an unchanged event flush discharge the pending debounce", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      snap.flushEventDriven();
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // A second settle on unchanged content. It must skip — but skipping is
      // not the same as satisfying the debounce, which is still holding the
      // deadline for whatever comes next.
      vi.advanceTimersByTime(2001);
      snap.flushEventDriven();
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // A resize reflow, then the deadline: the write must still happen.
      host.contentEpoch = 2;
      vi.advanceTimersByTime(3000);
      await flushMicrotasks();

      expect(persistAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("still persists a geometry-only change from teardown", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);

      snap.schedule();
      snap.flushEventDriven();
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // Same reflow, but teardown arrives before the deadline. flushSyncOnDispose
      // is gated on `dirty`, so clearing it on a successful capture would lose
      // this write entirely.
      host.contentEpoch = 2;
      snap.flushSyncOnDispose();

      expect(persistSyncMock).toHaveBeenCalledTimes(1);
    });

    it("leaves debounced work pending for teardown when the event flush failed", async () => {
      const host = createHost();
      const snap = new SessionSnapshotter(host);
      persistAsyncMock.mockRejectedValueOnce(new Error("disk full"));

      snap.schedule();
      snap.flushEventDriven();
      await flushMicrotasks();
      expect(persistAsyncMock).toHaveBeenCalledTimes(1);

      // A failed write covers nothing, so the last-chance sync flush still runs.
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
