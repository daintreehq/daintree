// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { WorktreeSnapshot } from "@shared/types";
import type { WorktreeViewStoreApi } from "@/store/createWorktreeStore";
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

function worktree(id: string, hasStatus: boolean): WorktreeSnapshot {
  return {
    id,
    worktreeChanges: hasStatus ? { changedFileCount: 0 } : null,
  } as unknown as WorktreeSnapshot;
}

function makeStore(worktrees: WorktreeSnapshot[], isInitialized = true, epoch = "e1") {
  return createStore(() => ({
    worktrees: new Map(worktrees.map((w) => [w.id, w])),
    isInitialized,
    version: { epoch, seq: 1 },
  })) as unknown as WorktreeViewStoreApi;
}

function setWorktrees(store: WorktreeViewStoreApi, worktrees: WorktreeSnapshot[]) {
  store.setState({
    worktrees: new Map(worktrees.map((w) => [w.id, w])),
    version: { epoch: store.getState().version.epoch, seq: store.getState().version.seq + 1 },
  });
}

function makePortReady() {
  portReady = true;
  for (const cb of [...readyCallbacks]) cb();
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
              readyCallbacks = readyCallbacks.filter((c) => c !== cb);
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
    const detach = attachSwitchStatusTimingStore(makeStore([worktree("a", true), worktree("b", true)]));
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

    setWorktrees(store, [worktree("a", true), worktree("b", false)]);
    expect(request).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + 2_300);
    setWorktrees(store, [worktree("a", true), worktree("b", true)]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ appliedAt: T0 + 2_300, statusCount: 2 });

    await settle();
    setWorktrees(store, [worktree("a", true), worktree("b", true), worktree("c", true)]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not judge a store that has not been hydrated", () => {
    const store = makeStore([], false);
    attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).not.toHaveBeenCalled();

    store.setState({ isInitialized: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ worktreeCount: 0, statusCount: 0 });
  });

  it("starts once the store attaches when the switch arrives first", () => {
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).not.toHaveBeenCalled();

    attachSwitchStatusTimingStore(makeStore([worktree("a", true)]));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("waits for the worktree port before reporting", () => {
    portReady = false;
    attachSwitchStatusTimingStore(makeStore([worktree("a", true)]));
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).not.toHaveBeenCalled();

    makePortReady();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries a refused report only after the store changes", async () => {
    request.mockResolvedValueOnce({ accepted: false });
    const store = makeStore([worktree("a", true)], true, "old");
    attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);
    expect(request).toHaveBeenCalledTimes(1);

    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    store.setState({
      worktrees: new Map([["a", worktree("a", false)]]),
      version: { epoch: "new", seq: 1 },
    });
    expect(request).toHaveBeenCalledTimes(1);

    setWorktrees(store, [worktree("a", true)]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![1]).toMatchObject({ epoch: "new" });
  });

  it("re-judges a refused report when the store moved while it was in flight", async () => {
    let refuse!: (value: { accepted: boolean }) => void;
    request.mockReturnValueOnce(new Promise((resolve) => (refuse = resolve)));
    const store = makeStore([worktree("a", true)]);
    attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);

    setWorktrees(store, [worktree("a", true)]);
    expect(request).toHaveBeenCalledTimes(1);

    refuse({ accepted: false });
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
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

    setWorktrees(store, [worktree("a", true)]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ switchId: "s2" });
  });

  it("stops watching a store that detaches", () => {
    const store = makeStore([worktree("a", false)]);
    const detach = attachSwitchStatusTimingStore(store);
    armSwitchStatusTiming("s1", DEADLINE);
    detach();

    setWorktrees(store, [worktree("a", true)]);
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
