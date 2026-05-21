// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemWakePayload } from "@shared/types/ipc/system";

type WakeCallback = (payload: SystemWakePayload) => void;

let capturedCallback: WakeCallback | null = null;
const unsubMock = vi.fn();
const onWakeMock = vi.fn((cb: WakeCallback) => {
  capturedCallback = cb;
  return unsubMock;
});

// Tests control resolution via this deferred queue so they can sequence races.
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}
const pendingRefreshes: Deferred[] = [];
function nextDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const refreshMock = vi.fn(() => {
  const d = nextDeferred();
  pendingRefreshes.push(d);
  return d.promise;
});

vi.stubGlobal("window", {
  electron: {
    system: { onWake: onWakeMock },
    worktree: { refresh: refreshMock },
  },
});

const {
  useSystemWakeStore,
  setupSystemWakeListeners,
  cleanupSystemWakeListeners,
  WAKE_NOOP_THRESHOLD_MS,
  WAKE_LONG_SLEEP_THRESHOLD_MS,
} = await import("../systemWakeStore");

function emitWake(sleepDuration: number): void {
  if (!capturedCallback) throw new Error("listeners not set up");
  capturedCallback({ sleepDuration, timestamp: Date.now() });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function takeRefresh(index: number): Deferred {
  const d = pendingRefreshes[index];
  if (!d) throw new Error(`no pending refresh at index ${index}`);
  return d;
}

describe("systemWakeStore", () => {
  beforeEach(() => {
    cleanupSystemWakeListeners();
    useSystemWakeStore.setState({
      wakeEpoch: 0,
      lastSleepDuration: 0,
      isWakeRevalidating: false,
    });
    vi.clearAllMocks();
    capturedCallback = null;
    pendingRefreshes.length = 0;
  });

  afterEach(() => {
    cleanupSystemWakeListeners();
  });

  it("subscribes to onWake once on setup", () => {
    setupSystemWakeListeners();
    expect(onWakeMock).toHaveBeenCalledOnce();
  });

  it("is idempotent — double setup registers only once", () => {
    setupSystemWakeListeners();
    setupSystemWakeListeners();
    expect(onWakeMock).toHaveBeenCalledOnce();
  });

  it("cleanup unsubscribes and allows re-setup", () => {
    setupSystemWakeListeners();
    cleanupSystemWakeListeners();
    expect(unsubMock).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    setupSystemWakeListeners();
    expect(onWakeMock).toHaveBeenCalledOnce();
  });

  it("returns a no-op cleanup when window is undefined", () => {
    cleanupSystemWakeListeners();
    const originalWindow = globalThis.window;
    delete (globalThis as { window?: unknown }).window;

    const cleanup = setupSystemWakeListeners();
    expect(typeof cleanup).toBe("function");
    cleanup();
    expect(onWakeMock).not.toHaveBeenCalled();

    globalThis.window = originalWindow;
  });

  it("tier 1: sub-threshold wake (<= 30s) does not mutate state and does not refresh", () => {
    setupSystemWakeListeners();
    emitWake(WAKE_NOOP_THRESHOLD_MS);
    emitWake(1_000);

    expect(useSystemWakeStore.getState()).toEqual({
      wakeEpoch: 0,
      lastSleepDuration: 0,
      isWakeRevalidating: false,
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("tier 2: medium wake (30s < d <= 5min) bumps epoch and lastSleepDuration but does not refresh", () => {
    setupSystemWakeListeners();
    emitWake(WAKE_NOOP_THRESHOLD_MS + 1);

    expect(useSystemWakeStore.getState()).toEqual({
      wakeEpoch: 1,
      lastSleepDuration: WAKE_NOOP_THRESHOLD_MS + 1,
      isWakeRevalidating: false,
    });
    expect(refreshMock).not.toHaveBeenCalled();

    emitWake(WAKE_LONG_SLEEP_THRESHOLD_MS);
    expect(useSystemWakeStore.getState()).toEqual({
      wakeEpoch: 2,
      lastSleepDuration: WAKE_LONG_SLEEP_THRESHOLD_MS,
      isWakeRevalidating: false,
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("tier 3: long wake (> 5min) bumps epoch, sets isWakeRevalidating, and calls refresh", () => {
    setupSystemWakeListeners();
    emitWake(WAKE_LONG_SLEEP_THRESHOLD_MS + 1);

    expect(useSystemWakeStore.getState()).toEqual({
      wakeEpoch: 1,
      lastSleepDuration: WAKE_LONG_SLEEP_THRESHOLD_MS + 1,
      isWakeRevalidating: true,
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("isWakeRevalidating clears after refresh resolves", async () => {
    setupSystemWakeListeners();
    emitWake(WAKE_LONG_SLEEP_THRESHOLD_MS + 1);

    expect(useSystemWakeStore.getState().isWakeRevalidating).toBe(true);
    takeRefresh(0).resolve();
    await flushMicrotasks();

    expect(useSystemWakeStore.getState().isWakeRevalidating).toBe(false);
  });

  it("isWakeRevalidating clears after refresh rejects", async () => {
    setupSystemWakeListeners();
    emitWake(WAKE_LONG_SLEEP_THRESHOLD_MS + 1);

    expect(useSystemWakeStore.getState().isWakeRevalidating).toBe(true);
    takeRefresh(0).reject(new Error("boom"));
    await flushMicrotasks();

    expect(useSystemWakeStore.getState().isWakeRevalidating).toBe(false);
  });

  it("epoch guard: stale tier-3 finally does not clear flag while a newer tier-3 refresh is in flight", async () => {
    setupSystemWakeListeners();
    emitWake(WAKE_LONG_SLEEP_THRESHOLD_MS + 1);
    emitWake(WAKE_LONG_SLEEP_THRESHOLD_MS + 2);

    expect(refreshMock).toHaveBeenCalledTimes(2);
    expect(useSystemWakeStore.getState().isWakeRevalidating).toBe(true);
    expect(useSystemWakeStore.getState().wakeEpoch).toBe(2);

    takeRefresh(0).resolve();
    await flushMicrotasks();

    expect(useSystemWakeStore.getState().isWakeRevalidating).toBe(true);

    takeRefresh(1).resolve();
    await flushMicrotasks();

    expect(useSystemWakeStore.getState().isWakeRevalidating).toBe(false);
  });

  it("subscribers observe isWakeRevalidating transitioning true -> false across a tier-3 refresh", async () => {
    setupSystemWakeListeners();

    const seen: boolean[] = [];
    const unsubscribe = useSystemWakeStore.subscribe((state, prev) => {
      if (state.isWakeRevalidating !== prev.isWakeRevalidating) {
        seen.push(state.isWakeRevalidating);
      }
    });

    emitWake(WAKE_LONG_SLEEP_THRESHOLD_MS + 1);
    takeRefresh(0).resolve();
    await flushMicrotasks();

    unsubscribe();
    expect(seen).toEqual([true, false]);
  });

  it("revalidate guard: a tier-2 wake during an in-flight tier-3 refresh does not clear isWakeRevalidating", async () => {
    setupSystemWakeListeners();
    emitWake(WAKE_LONG_SLEEP_THRESHOLD_MS + 1);

    expect(useSystemWakeStore.getState().isWakeRevalidating).toBe(true);
    expect(useSystemWakeStore.getState().wakeEpoch).toBe(1);

    emitWake(60_000);

    expect(useSystemWakeStore.getState().wakeEpoch).toBe(2);
    expect(useSystemWakeStore.getState().lastSleepDuration).toBe(60_000);
    expect(useSystemWakeStore.getState().isWakeRevalidating).toBe(true);

    takeRefresh(0).resolve();
    await flushMicrotasks();

    expect(useSystemWakeStore.getState().isWakeRevalidating).toBe(false);
  });
});
