import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

import { createWorktreeStore, type WorktreeViewStoreApi } from "../createWorktreeStore";
import { startWorktreeReconnectRecovery } from "../worktreeReconnectRecovery";
import { needsReconnectRetry } from "@/lib/worktreeReconnect";
import { logInfo, logWarn } from "@/utils/logger";

const STALLED_MS = 30_000;

let store: WorktreeViewStoreApi;
let observed: boolean;
let linkUp: boolean;
let observedListeners: Array<() => void>;
let linkListeners: Array<() => void>;
let hasProject: boolean;
let projectListeners: Array<() => void>;
let retry: ReturnType<typeof vi.fn<() => Promise<void>>>;
let stop: (() => void) | null;

function setObserved(next: boolean) {
  observed = next;
  for (const listener of observedListeners) listener();
}

function setLinkUp(next: boolean) {
  linkUp = next;
  for (const listener of linkListeners) listener();
}

function start() {
  stop = startWorktreeReconnectRecovery({
    store,
    retry,
    hasProject: () => hasProject,
    subscribeProject: (listener) => {
      projectListeners.push(listener);
      return () => {
        projectListeners = projectListeners.filter((l) => l !== listener);
      };
    },
    isObserved: () => observed,
    subscribeObserved: (listener) => {
      observedListeners.push(listener);
      return () => {
        observedListeners = observedListeners.filter((l) => l !== listener);
      };
    },
    isLinkUp: () => linkUp,
    subscribeLink: (listener) => {
      linkListeners.push(listener);
      return () => {
        linkListeners = linkListeners.filter((l) => l !== listener);
      };
    },
  });
}

/** What the sidebar and the Retry action read: is the stalled banner up? */
function bannerOffered(): boolean {
  return needsReconnectRetry(store.getState());
}

/** A snapshot landing over the redelivered port, as fetchInitialState does. */
function hydrate() {
  store.getState().applySnapshot([], { epoch: "e2", seq: 1 });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  store = createWorktreeStore();
  store.getState().applySnapshot([], { epoch: "e1", seq: 1 });
  observed = true;
  linkUp = true;
  observedListeners = [];
  linkListeners = [];
  hasProject = true;
  projectListeners = [];
  retry = vi.fn<() => Promise<void>>();
  stop = null;
  vi.mocked(logInfo).mockClear();
  vi.mocked(logWarn).mockClear();
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

describe("startWorktreeReconnectRecovery (#14313)", () => {
  it("recovers a view that comes back from the background with a dead port, with no banner", async () => {
    retry.mockImplementation(async () => {
      hydrate();
    });
    start();
    setObserved(false);
    store.getState().setReconnecting(true);

    // Cached for 172 s: long past the stall threshold, and nobody retried.
    await vi.advanceTimersByTimeAsync(172_000);
    expect(retry).not.toHaveBeenCalled();
    expect(store.getState().reconnectRecovery).toBe("recovering");
    expect(bannerOffered()).toBe(false);

    setObserved(true);
    expect(bannerOffered()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(store.getState().isReconnecting).toBe(false);
    expect(store.getState().reconnectRecovery).toBe("idle");
    expect(bannerOffered()).toBe(false);
    expect(logInfo).toHaveBeenCalledWith("Worktree reconnect recovered", { attempts: 1 });
  });

  it("offers the banner only after every automatic attempt fails", async () => {
    retry.mockRejectedValue(new Error("Reloaded the project but couldn't connect"));
    start();
    store.getState().setReconnecting(true);

    await vi.advanceTimersByTimeAsync(STALLED_MS - 1);
    expect(retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(bannerOffered()).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(retry).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(retry).toHaveBeenCalledTimes(3);
    expect(bannerOffered()).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(retry).toHaveBeenCalledTimes(4);

    expect(store.getState().reconnectRecovery).toBe("exhausted");
    expect(bannerOffered()).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(
      "Worktree reconnect recovery attempt failed",
      expect.objectContaining({ attempt: 4, of: 4 })
    );
    expect(logWarn).toHaveBeenCalledWith("Worktree reconnect recovery gave up", { attempts: 4 });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(retry).toHaveBeenCalledTimes(4);
  });

  it("waits for a redelivered port's snapshot before replacing it", async () => {
    retry.mockResolvedValue(undefined);
    start();
    store.getState().setReconnecting(true);
    await vi.advanceTimersByTimeAsync(STALLED_MS);
    expect(retry).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(retry).toHaveBeenCalledTimes(1);
    hydrate();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(store.getState().reconnectRecovery).toBe("idle");
  });

  it("gives up on ports that never carry data, after the last one's hydration window", async () => {
    retry.mockResolvedValue(undefined);
    start();
    store.getState().setReconnecting(true);
    await vi.advanceTimersByTimeAsync(STALLED_MS + 10_000 + 10_000 + 15_000);
    expect(retry).toHaveBeenCalledTimes(4);
    expect(bannerOffered()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getState().reconnectRecovery).toBe("exhausted");
    expect(bannerOffered()).toBe(true);
  });

  it("pauses while the link is down, keeping the round's budget", async () => {
    retry.mockRejectedValue(new Error("no host"));
    start();
    store.getState().setReconnecting(true);
    await vi.advanceTimersByTimeAsync(STALLED_MS);
    expect(retry).toHaveBeenCalledTimes(1);

    setLinkUp(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(retry).toHaveBeenCalledTimes(1);
    // The host banner explains a dead link; a Retry here couldn't cross it.
    expect(bannerOffered()).toBe(false);

    setLinkUp(true);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + 8_000 + 15_000);
    expect(retry).toHaveBeenCalledTimes(4);
    expect(bannerOffered()).toBe(true);
  });

  it("can't hold off the banner with a flapping link", async () => {
    retry.mockRejectedValue(new Error("no host"));
    start();
    store.getState().setReconnecting(true);
    await vi.advanceTimersByTimeAsync(STALLED_MS);
    for (let i = 0; i < 20; i += 1) {
      setLinkUp(false);
      setLinkUp(true);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).toHaveBeenCalledTimes(4);
    expect(bannerOffered()).toBe(true);
  });

  it("picks up a stall once a project binds", async () => {
    retry.mockImplementation(async () => {
      hydrate();
    });
    hasProject = false;
    start();
    store.getState().setReconnecting(true);
    await vi.advanceTimersByTimeAsync(STALLED_MS * 2);
    expect(retry).not.toHaveBeenCalled();

    hasProject = true;
    for (const listener of projectListeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(store.getState().isReconnecting).toBe(false);
  });

  it("gives an exhausted reconnect a fresh round when the view is seen again", async () => {
    retry.mockRejectedValue(new Error("no host"));
    start();
    store.getState().setReconnecting(true);
    await vi.advanceTimersByTimeAsync(STALLED_MS + 26_000);
    expect(store.getState().reconnectRecovery).toBe("exhausted");

    setObserved(false);
    retry.mockImplementation(async () => {
      hydrate();
    });
    setObserved(true);
    expect(bannerOffered()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).toHaveBeenCalledTimes(5);
    expect(store.getState().isReconnecting).toBe(false);
  });

  it("leaves a crashed host to its own banner and stops on teardown", async () => {
    retry.mockRejectedValue(new Error("no host"));
    start();
    store.getState().setReconnecting(true);
    store.getState().setFatalError("crashed");
    await vi.advanceTimersByTimeAsync(STALLED_MS * 2);
    expect(retry).not.toHaveBeenCalled();

    store.getState().setError(null);
    store.getState().setReconnecting(true);
    stop?.();
    stop = null;
    await vi.advanceTimersByTimeAsync(STALLED_MS * 2);
    expect(retry).not.toHaveBeenCalled();
  });
});
