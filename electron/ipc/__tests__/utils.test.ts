import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const browserWindowFromWebContentsMock = vi.hoisted(() => vi.fn());
const browserWindowGetAllWindowsMock = vi.hoisted(() => vi.fn(() => [] as unknown[]));
const isCachedViewWebContentsMock = vi.hoisted(() => vi.fn((_id: number) => false));
const getWebContentsForProjectMock = vi.hoisted(() => vi.fn((_projectId: string) => [] as never[]));
const hasRegisteredProjectViewsMock = vi.hoisted(() => vi.fn(() => false));
const getProjectForWebContentsMock = vi.hoisted(() =>
  vi.fn<(id: number) => string | null>(() => null)
);
const getProjectViewManagerMock = vi.hoisted(() => vi.fn<() => unknown>(() => null));
const isPerformanceCaptureEnabledMock = vi.hoisted(() => vi.fn<() => boolean>(() => false));

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
  isCachedViewWebContents: isCachedViewWebContentsMock,
  getWebContentsForProject: getWebContentsForProjectMock,
  hasRegisteredProjectViews: hasRegisteredProjectViewsMock,
  getProjectForWebContents: getProjectForWebContentsMock,
}));

// Kept as an adversarial fixture: the multi-window suite below points this at
// a manager that only knows the last-created window, so any regression back to
// resolving `ctx.projectId` through the process-global manager fails loudly.
vi.mock("../../window/windowRef.js", () => ({
  getProjectViewManager: getProjectViewManagerMock,
}));

vi.mock("../../utils/performance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/performance.js")>();
  return {
    ...actual,
    isPerformanceCaptureEnabled: isPerformanceCaptureEnabledMock,
    markPerformance: vi.fn(),
    sampleIpcTiming: vi.fn(),
  };
});

import {
  sendToRenderer,
  broadcastToRenderer,
  broadcastToProjectRenderers,
  broadcastToVisibleRenderers,
  sendToRendererContext,
  typedHandle,
  typedHandleWithContext,
  typedSend,
  checkRateLimit,
  waitForRateLimitSlot,
  waitForBurstRateLimitSlot,
  drainRateLimitQueues,
  armRestoreQuota,
  consumeRestoreQuota,
  _resetRateLimitQueuesForTest,
} from "../utils.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../ipcGuard.js";

describe("ipc utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
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

  it("typedHandle throws when invoked before enforceIpcSenderValidation", () => {
    _resetIpcGuardForTesting();
    expect(() => typedHandle("project:get:all" as never, (async () => ({})) as never)).toThrow(
      /'project:get:all'/
    );
    expect(ipcMainMock.handle).not.toHaveBeenCalled();
  });

  it("typedHandleWithContext throws when invoked before enforceIpcSenderValidation", () => {
    _resetIpcGuardForTesting();
    expect(() =>
      typedHandleWithContext("project:get:all" as never, (async () => ({})) as never)
    ).toThrow(/'project:get:all'/);
    expect(ipcMainMock.handle).not.toHaveBeenCalled();
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

describe("broadcastToVisibleRenderers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isCachedViewWebContentsMock.mockImplementation(() => false);
  });

  it("skips cached webContents and sends to visible ones", () => {
    const sendVisible = vi.fn();
    const sendCached = vi.fn();
    const visible = {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send: sendVisible },
    };
    const cached = {
      isDestroyed: () => false,
      webContents: { id: 2, isDestroyed: () => false, send: sendCached },
    };
    browserWindowGetAllWindowsMock.mockReturnValue([visible, cached]);
    isCachedViewWebContentsMock.mockImplementation((id: number) => id === 2);

    broadcastToVisibleRenderers("logs:batch", [{ level: "info" }]);

    expect(sendVisible).toHaveBeenCalledWith("logs:batch", [{ level: "info" }]);
    expect(sendCached).not.toHaveBeenCalled();
  });

  it("resumes sending once the webContents is no longer cached", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { id: 3, isDestroyed: () => false, send },
    };
    browserWindowGetAllWindowsMock.mockReturnValue([win]);

    isCachedViewWebContentsMock.mockImplementation(() => true);
    broadcastToVisibleRenderers("logs:batch");
    expect(send).not.toHaveBeenCalled();

    isCachedViewWebContentsMock.mockImplementation(() => false);
    broadcastToVisibleRenderers("logs:batch");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("broadcastToRenderer ignores the cached mark — state broadcasts reach cached views", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { id: 4, isDestroyed: () => false, send },
    };
    browserWindowGetAllWindowsMock.mockReturnValue([win]);
    isCachedViewWebContentsMock.mockImplementation(() => true);

    broadcastToRenderer("project:updated", { id: "p1" });
    expect(send).toHaveBeenCalledWith("project:updated", { id: "p1" });
  });

  it("does not throw when webContents.send throws", () => {
    const send1 = vi.fn(() => {
      throw new Error("send failed");
    });
    const send2 = vi.fn();
    const win1 = {
      isDestroyed: () => false,
      webContents: { id: 6, isDestroyed: () => false, send: send1 },
    };
    const win2 = {
      isDestroyed: () => false,
      webContents: { id: 7, isDestroyed: () => false, send: send2 },
    };
    browserWindowGetAllWindowsMock.mockReturnValue([win1, win2]);

    expect(() => broadcastToVisibleRenderers("logs:batch")).not.toThrow();
    expect(send2).toHaveBeenCalledWith("logs:batch");
  });
});

describe("broadcastToProjectRenderers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasRegisteredProjectViewsMock.mockReturnValue(false);
    getWebContentsForProjectMock.mockReturnValue([]);
  });

  it("sends only to the owning project's views when registered", () => {
    const sendOwn = vi.fn();
    const sendOther = vi.fn();
    hasRegisteredProjectViewsMock.mockReturnValue(true);
    getWebContentsForProjectMock.mockImplementation((projectId: string) =>
      projectId === "p1" ? ([{ send: sendOwn }] as never[]) : ([] as never[])
    );
    // A full broadcast would reach this window — it must NOT be used here.
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: sendOther } },
    ]);

    broadcastToProjectRenderers("p1", "terminal:status", { id: "t1" });

    expect(sendOwn).toHaveBeenCalledWith("terminal:status", { id: "t1" });
    expect(sendOther).not.toHaveBeenCalled();
  });

  it("drops the event when project views exist but none host the project", () => {
    const sendOther = vi.fn();
    hasRegisteredProjectViewsMock.mockReturnValue(true);
    getWebContentsForProjectMock.mockReturnValue([]);
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: sendOther } },
    ]);

    broadcastToProjectRenderers("closed-project", "terminal:status", { id: "t1" });

    expect(sendOther).not.toHaveBeenCalled();
  });

  it("falls back to a full broadcast when the project is unknown", () => {
    const send = vi.fn();
    hasRegisteredProjectViewsMock.mockReturnValue(true);
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
    ]);

    broadcastToProjectRenderers(null, "terminal:status", { id: "t1" });

    expect(send).toHaveBeenCalledWith("terminal:status", { id: "t1" });
  });

  it("falls back to a full broadcast when no project views are registered", () => {
    const send = vi.fn();
    hasRegisteredProjectViewsMock.mockReturnValue(false);
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
    ]);

    broadcastToProjectRenderers("p1", "terminal:status", { id: "t1" });

    expect(send).toHaveBeenCalledWith("terminal:status", { id: "t1" });
  });

  it("does not throw when a scoped webContents.send throws", () => {
    const send1 = vi.fn(() => {
      throw new Error("send failed");
    });
    const send2 = vi.fn();
    hasRegisteredProjectViewsMock.mockReturnValue(true);
    getWebContentsForProjectMock.mockReturnValue([{ send: send1 }, { send: send2 }] as never[]);

    expect(() => broadcastToProjectRenderers("p1", "terminal:status")).not.toThrow();
    expect(send2).toHaveBeenCalledWith("terminal:status");
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

describe("waitForBurstRateLimitSlot (token bucket)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetRateLimitQueuesForTest();
  });

  afterEach(() => {
    _resetRateLimitQueuesForTest();
    vi.useRealTimers();
  });

  it("releases up to the burst allowance instantly, then spaces at the interval", async () => {
    const INTERVAL = 1_000;
    const BURST = 6;
    const resolvedAt: number[] = [];
    const start = Date.now();

    const promises = Array.from({ length: BURST + 2 }, (_, i) =>
      waitForBurstRateLimitSlot("tb-burst", INTERVAL, BURST).then(() => {
        resolvedAt.push(Date.now() - start);
        return i;
      })
    );

    await vi.advanceTimersByTimeAsync(0);
    // Exactly the burst allowance passes with zero wait — not one more.
    expect(resolvedAt).toEqual(Array.from({ length: BURST }, () => 0));

    // Callers beyond the burst drain at the leaky-bucket cadence.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resolvedAt).toEqual([...Array.from({ length: BURST }, () => 0), INTERVAL]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resolvedAt).toEqual([...Array.from({ length: BURST }, () => 0), INTERVAL, 2 * INTERVAL]);

    await Promise.all(promises);
  });

  it("re-banks burst capacity while idle instead of releasing more than the burst", async () => {
    const INTERVAL = 1_000;
    const BURST = 3;

    // Exhaust the burst.
    for (let i = 0; i < BURST; i++) {
      await waitForBurstRateLimitSlot("tb-refill", INTERVAL, BURST);
    }

    // One interval of idle re-banks exactly one slot.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    const afterRefill = Date.now();
    await waitForBurstRateLimitSlot("tb-refill", INTERVAL, BURST);
    expect(Date.now()).toBe(afterRefill);

    // The very next caller has no banked slot and must wait a full interval.
    const resolved: number[] = [];
    const p = waitForBurstRateLimitSlot("tb-refill", INTERVAL, BURST).then(() => {
      resolved.push(Date.now() - afterRefill);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toEqual([]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resolved).toEqual([INTERVAL]);
    await p;
  });

  it("burst of 1 behaves exactly like the plain leaky bucket", async () => {
    const INTERVAL = 2_000;
    await waitForBurstRateLimitSlot("tb-one", INTERVAL, 1);

    const resolved: number[] = [];
    const start = Date.now();
    const p = waitForBurstRateLimitSlot("tb-one", INTERVAL, 1).then(() => {
      resolved.push(Date.now() - start);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toEqual([]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resolved).toEqual([INTERVAL]);
    await p;
  });

  it("rejects pending callers past MAX_QUEUE_DEPTH like the leaky bucket", async () => {
    const INTERVAL = 1_000;
    const BURST = 2;
    const pending: Promise<void>[] = [];
    // Burst passes instantly (no pending count) …
    for (let i = 0; i < BURST; i++) {
      await waitForBurstRateLimitSlot("tb-overflow", INTERVAL, BURST);
    }
    // … then 50 waiting callers fill the queue.
    for (let i = 0; i < 50; i++) {
      pending.push(waitForBurstRateLimitSlot("tb-overflow", INTERVAL, BURST));
    }
    await expect(waitForBurstRateLimitSlot("tb-overflow", INTERVAL, BURST)).rejects.toThrow(
      "Spawn queue full"
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(pending);
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

// #11100: `ctx.projectId` used to be resolved through the process-global
// ProjectViewManager, which every new window overwrites. Each manager only
// knows its own window's views, so every window except the last-created one
// resolved to null. These specs pin sender identity — not global state — as
// the authority.
describe("typedHandleWithContext multi-window project resolution", () => {
  const WINDOW_A = { id: 1 };
  const WINDOW_B = { id: 2 };
  const SENDER_A = 101;
  const SENDER_B = 202;

  // The registry map spans every window; the manager map does not. Model both
  // so a regression to the manager can be observed rather than assumed.
  let viewToProject: Map<number, string>;

  function invokeFrom(
    registered: (...args: unknown[]) => unknown,
    senderId: number
  ): Promise<unknown> {
    return Promise.resolve(registered({ sender: { id: senderId } }));
  }

  function lastRegisteredHandler(): (...args: unknown[]) => unknown {
    const calls = ipcMainMock.handle.mock.calls as [string, (...args: unknown[]) => unknown][];
    return calls[calls.length - 1][1];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();

    viewToProject = new Map([
      [SENDER_A, "project-a"],
      [SENDER_B, "project-b"],
    ]);
    getProjectForWebContentsMock.mockImplementation((id) => viewToProject.get(id) ?? null);
    browserWindowFromWebContentsMock.mockImplementation((wc: { id: number }) =>
      wc.id === SENDER_A ? WINDOW_A : WINDOW_B
    );

    // The process-global manager points at window B — the last window created.
    // It has never heard of window A's view, which is exactly why the old
    // lookup returned null for it.
    getProjectViewManagerMock.mockReturnValue({
      getProjectIdForWebContents: (id: number) => (id === SENDER_B ? "project-b" : null),
    });
    isPerformanceCaptureEnabledMock.mockReturnValue(false);
  });

  it.each([
    ["capture disabled", false],
    ["capture enabled", true],
  ])(
    "each window resolves its own project while the global manager knows only the newest (%s)",
    async (_label, captureEnabled) => {
      isPerformanceCaptureEnabledMock.mockReturnValue(captureEnabled);

      const seen: { projectId: string | null; webContentsId: number }[] = [];
      const handler = vi.fn((ctx: { projectId: string | null; webContentsId: number }) => {
        seen.push({ projectId: ctx.projectId, webContentsId: ctx.webContentsId });
        return { ok: true };
      });
      typedHandleWithContext("project:get:all" as never, handler as never);
      const registered = lastRegisteredHandler();

      await invokeFrom(registered, SENDER_A);
      await invokeFrom(registered, SENDER_B);

      expect(seen).toEqual([
        { projectId: "project-a", webContentsId: SENDER_A },
        { projectId: "project-b", webContentsId: SENDER_B },
      ]);
    }
  );

  it("resolution does not depend on which manager the global slot holds", async () => {
    const handler = vi.fn((ctx: { projectId: string | null }) => ({ projectId: ctx.projectId }));
    typedHandleWithContext("project:get:all" as never, handler as never);
    const registered = lastRegisteredHandler();

    const before = await invokeFrom(registered, SENDER_A);

    // Focus/creation churn flips the global slot; sender A must be unmoved.
    getProjectViewManagerMock.mockReturnValue({
      getProjectIdForWebContents: (id: number) => (id === SENDER_A ? "project-a" : null),
    });
    const afterFlip = await invokeFrom(registered, SENDER_A);

    getProjectViewManagerMock.mockReturnValue(null);
    const afterClear = await invokeFrom(registered, SENDER_A);

    expect(before).toEqual({ projectId: "project-a" });
    expect(afterFlip).toEqual(before);
    expect(afterClear).toEqual(before);
  });

  it("closing window B leaves window A's context intact", async () => {
    const handler = vi.fn((ctx: { projectId: string | null }) => ({ projectId: ctx.projectId }));
    typedHandleWithContext("project:get:all" as never, handler as never);
    const registered = lastRegisteredHandler();

    // Window B closes: its view is unregistered (id-scoped) and main.ts nulls
    // the global manager slot. Window A is untouched by both.
    viewToProject.delete(SENDER_B);
    getProjectViewManagerMock.mockReturnValue(null);

    await expect(invokeFrom(registered, SENDER_A)).resolves.toEqual({ projectId: "project-a" });
    await expect(invokeFrom(registered, SENDER_B)).resolves.toEqual({ projectId: null });
  });

  it("an unbound window with no registered view resolves a null project", async () => {
    const handler = vi.fn((ctx: { projectId: string | null }) => ({ projectId: ctx.projectId }));
    typedHandleWithContext("project:get:all" as never, handler as never);
    const registered = lastRegisteredHandler();

    // Cmd+N windows sit on the project picker and are deliberately never
    // registered as project views. Null means "unknown", not "unauthorized" —
    // handlers that fail closed on it break these windows.
    const UNBOUND_SENDER = 303;
    await expect(invokeFrom(registered, UNBOUND_SENDER)).resolves.toEqual({ projectId: null });
  });
});
