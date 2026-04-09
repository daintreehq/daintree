import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const browserWindowFromWebContentsMock = vi.hoisted(() => vi.fn());
const browserWindowGetAllWindowsMock = vi.hoisted(() => vi.fn(() => [] as unknown[]));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: Object.assign(class {}, {
    fromWebContents: browserWindowFromWebContentsMock,
    getAllWindows: browserWindowGetAllWindowsMock,
  }),
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: browserWindowFromWebContentsMock,
  getAppWebContents: vi.fn(
    (win: { webContents?: unknown }) =>
      win.webContents ?? { send: undefined, isDestroyed: () => true }
  ),
  getAllAppWebContents: vi.fn(() => {
    const windows = browserWindowGetAllWindowsMock() as Array<{
      isDestroyed: () => boolean;
      webContents?: { isDestroyed: () => boolean; send: (...args: unknown[]) => void };
    }>;
    return windows
      .filter((w) => !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed())
      .map((w) => w.webContents);
  }),
}));

vi.mock("../../window/windowRef.js", () => ({
  getProjectViewManager: vi.fn(() => null),
}));

import {
  sendToRenderer,
  broadcastToRenderer,
  sendToRendererContext,
  typedHandle,
  typedHandleWithContext,
  typedSend,
  checkRateLimit,
  waitForRateLimitSlot,
  drainRateLimitQueues,
  armRestoreQuota,
  consumeRestoreQuota,
  _resetRateLimitQueuesForTest,
} from "../utils.js";

describe("ipc utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sendToRenderer sends when window and webContents are alive", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send,
      },
    } as unknown;

    sendToRenderer(win as never, "channel:test", { ok: true });
    expect(send).toHaveBeenCalledWith("channel:test", { ok: true });
  });

  it("sendToRenderer tolerates missing webContents without throwing", () => {
    const win = {
      isDestroyed: () => false,
    } as unknown;

    expect(() => sendToRenderer(win as never, "channel:test", { ok: true })).not.toThrow();
  });

  it("sendToRenderer tolerates webContents without isDestroyed function", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: {
        send,
      },
    } as unknown;

    expect(() => sendToRenderer(win as never, "channel:test", { ok: true })).not.toThrow();
    expect(send).toHaveBeenCalledWith("channel:test", { ok: true });
  });

  it("typedSend sends payload when window is alive", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send,
      },
    } as unknown;

    typedSend(win as never, "app:error" as never, { error: "x" } as never);
    expect(send).toHaveBeenCalledWith("app:error", { error: "x" });
  });

  it("typedSend tolerates missing webContents without throwing", () => {
    const win = {
      isDestroyed: () => false,
    } as unknown;

    expect(() =>
      typedSend(win as never, "app:error" as never, { error: "x" } as never)
    ).not.toThrow();
  });

  it("typedSend tolerates webContents without isDestroyed function", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: {
        send,
      },
    } as unknown;

    expect(() =>
      typedSend(win as never, "app:error" as never, { error: "x" } as never)
    ).not.toThrow();
    expect(send).toHaveBeenCalledWith("app:error", { error: "x" });
  });

  it("typedHandle registers handler and cleanup removes it", async () => {
    const handler = vi.fn(async (input: string) => ({ ok: input === "value" }));
    const cleanup = typedHandle("project:get:all" as never, handler as never);

    const [[channel, registered]] = ipcMainMock.handle.mock.calls as [
      [string, (...args: unknown[]) => Promise<unknown>],
    ];
    expect(channel).toBe("project:get:all");

    const result = await registered({} as unknown, "value");
    expect(result).toEqual({ ok: true });

    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("project:get:all");
  });

  it("typedHandleWithContext passes IpcContext with webContentsId and senderWindow", async () => {
    const mockWindow = { id: 1 };
    browserWindowFromWebContentsMock.mockReturnValue(mockWindow);

    const handler = vi.fn(async (_ctx: unknown, _input: string) => ({
      ok: _input === "value",
    }));
    const cleanup = typedHandleWithContext("project:get:all" as never, handler as never);

    const [[channel, registered]] = ipcMainMock.handle.mock.calls as [
      [string, (...args: unknown[]) => Promise<unknown>],
    ];
    expect(channel).toBe("project:get:all");

    const mockEvent = { sender: { id: 42 } };
    const result = await registered(mockEvent, "value");
    expect(result).toEqual({ ok: true });

    expect(handler).toHaveBeenCalledOnce();
    const ctx = handler.mock.calls[0][0] as {
      webContentsId: number;
      senderWindow: unknown;
      event: unknown;
    };
    expect(ctx.webContentsId).toBe(42);
    expect(ctx.senderWindow).toBe(mockWindow);
    expect(ctx.event).toBe(mockEvent);

    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("project:get:all");
  });

  it("typedHandleWithContext sets senderWindow to null when fromWebContents returns null", async () => {
    browserWindowFromWebContentsMock.mockReturnValue(null);

    const handler = vi.fn(async (_ctx: unknown) => "ok");
    typedHandleWithContext("project:get:all" as never, handler as never);

    const [[, registered]] = ipcMainMock.handle.mock.calls as [
      [string, (...args: unknown[]) => Promise<unknown>],
    ];

    await registered({ sender: { id: 99 } });

    const ctx = handler.mock.calls[0][0] as { webContentsId: number; senderWindow: unknown };
    expect(ctx.webContentsId).toBe(99);
    expect(ctx.senderWindow).toBeNull();
  });
});

describe("broadcastToRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-ops when there are no open windows", () => {
    browserWindowGetAllWindowsMock.mockReturnValue([]);
    expect(() => broadcastToRenderer("channel:test", { ok: true })).not.toThrow();
  });

  it("sends to a single alive window", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
    };
    browserWindowGetAllWindowsMock.mockReturnValue([win]);

    broadcastToRenderer("channel:test", "data1", "data2");
    expect(send).toHaveBeenCalledWith("channel:test", "data1", "data2");
  });

  it("sends to multiple alive windows", () => {
    const send1 = vi.fn();
    const send2 = vi.fn();
    const win1 = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: send1 },
    };
    const win2 = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: send2 },
    };
    browserWindowGetAllWindowsMock.mockReturnValue([win1, win2]);

    broadcastToRenderer("channel:test", { payload: true });
    expect(send1).toHaveBeenCalledTimes(1);
    expect(send1).toHaveBeenCalledWith("channel:test", { payload: true });
    expect(send2).toHaveBeenCalledTimes(1);
    expect(send2).toHaveBeenCalledWith("channel:test", { payload: true });
  });

  it("skips destroyed windows", () => {
    const send1 = vi.fn();
    const send2 = vi.fn();
    const alive = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: send1 },
    };
    const destroyed = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false, send: send2 },
    };
    browserWindowGetAllWindowsMock.mockReturnValue([alive, destroyed]);

    broadcastToRenderer("channel:test");
    expect(send1).toHaveBeenCalled();
    expect(send2).not.toHaveBeenCalled();
  });

  it("skips windows with no webContents", () => {
    const win = { isDestroyed: () => false };
    browserWindowGetAllWindowsMock.mockReturnValue([win]);

    expect(() => broadcastToRenderer("channel:test")).not.toThrow();
  });

  it("skips windows where webContents is destroyed", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => true, send },
    };
    browserWindowGetAllWindowsMock.mockReturnValue([win]);

    broadcastToRenderer("channel:test");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not throw when webContents.send throws", () => {
    const send1 = vi.fn(() => {
      throw new Error("send failed");
    });
    const send2 = vi.fn();
    const win1 = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: send1 },
    };
    const win2 = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: send2 },
    };
    browserWindowGetAllWindowsMock.mockReturnValue([win1, win2]);

    expect(() => broadcastToRenderer("channel:test")).not.toThrow();
    expect(send2).toHaveBeenCalledWith("channel:test");
  });
});

describe("sendToRendererContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends to senderWindow when non-null and alive", () => {
    const send = vi.fn();
    const ctx = {
      senderWindow: {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send },
      },
      webContentsId: 1,
      event: {},
    };

    sendToRendererContext(ctx as never, "channel:test", "arg1", "arg2");
    expect(send).toHaveBeenCalledWith("channel:test", "arg1", "arg2");
  });

  it("no-ops when senderWindow is null", () => {
    const ctx = {
      senderWindow: null,
      webContentsId: 1,
      event: {},
    };

    expect(() => sendToRendererContext(ctx as never, "channel:test", "data")).not.toThrow();
  });

  it("passes variadic args through correctly", () => {
    const send = vi.fn();
    const ctx = {
      senderWindow: {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send },
      },
      webContentsId: 1,
      event: {},
    };

    sendToRendererContext(ctx as never, "channel:test", 1, "two", { three: 3 });
    expect(send).toHaveBeenCalledWith("channel:test", 1, "two", { three: 3 });
  });

  it("no-ops when senderWindow is destroyed", () => {
    const send = vi.fn();
    const ctx = {
      senderWindow: {
        isDestroyed: () => true,
        webContents: { isDestroyed: () => false, send },
      },
      webContentsId: 1,
      event: {},
    };

    sendToRendererContext(ctx as never, "channel:test", "data");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("checkRateLimit", () => {
  beforeEach(() => {
    _resetRateLimitQueuesForTest();
  });

  it("throws when rate limit is exceeded", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("test-channel", 5, 30_000);
    }
    expect(() => checkRateLimit("test-channel", 5, 30_000)).toThrow("Rate limit exceeded");
  });
});

describe("waitForRateLimitSlot (leaky bucket, 2-arg)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetRateLimitQueuesForTest();
  });

  afterEach(() => {
    _resetRateLimitQueuesForTest();
    vi.useRealTimers();
  });

  it("resolves immediately for the first caller on a fresh key", async () => {
    const start = Date.now();
    await waitForRateLimitSlot("lb-test", 5_000);
    expect(Date.now()).toBe(start);
  });

  it("serializes a concurrent burst at fixed intervals (no feast/famine)", async () => {
    const resolvedAt: number[] = [];
    const start = Date.now();
    const INTERVAL = 6_000;
    const N = 5;

    // Fire all callers synchronously via Promise.all — mimics the bulk
    // worktree dialog dispatching concurrent requests.
    const promises = Array.from({ length: N }, (_, i) =>
      waitForRateLimitSlot("lb-burst", INTERVAL).then(() => {
        resolvedAt.push(Date.now() - start);
        return i;
      })
    );

    // Allow microtasks to settle before advancing time.
    await vi.advanceTimersByTimeAsync(0);
    // First caller resolves immediately (waitMs = 0 on fresh bucket).
    expect(resolvedAt).toEqual([0]);

    // Advance through each interval; exactly one more resolves each time.
    for (let i = 1; i < N; i++) {
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(resolvedAt).toEqual(Array.from({ length: i + 1 }, (_, k) => k * INTERVAL));
    }

    await Promise.all(promises);
  });

  it("does not burst-release after a long idle then concurrent arrival", async () => {
    const INTERVAL = 4_000;
    // Seed the bucket
    await waitForRateLimitSlot("lb-idle", INTERVAL);
    // Idle past the interval — nextAvailableMs is in the past
    await vi.advanceTimersByTimeAsync(60_000);

    const resolved: number[] = [];
    const startAfterIdle = Date.now();
    const promises = [0, 1, 2].map((i) =>
      waitForRateLimitSlot("lb-idle", INTERVAL).then(() => {
        resolved.push(Date.now() - startAfterIdle);
        return i;
      })
    );

    await vi.advanceTimersByTimeAsync(0);
    // First caller gets through immediately (idle bucket), subsequent
    // callers spaced by INTERVAL — not released all at once.
    expect(resolved).toEqual([0]);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resolved).toEqual([0, INTERVAL]);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resolved).toEqual([0, INTERVAL, 2 * INTERVAL]);

    await Promise.all(promises);
  });

  it("different keys do not block each other", async () => {
    const INTERVAL = 5_000;
    await waitForRateLimitSlot("lb-keyA", INTERVAL);
    // Immediately after keyA's first slot, keyB should still resolve immediately
    const before = Date.now();
    await waitForRateLimitSlot("lb-keyB", INTERVAL);
    expect(Date.now()).toBe(before);
  });

  it("rejects when pending callers exceed MAX_QUEUE_DEPTH (50)", async () => {
    const INTERVAL = 1_000;
    const pending: Promise<void>[] = [];
    // First call resolves immediately (no pending count); 50 subsequent
    // callers each wait and bump pendingCount to 50.
    await waitForRateLimitSlot("lb-overflow", INTERVAL);
    for (let i = 0; i < 50; i++) {
      pending.push(waitForRateLimitSlot("lb-overflow", INTERVAL));
    }
    // The 51st pending caller exceeds MAX_QUEUE_DEPTH.
    await expect(waitForRateLimitSlot("lb-overflow", INTERVAL)).rejects.toThrow("Spawn queue full");

    // Let all pending callers resolve so the test cleans up.
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(pending);
  });

  it("pendingCount decrements after resolve so a subsequent caller can queue again", async () => {
    const INTERVAL = 2_000;
    await waitForRateLimitSlot("lb-decrement", INTERVAL);
    const p1 = waitForRateLimitSlot("lb-decrement", INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await p1;

    // After p1 resolves and its finally block runs, pendingCount is back to 0.
    // A new pending caller must be accepted.
    const p2 = waitForRateLimitSlot("lb-decrement", INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await expect(p2).resolves.toBeUndefined();
  });

  it("drainRateLimitQueues clears leaky bucket state so new callers start fresh", async () => {
    const INTERVAL = 5_000;
    await waitForRateLimitSlot("lb-drain", INTERVAL);
    // Bucket's nextAvailableMs is now ~5s in the future. Without drain, a
    // new caller would wait. After drain, state is cleared and the next
    // caller resolves immediately.
    drainRateLimitQueues();

    const before = Date.now();
    await waitForRateLimitSlot("lb-drain", INTERVAL);
    expect(Date.now()).toBe(before);
  });

  it("drainRateLimitQueues rejects in-flight leaky bucket waiters", async () => {
    const INTERVAL = 5_000;
    // First caller consumes the immediate slot.
    await waitForRateLimitSlot("lb-drain-reject", INTERVAL);
    // Second caller will sleep ~INTERVAL ms waiting for its reserved slot.
    const pending = waitForRateLimitSlot("lb-drain-reject", INTERVAL);

    // Drain before the timer fires — the waiter must be rejected, not
    // silently resumed (otherwise shutdown races real IPC work).
    drainRateLimitQueues();

    await expect(pending).rejects.toThrow("App is shutting down");

    // Even if we advance past the original sleep, the rejected promise
    // stays rejected and does not leak a second resolve.
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
  });

  it("treats intervalMs <= 0 as a no-op (defensive guard)", async () => {
    const before = Date.now();
    await waitForRateLimitSlot("lb-zero", 0);
    await waitForRateLimitSlot("lb-zero", -100);
    expect(Date.now()).toBe(before);
  });

  it("_resetRateLimitQueuesForTest clears leaky bucket state", async () => {
    await waitForRateLimitSlot("lb-reset", 5_000);
    _resetRateLimitQueuesForTest();

    const before = Date.now();
    await waitForRateLimitSlot("lb-reset", 5_000);
    expect(Date.now()).toBe(before);
  });
});

describe("waitForRateLimitSlot (sliding window, 3-arg)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetRateLimitQueuesForTest();
  });

  afterEach(() => {
    _resetRateLimitQueuesForTest();
    vi.useRealTimers();
  });

  it("resolves immediately when under the limit", async () => {
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      await waitForRateLimitSlot("test", 10, 30_000);
      results.push(i);
    }
    expect(results).toHaveLength(10);
  });

  it("queues the 11th request instead of rejecting", async () => {
    for (let i = 0; i < 10; i++) {
      await waitForRateLimitSlot("test", 10, 30_000);
    }

    let resolved = false;
    const promise = waitForRateLimitSlot("test", 10, 30_000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    await promise;
    expect(resolved).toBe(true);
  });

  it("drains queued requests FIFO as slots free up", async () => {
    for (let i = 0; i < 10; i++) {
      await waitForRateLimitSlot("test", 10, 30_000);
    }

    const order: number[] = [];
    const promises = [];
    for (let i = 0; i < 3; i++) {
      const idx = i;
      promises.push(
        waitForRateLimitSlot("test", 10, 30_000).then(() => {
          order.push(idx);
        })
      );
    }

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2]);
  });

  it("new arrivals do not bypass the queue when a slot opens", async () => {
    // Fill all 3 slots
    for (let i = 0; i < 3; i++) {
      await waitForRateLimitSlot("test", 3, 30_000);
    }

    const order: string[] = [];
    // Queue a waiter while at capacity
    const queued = waitForRateLimitSlot("test", 3, 30_000).then(() => {
      order.push("queued");
    });

    // Advance time so slots free up, then submit a new arrival
    // The queued waiter should still go first due to queue.length === 0 check
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    const late = waitForRateLimitSlot("test", 3, 30_000).then(() => {
      order.push("late");
    });

    await Promise.all([queued, late]);
    expect(order).toEqual(["queued", "late"]);
  });

  it("rejects when queue depth exceeds 50", async () => {
    for (let i = 0; i < 10; i++) {
      await waitForRateLimitSlot("test", 10, 30_000);
    }

    const queued: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      queued.push(waitForRateLimitSlot("test", 10, 30_000));
    }

    await expect(waitForRateLimitSlot("test", 10, 30_000)).rejects.toThrow("Spawn queue full");

    await vi.advanceTimersByTimeAsync(300_000);
    await Promise.all(queued);
  });

  it("drainRateLimitQueues rejects all pending waiters across keys", async () => {
    for (let i = 0; i < 5; i++) {
      await waitForRateLimitSlot("keyA", 5, 30_000);
      await waitForRateLimitSlot("keyB", 5, 30_000);
    }

    const promiseA1 = waitForRateLimitSlot("keyA", 5, 30_000);
    const promiseA2 = waitForRateLimitSlot("keyA", 5, 30_000);
    const promiseB1 = waitForRateLimitSlot("keyB", 5, 30_000);

    drainRateLimitQueues();

    await expect(promiseA1).rejects.toThrow("App is shutting down");
    await expect(promiseA2).rejects.toThrow("App is shutting down");
    await expect(promiseB1).rejects.toThrow("App is shutting down");
  });

  it("drains partially when only some timestamps expire", async () => {
    // Fill 3 slots at staggered times: t=0, t=10s, t=20s
    await waitForRateLimitSlot("test", 3, 30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForRateLimitSlot("test", 3, 30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForRateLimitSlot("test", 3, 30_000);

    // Now at t=20s, all 3 slots used. Queue 3 waiters.
    const order: number[] = [];
    const promises = [0, 1, 2].map((i) =>
      waitForRateLimitSlot("test", 3, 30_000).then(() => {
        order.push(i);
      })
    );

    // At t=30s, the first timestamp (t=0) expires → 1 slot frees → waiter 0 resolves
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([0]);

    // At t=40s, the second timestamp (t=10s) expires → waiter 1 resolves
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([0, 1]);

    // At t=50s, the third timestamp (t=20s) expires → waiter 2 resolves
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([0, 1, 2]);

    await Promise.all(promises);
  });

  it("works correctly across multiple keys", async () => {
    for (let i = 0; i < 5; i++) {
      await waitForRateLimitSlot("keyA", 5, 30_000);
    }

    await waitForRateLimitSlot("keyB", 5, 30_000);

    let resolvedA = false;
    waitForRateLimitSlot("keyA", 5, 30_000).then(() => {
      resolvedA = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolvedA).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolvedA).toBe(true);
  });
});

describe("restore quota", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetRateLimitQueuesForTest();
  });

  afterEach(() => {
    _resetRateLimitQueuesForTest();
    vi.useRealTimers();
  });

  it("consumeRestoreQuota returns true exactly N times after armRestoreQuota(N)", () => {
    armRestoreQuota(3, 60_000);

    expect(consumeRestoreQuota()).toBe(true);
    expect(consumeRestoreQuota()).toBe(true);
    expect(consumeRestoreQuota()).toBe(true);
    expect(consumeRestoreQuota()).toBe(false);
    expect(consumeRestoreQuota()).toBe(false);
  });

  it("consumeRestoreQuota returns false when no quota is armed", () => {
    expect(consumeRestoreQuota()).toBe(false);
  });

  it("quota expires after TTL", () => {
    armRestoreQuota(10, 5_000);

    expect(consumeRestoreQuota()).toBe(true);

    vi.advanceTimersByTime(5_000);

    expect(consumeRestoreQuota()).toBe(false);
  });

  it("re-arming resets the quota and TTL", () => {
    armRestoreQuota(2, 5_000);
    expect(consumeRestoreQuota()).toBe(true);

    // Re-arm with longer TTL — old 5s timer should be cleared
    armRestoreQuota(3, 10_000);
    expect(consumeRestoreQuota()).toBe(true);
    expect(consumeRestoreQuota()).toBe(true);
    expect(consumeRestoreQuota()).toBe(true);
    expect(consumeRestoreQuota()).toBe(false);

    // Advance past the original 5s TTL — quota should still be 0 (not re-expired)
    armRestoreQuota(5, 20_000);
    vi.advanceTimersByTime(5_000);
    // If old timer wasn't cleared, quota would be wiped at 5s. It shouldn't be.
    expect(consumeRestoreQuota()).toBe(true);

    // But advancing to 20s should expire the new TTL
    vi.advanceTimersByTime(15_000);
    expect(consumeRestoreQuota()).toBe(false);
  });

  it("_resetRateLimitQueuesForTest clears quota state", () => {
    armRestoreQuota(5, 60_000);
    expect(consumeRestoreQuota()).toBe(true);

    _resetRateLimitQueuesForTest();

    expect(consumeRestoreQuota()).toBe(false);
  });
});
