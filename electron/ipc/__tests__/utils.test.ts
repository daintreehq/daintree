import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: class {},
}));

import {
  sendToRenderer,
  typedHandle,
  typedSend,
  checkRateLimit,
  waitForRateLimitSlot,
  drainRateLimitQueues,
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

  it("new arrivals do not bypass the queue (FIFO fairness)", async () => {
    for (let i = 0; i < 10; i++) {
      await waitForRateLimitSlot("test", 10, 30_000);
    }

    const order: string[] = [];
    const first = waitForRateLimitSlot("test", 10, 30_000).then(() => {
      order.push("first");
    });

    await vi.advanceTimersByTimeAsync(0);

    const second = waitForRateLimitSlot("test", 10, 30_000).then(() => {
      order.push("second");
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
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

  it("drainRateLimitQueues rejects all pending waiters", async () => {
    for (let i = 0; i < 10; i++) {
      await waitForRateLimitSlot("test", 10, 30_000);
    }

    const promise = waitForRateLimitSlot("test", 10, 30_000);
    drainRateLimitQueues();

    await expect(promise).rejects.toThrow("App is shutting down");
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
