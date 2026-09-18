// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeSnapshot } from "@shared/types";
import { createWorktreeStore, type WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import {
  armSwitchStatusTiming,
  attachSwitchStatusTimingStore,
  installProjectSwitchStatusTiming,
  resetProjectSwitchStatusTimingForTesting,
} from "../projectSwitchStatusTiming";

type OnSwitch = (payload: { switchId?: string; statusTimingDeadlineAt?: number }) => void;

const T0 = 1_700_000_000_000;
const DEADLINE = T0 + 15_000;

let portReady: boolean;
let readyCallbacks: Array<() => void>;
let onSwitchListeners: OnSwitch[];
let request: ReturnType<typeof vi.fn>;
let seq = 0;

function worktree(id: string, hasStatus: boolean, changedFileCount = 0): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    isCurrent: false,
    worktreeChanges: hasStatus
      ? { worktreeId: id, rootPath: `/repo/${id}`, changes: [], changedFileCount }
      : null,
  };
}

function hydrate(store: WorktreeViewStoreApi, worktrees: WorktreeSnapshot[], epoch = "e1") {
  store.getState().applySnapshot(worktrees, { epoch, seq: ++seq });
}

function update(store: WorktreeViewStoreApi, snapshot: WorktreeSnapshot, epoch?: string) {
  const current = store.getState().version.epoch;
  store.getState().applyUpdate(snapshot, { epoch: epoch ?? current, seq: ++seq });
}

function makeStore(worktrees: WorktreeSnapshot[], epoch = "e1"): WorktreeViewStoreApi {
  const store = createWorktreeStore();
  hydrate(store, worktrees, epoch);
  return store;
}

// Walks the live list, as the preload's port client does, so a callback that
// unregisters itself mid-walk skips the next one exactly as it would there.
function makePortReady() {
  portReady = true;
  for (const cb of readyCallbacks) cb();
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("projectSwitchStatusTiming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    portReady = true;
    readyCallbacks = [];
    onSwitchListeners = [];
    request = vi.fn().mockResolvedValue({ accepted: true });
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        project: {
          onSwitch: (cb: OnSwitch) => {
            onSwitchListeners.push(cb);
            return () => {};
          },
        },
        worktreePort: {
          isReady: () => portReady,
          onReady: (cb: () => void) => {
            if (portReady) cb();
            readyCallbacks.push(cb);
            return () => {
              const index = readyCallbacks.indexOf(cb);
              if (index >= 0) readyCallbacks.splice(index, 1);
            };
          },
          request,
        },
      },
    });
  });

  afterEach(() => {
    resetProjectSwitchStatusTimingForTesting();
    vi.useRealTimers();
  });

  it("reports at once when a warm view already has every status", async () => {
    const detach = attachSwitchStatusTimingStore(
      makeStore([worktree("a", true), worktree("b", true)])
    );
    vi.setSystemTime(T0 + 40);
    armSwitchStatusTiming("s1", DEADLINE);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("report-switch-status-timing", {
      switchId: "s1",
      epoch: "e1",
      appliedAt: T0 + 40,
      worktreeCount: 2,
      statusCount: 2,
    });
    await settle();
    expect(readyCallbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    detach();
  });

  it("waits until the last worktree's status is applied", async () => {
    const store = makeStore([worktree("a", false), worktree("b", false)]);
    attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).not.toHaveBeenCalled();

    update(store, worktree("a", true));
    expect(request).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + 2_300);
    update(store, worktree("b", true));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ appliedAt: T0 + 2_300, statusCount: 2 });

    await settle();
    update(store, worktree("c", true));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not judge a store that has not been hydrated", () => {
    const store = createWorktreeStore();
    attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).not.toHaveBeenCalled();

    hydrate(store, []);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ worktreeCount: 0, statusCount: 0 });
  });

  it("starts once the store attaches when the switch arrives first", () => {
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).not.toHaveBeenCalled();

    attachSwitchStatusTimingStore(makeStore([worktree("a", true)]));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("waits for the worktree port before reporting", async () => {
    portReady = false;
    attachSwitchStatusTimingStore(makeStore([worktree("a", true)]));
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).not.toHaveBeenCalled();

    makePortReady();
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never starves a later ready handler when a late port finishes the switch", async () => {
    portReady = false;
    attachSwitchStatusTimingStore(makeStore([worktree("a", true)]));
    armSwitchStatusTiming("s1", DEADLINE);
    // Registered after the reporter's, as the provider's hydration handler is.
    const startHydration = vi.fn();
    window.electron.worktreePort.onReady(startHydration);

    vi.setSystemTime(DEADLINE + 1);
    makePortReady();
    expect(startHydration).toHaveBeenCalledTimes(1);

    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ appliedAt: null });
    expect(readyCallbacks).toEqual([startHydration]);
  });

  it("does not judge rows left by a host whose port closed until they are replaced", () => {
    const store = makeStore([worktree("a", true)]);
    store.getState().setReconnecting(true);
    attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);

    update(store, worktree("a", true, 1), "e2");
    expect(request).not.toHaveBeenCalled();

    hydrate(store, [worktree("a", true)], "e2");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ epoch: "e2" });
  });

  it("judges again after a pause when the report fails in transit", async () => {
    request.mockRejectedValueOnce(new Error("Worktree port timed out"));
    attachSwitchStatusTimingStore(makeStore([worktree("a", true)]));
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).toHaveBeenCalledTimes(1);

    await settle();
    vi.advanceTimersByTime(500);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports again from the new host's state after a refusal", async () => {
    request.mockResolvedValueOnce({ accepted: false });
    const store = makeStore([worktree("a", true)], "old");
    attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).toHaveBeenCalledTimes(1);

    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    // The restarted host's statusless first snapshot, then its status.
    update(store, worktree("a", false), "new");
    expect(request).toHaveBeenCalledTimes(1);

    update(store, worktree("a", true));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![1]).toMatchObject({ epoch: "new" });
  });

  it("re-judges a refused report when the store moved while it was in flight", async () => {
    let refuse!: (value: { accepted: boolean }) => void;
    request.mockReturnValueOnce(new Promise((resolve) => (refuse = resolve)));
    const store = makeStore([worktree("a", true)]);
    attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);

    update(store, worktree("a", true, 1));
    expect(request).toHaveBeenCalledTimes(1);

    refuse({ accepted: false });
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("judges a refused report again after a pause when the store never moves", async () => {
    request.mockResolvedValueOnce({ accepted: false });
    attachSwitchStatusTimingStore(makeStore([]));
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).toHaveBeenCalledTimes(1);

    await settle();
    vi.advanceTimersByTime(499);
    expect(request).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(request).toHaveBeenCalledTimes(2);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a timeout, not success, when the switch arrives after its deadline", () => {
    vi.setSystemTime(DEADLINE + 1_000);
    attachSwitchStatusTimingStore(makeStore([worktree("a", true)]));
    armSwitchStatusTiming("s1", DEADLINE);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ appliedAt: null, statusCount: 1 });
    expect(readyCallbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports what it has when the deadline passes first", () => {
    attachSwitchStatusTimingStore(makeStore([worktree("a", true), worktree("b", false)]));
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15_000);
    expect(request).toHaveBeenCalledWith("report-switch-status-timing", {
      switchId: "s1",
      epoch: "e1",
      appliedAt: null,
      worktreeCount: 2,
      statusCount: 1,
    });
    expect(readyCallbacks).toHaveLength(0);
  });

  it("drops the deadline report when the port is down", () => {
    portReady = false;
    attachSwitchStatusTimingStore(makeStore([worktree("a", false)]));
    armSwitchStatusTiming("s1", DEADLINE);
    vi.advanceTimersByTime(15_000);
    expect(request).not.toHaveBeenCalled();
    expect(readyCallbacks).toHaveLength(0);
  });

  it("replaces an earlier switch that never finished", () => {
    const store = makeStore([worktree("a", false)]);
    attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);
    armSwitchStatusTiming("s2", DEADLINE + 500);
    expect(vi.getTimerCount()).toBe(1);

    update(store, worktree("a", true));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ switchId: "s2" });
  });

  it("stops watching a store that detaches", () => {
    const store = makeStore([worktree("a", false)]);
    const detach = attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);
    detach();

    update(store, worktree("a", true));
    expect(request).not.toHaveBeenCalled();
    expect(readyCallbacks).toHaveLength(0);
  });

  it("arms only from a switch main is timing", () => {
    installProjectSwitchStatusTiming();
    installProjectSwitchStatusTiming();
    expect(onSwitchListeners).toHaveLength(1);
    attachSwitchStatusTimingStore(makeStore([worktree("a", true)]));

    onSwitchListeners[0]!({ switchId: "s0" });
    expect(request).not.toHaveBeenCalled();

    onSwitchListeners[0]!({ switchId: "s1", statusTimingDeadlineAt: DEADLINE });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ switchId: "s1" });
  });
});
