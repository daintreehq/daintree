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

describe("waitForRateLimitSlot", () => {
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
