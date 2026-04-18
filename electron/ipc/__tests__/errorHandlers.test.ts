import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PtyClient } from "../../services/PtyClient.js";
import type { SpawnErrorCode, SpawnResult } from "../../../shared/types/pty-host.js";

const sleepMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  openPath: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  getLogFilePath: vi.fn(() => "/tmp/daintree.log"),
  logError: vi.fn(),
}));

const storeMock = vi.hoisted(() => ({
  store: {
    get: vi.fn((): unknown[] => []),
    set: vi.fn(),
  },
}));

const allWindowsMock = vi.hoisted(() => vi.fn((): unknown[] => []));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  shell: shellMock,
  BrowserWindow: {
    getAllWindows: allWindowsMock,
  },
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: sleepMock,
}));

vi.mock("../../utils/logger.js", () => loggerMock);
vi.mock("../../store.js", () => storeMock);

function createTransientError(message: string): Error {
  const err = new Error(message);
  (err as NodeJS.ErrnoException).code = "EBUSY";
  return err;
}

function createNonTransientError(message: string): Error {
  const err = new Error(message);
  (err as NodeJS.ErrnoException).code = "ENOENT";
  return err;
}

type MockPtyClient = EventEmitter & { spawn: Mock };

function createPtyClientMock(spawn: Mock): MockPtyClient & PtyClient {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { spawn }) as unknown as MockPtyClient & PtyClient;
}

function emitSpawnSuccess(client: MockPtyClient, id: string): void {
  const result: SpawnResult = { success: true, id };
  client.emit("spawn-result", id, result);
}

function emitSpawnFailure(
  client: MockPtyClient,
  id: string,
  code: SpawnErrorCode,
  message: string
): void {
  const result: SpawnResult = {
    success: false,
    id,
    error: { code, message },
  };
  client.emit("spawn-result", id, result);
}

function createMockWindow(options: { destroyed?: boolean } = {}) {
  const win = {
    isDestroyed: () => options.destroyed ?? false,
    webContents: {
      isDestroyed: () => false,
      send: vi.fn(),
    },
  };
  allWindowsMock.mockReturnValue([win]);
  return win;
}

describe("errorHandlers", () => {
  let registerErrorHandlers: typeof import("../errorHandlers.js").registerErrorHandlers;
  let flushPendingErrors: typeof import("../errorHandlers.js").flushPendingErrors;

  beforeEach(async () => {
    vi.clearAllMocks();
    sleepMock.mockResolvedValue(undefined);
    shellMock.openPath.mockResolvedValue("");
    storeMock.store.get.mockReturnValue([]);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    // Reset modules to get a fresh ErrorService singleton per test
    vi.resetModules();
    const mod = await import("../errorHandlers.js");
    registerErrorHandlers = mod.registerErrorHandlers;
    flushPendingErrors = mod.flushPendingErrors;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
    const call = (ipcMainMock.handle as Mock).mock.calls.find(
      ([registered]: string[]) => registered === channel
    );
    if (!call) {
      throw new Error(`No handler registered for channel: ${channel}`);
    }
    return call[1] as (...args: unknown[]) => Promise<unknown>;
  }

  function getOnHandler(channel: string): (...args: unknown[]) => void {
    const call = (ipcMainMock.on as Mock).mock.calls.find(
      ([registered]: string[]) => registered === channel
    );
    if (!call) {
      throw new Error(`No on-handler registered for channel: ${channel}`);
    }
    return call[1] as (...args: unknown[]) => void;
  }

  // Re-import CHANNELS each time since we reset modules
  async function getChannels() {
    return (await import("../channels.js")).CHANNELS;
  }

  it("registers retry/cancel/open-log/get-pending handlers and removes them on cleanup", async () => {
    const CHANNELS = await getChannels();
    const cleanup = registerErrorHandlers(null, null);

    expect(ipcMainMock.handle).toHaveBeenCalledWith(CHANNELS.ERROR_RETRY, expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(CHANNELS.ERROR_OPEN_LOGS, expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      CHANNELS.ERROR_GET_PENDING,
      expect.any(Function)
    );
    expect(ipcMainMock.on).toHaveBeenCalledWith(CHANNELS.ERROR_RETRY_CANCEL, expect.any(Function));

    cleanup();

    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.ERROR_RETRY);
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.ERROR_OPEN_LOGS);
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.ERROR_GET_PENDING);
    expect(ipcMainMock.removeListener).toHaveBeenCalledWith(
      CHANNELS.ERROR_RETRY_CANCEL,
      expect.any(Function)
    );
  });

  it("retries terminal spawn with default cols/rows", async () => {
    const CHANNELS = await getChannels();
    const spawn = vi.fn();
    createMockWindow();
    const ptyClient = createPtyClientMock(spawn);
    spawn.mockImplementation((id: string) => emitSpawnSuccess(ptyClient, id));
    registerErrorHandlers(null, ptyClient);

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await retryHandler(
      {} as never,
      { errorId: "error-1", action: "terminal", args: { id: "term-1", cwd: "/tmp" } } as never
    );

    expect(spawn).toHaveBeenCalledWith("term-1", { cwd: "/tmp", cols: 80, rows: 30 });
    expect(ptyClient.listenerCount("spawn-result")).toBe(0);
  });

  it("sanitizes invalid terminal dimensions in retry args", async () => {
    const CHANNELS = await getChannels();
    const spawn = vi.fn();
    createMockWindow();
    const ptyClient = createPtyClientMock(spawn);
    spawn.mockImplementation((id: string) => emitSpawnSuccess(ptyClient, id));
    registerErrorHandlers(null, ptyClient);

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await retryHandler(
      {} as never,
      {
        errorId: "error-1b",
        action: "terminal",
        args: { id: "term-1b", cwd: "/tmp", cols: -25, rows: Number.NaN },
      } as never
    );

    expect(spawn).toHaveBeenCalledWith("term-1b", { cwd: "/tmp", cols: 80, rows: 30 });
  });

  it("rethrows original retry failure even when renderer webContents is unavailable", async () => {
    const CHANNELS = await getChannels();
    const expectedError = createNonTransientError("spawn failed");
    const spawn = vi.fn(() => {
      throw expectedError;
    });

    allWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } },
    ]);
    registerErrorHandlers(null, createPtyClientMock(spawn));

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await expect(
      retryHandler(
        {} as never,
        { errorId: "error-2", action: "terminal", args: { id: "term-2", cwd: "/tmp" } } as never
      )
    ).rejects.toThrow("spawn failed");
  });

  it("rejects malformed retry payload and reports it safely", async () => {
    const CHANNELS = await getChannels();
    const mockWindow = createMockWindow();
    registerErrorHandlers(null, createPtyClientMock(vi.fn()));

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await expect(retryHandler({} as never, undefined as never)).rejects.toThrow(
      "Invalid retry payload"
    );

    expect(mockWindow.webContents.send).toHaveBeenCalledWith(
      CHANNELS.ERROR_NOTIFY,
      expect.objectContaining({
        source: "retry-unknown",
        correlationId: expect.any(String),
      })
    );
  });

  it("generates a correlationId on every error and logs it", async () => {
    const CHANNELS = await getChannels();
    const mockWindow = createMockWindow();
    registerErrorHandlers(null, null);

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await retryHandler({} as never, undefined as never).catch(() => {});

    const sentError = mockWindow.webContents.send.mock.calls.find(
      ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
    )?.[1];
    expect(sentError).toBeDefined();
    expect(sentError.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    expect(loggerMock.logError).toHaveBeenCalledWith(
      expect.stringContaining(sentError.correlationId),
      expect.anything(),
      expect.objectContaining({ correlationId: sentError.correlationId })
    );
  });

  describe("exponential backoff and retry limits", () => {
    it("retries transient terminal errors up to 3 times with backoff", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      let callCount = 0;
      const spawn = vi.fn();
      const ptyClient = createPtyClientMock(spawn);
      spawn.mockImplementation((id: string) => {
        callCount++;
        if (callCount < 3) throw createTransientError("EBUSY");
        emitSpawnSuccess(ptyClient, id);
      });

      registerErrorHandlers(null, ptyClient);
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);

      await retryHandler(
        {} as never,
        { errorId: "e1", action: "terminal", args: { id: "t1", cwd: "/tmp" } } as never
      );

      expect(spawn).toHaveBeenCalledTimes(3);
      expect(sleepMock).toHaveBeenCalledTimes(2);
      // Verify sleep was called with signal
      expect(sleepMock.mock.calls[0][2]).toEqual({ signal: expect.any(AbortSignal) });
    });

    it("exhausts max terminal attempts (3) and rethrows", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      const spawn = vi.fn(() => {
        throw createTransientError("EBUSY");
      });

      registerErrorHandlers(null, createPtyClientMock(spawn));
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);

      await expect(
        retryHandler(
          {} as never,
          { errorId: "e2", action: "terminal", args: { id: "t2", cwd: "/tmp" } } as never
        )
      ).rejects.toThrow("EBUSY");

      expect(spawn).toHaveBeenCalledTimes(3);
      expect(sleepMock).toHaveBeenCalledTimes(2);
    });

    it("exhausts max worktree attempts (5) and rethrows", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      const refresh = vi.fn().mockRejectedValue(createTransientError("ETIMEDOUT"));

      registerErrorHandlers({ refresh } as never, null);
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);

      await expect(
        retryHandler({} as never, { errorId: "e3", action: "worktree" } as never)
      ).rejects.toThrow("ETIMEDOUT");

      expect(refresh).toHaveBeenCalledTimes(5);
      expect(sleepMock).toHaveBeenCalledTimes(4);
    });

    it("aborts immediately on non-transient error without sleeping", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      const spawn = vi.fn(() => {
        throw createNonTransientError("File not found");
      });

      registerErrorHandlers(null, createPtyClientMock(spawn));
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);

      await expect(
        retryHandler(
          {} as never,
          { errorId: "e4", action: "terminal", args: { id: "t4", cwd: "/tmp" } } as never
        )
      ).rejects.toThrow("File not found");

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(sleepMock).not.toHaveBeenCalled();
    });

    it("stops retrying when a transient error becomes non-transient mid-loop", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      let callCount = 0;
      const spawn = vi.fn(() => {
        callCount++;
        if (callCount === 1) throw createTransientError("EBUSY");
        throw createNonTransientError("ENOENT");
      });

      registerErrorHandlers(null, createPtyClientMock(spawn));
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);

      await expect(
        retryHandler(
          {} as never,
          { errorId: "e5", action: "terminal", args: { id: "t5", cwd: "/tmp" } } as never
        )
      ).rejects.toThrow("ENOENT");

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledTimes(1);
    });

    it("emits retry progress events for each attempt", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      let callCount = 0;
      const spawn = vi.fn();
      const ptyClient = createPtyClientMock(spawn);
      spawn.mockImplementation((id: string) => {
        callCount++;
        if (callCount < 3) throw createTransientError("EBUSY");
        emitSpawnSuccess(ptyClient, id);
      });

      registerErrorHandlers(null, ptyClient);
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);

      await retryHandler(
        {} as never,
        { errorId: "e6", action: "terminal", args: { id: "t6", cwd: "/tmp" } } as never
      );

      const progressCalls = mockWindow.webContents.send.mock.calls.filter(
        ([channel]: string[]) => channel === CHANNELS.ERROR_RETRY_PROGRESS
      );

      expect(progressCalls).toHaveLength(3);
      expect(progressCalls[0][1]).toEqual({ id: "e6", attempt: 1, maxAttempts: 3 });
      expect(progressCalls[1][1]).toEqual({ id: "e6", attempt: 2, maxAttempts: 3 });
      expect(progressCalls[2][1]).toEqual({ id: "e6", attempt: 3, maxAttempts: 3 });
    });

    it("does not send ERROR_NOTIFY on cancellation (AbortError)", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      const spawn = vi.fn(() => {
        throw createTransientError("EBUSY");
      });

      // Make sleep reject with AbortError on first call
      const abortError = new DOMException("The operation was aborted", "AbortError");
      sleepMock.mockRejectedValueOnce(abortError);

      registerErrorHandlers(null, createPtyClientMock(spawn));
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);

      await expect(
        retryHandler(
          {} as never,
          { errorId: "e7", action: "terminal", args: { id: "t7", cwd: "/tmp" } } as never
        )
      ).rejects.toThrow();

      // Should NOT have sent ERROR_NOTIFY (AbortError is suppressed)
      const notifyCalls = mockWindow.webContents.send.mock.calls.filter(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      );
      expect(notifyCalls).toHaveLength(0);
    });

    it("cancellation via cancel handler aborts in-progress retry", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      const spawn = vi.fn(() => {
        throw createTransientError("EBUSY");
      });

      // Make sleep trigger the cancel handler via the signal
      sleepMock.mockImplementation(
        async (_delay: number, _val: unknown, opts?: { signal?: AbortSignal }) => {
          if (opts?.signal) {
            // Simulate the cancel being called during sleep
            const cancelHandler = getOnHandler(CHANNELS.ERROR_RETRY_CANCEL);
            cancelHandler({} as never, "e8");
            // Now the signal should be aborted, throw AbortError
            opts.signal.throwIfAborted();
          }
        }
      );

      registerErrorHandlers(null, createPtyClientMock(spawn));
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);

      await expect(
        retryHandler(
          {} as never,
          { errorId: "e8", action: "terminal", args: { id: "t8", cwd: "/tmp" } } as never
        )
      ).rejects.toThrow();

      // Only one spawn attempt before the sleep/cancel
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("computes backoff delay with jitter correctly", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      const spawn = vi.fn(() => {
        throw createTransientError("EBUSY");
      });

      registerErrorHandlers(null, createPtyClientMock(spawn));
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);

      await retryHandler(
        {} as never,
        { errorId: "e9", action: "terminal", args: { id: "t9", cwd: "/tmp" } } as never
      ).catch(() => {});

      // Math.random returns 0.5, so delay = floor(0.5 * (ceil - 100 + 1) + 100)
      // Attempt 1: ceil = min(10000, 500 * 2^1) = 1000, delay = floor(0.5 * 901 + 100) = 550
      // Attempt 2: ceil = min(10000, 500 * 2^2) = 2000, delay = floor(0.5 * 1901 + 100) = 1050
      expect(sleepMock).toHaveBeenCalledTimes(2);
      expect(sleepMock.mock.calls[0][0]).toBe(550);
      expect(sleepMock.mock.calls[1][0]).toBe(1050);
    });
  });

  describe("terminal spawn-result event integration", () => {
    it("surfaces PENDING_SPAWNS_CAPPED synchronous failure as a retry error", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      const spawn = vi.fn();
      const ptyClient = createPtyClientMock(spawn);
      spawn.mockImplementation((id: string) => {
        emitSpawnFailure(ptyClient, id, "PENDING_SPAWNS_CAPPED", "Too many pending spawns");
      });
      registerErrorHandlers(null, ptyClient);

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      const thrown = await retryHandler(
        {} as never,
        {
          errorId: "cap-1",
          action: "terminal",
          args: { id: "t-cap", cwd: "/tmp" },
        } as never
      ).catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("Too many pending spawns");
      // Preserves result.error.code so handleRetry's transient-classifier sees it
      expect((thrown as NodeJS.ErrnoException).code).toBe("PENDING_SPAWNS_CAPPED");

      // Non-transient code → no backoff retry
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(sleepMock).not.toHaveBeenCalled();

      // Error surfaced to renderer via ERROR_NOTIFY
      const notifyCalls = mockWindow.webContents.send.mock.calls.filter(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      );
      expect(notifyCalls.length).toBeGreaterThan(0);
      expect(notifyCalls[0][1]).toMatchObject({
        message: expect.stringContaining("Too many pending spawns"),
      });

      // Listener cleaned up
      expect(ptyClient.listenerCount("spawn-result")).toBe(0);
    });

    it("resolves on async spawn-result success", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      const spawn = vi.fn();
      const ptyClient = createPtyClientMock(spawn);
      spawn.mockImplementation((id: string) => {
        // Async success after the listener is registered
        setImmediate(() => emitSpawnSuccess(ptyClient, id));
      });
      registerErrorHandlers(null, ptyClient);

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler(
        {} as never,
        { errorId: "ok-1", action: "terminal", args: { id: "t-ok", cwd: "/tmp" } } as never
      );

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(ptyClient.listenerCount("spawn-result")).toBe(0);
    });

    it("rejects on async spawn-result failure and preserves error code", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      const spawn = vi.fn();
      const ptyClient = createPtyClientMock(spawn);
      spawn.mockImplementation((id: string) => {
        setImmediate(() => emitSpawnFailure(ptyClient, id, "ENOENT", "shell not found"));
      });
      registerErrorHandlers(null, ptyClient);

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      const thrown = await retryHandler(
        {} as never,
        { errorId: "fail-1", action: "terminal", args: { id: "t-fail", cwd: "/tmp" } } as never
      ).catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("shell not found");
      expect((thrown as NodeJS.ErrnoException).code).toBe("ENOENT");

      expect(ptyClient.listenerCount("spawn-result")).toBe(0);
    });

    it("ignores spawn-result for a different terminal id", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      const spawn = vi.fn();
      const ptyClient = createPtyClientMock(spawn);
      let settleMatching: (() => void) | undefined;
      spawn.mockImplementation((id: string) => {
        // Emit for some other terminal first — must be ignored
        emitSpawnSuccess(ptyClient, "some-other-id");
        // Stash the matching emit so the test can trigger it on demand
        settleMatching = () => emitSpawnSuccess(ptyClient, id);
      });
      registerErrorHandlers(null, ptyClient);

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      const pending = retryHandler(
        {} as never,
        { errorId: "cross-1", action: "terminal", args: { id: "t-cross", cwd: "/tmp" } } as never
      );

      // Race pending against a tick-flushed sentinel — if the foreign event leaked
      // through, pending would already have resolved. Sentinel should win.
      const sentinel = Promise.resolve("still-pending");
      await expect(Promise.race([pending, sentinel])).resolves.toBe("still-pending");
      expect(ptyClient.listenerCount("spawn-result")).toBe(1);

      // Deliver the matching event — pending should now resolve
      settleMatching?.();
      await pending;

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(ptyClient.listenerCount("spawn-result")).toBe(0);
    });

    it("times out and cleans up listener when no spawn-result arrives", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      vi.useFakeTimers();
      try {
        const spawn = vi.fn(); // never emits anything
        const ptyClient = createPtyClientMock(spawn);
        registerErrorHandlers(null, ptyClient);

        const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
        const pending = retryHandler(
          {} as never,
          { errorId: "to-1", action: "terminal", args: { id: "t-to", cwd: "/tmp" } } as never
        );
        const assertion = expect(pending).rejects.toThrow(/did not complete/);

        // Advance past the 30s timeout
        await vi.advanceTimersByTimeAsync(30_001);
        await assertion;

        expect(ptyClient.listenerCount("spawn-result")).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleans up listener when spawn() throws synchronously", async () => {
      const CHANNELS = await getChannels();
      createMockWindow();
      const spawn = vi.fn(() => {
        throw createNonTransientError("kaboom");
      });
      const ptyClient = createPtyClientMock(spawn);
      registerErrorHandlers(null, ptyClient);

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await expect(
        retryHandler(
          {} as never,
          { errorId: "thr-1", action: "terminal", args: { id: "t-thr", cwd: "/tmp" } } as never
        )
      ).rejects.toThrow("kaboom");

      expect(ptyClient.listenerCount("spawn-result")).toBe(0);
    });
  });

  describe("error buffering", () => {
    it("buffers errors when window is destroyed instead of sending", async () => {
      const CHANNELS = await getChannels();
      const destroyedWindow = createMockWindow({ destroyed: true });
      registerErrorHandlers(null, null);

      // Trigger an error via the retry handler with invalid payload
      // This causes notifyError -> sendError -> bufferError
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});

      // Error was NOT sent to the destroyed window
      expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();

      // Now re-initialize with a good window and flush
      const goodWindow = createMockWindow();
      registerErrorHandlers(null, null);
      flushPendingErrors();

      // Buffered error should now be delivered
      expect(goodWindow.webContents.send).toHaveBeenCalledWith(
        CHANNELS.ERROR_NOTIFY,
        expect.objectContaining({
          message: expect.any(String),
          type: expect.any(String),
        })
      );
    });

    it("persists critical config/filesystem errors to disk when window unavailable", async () => {
      const CHANNELS = await getChannels();

      // Import error types to create typed errors
      const { ConfigError } = await import("../../utils/errorTypes.js");
      createMockWindow({ destroyed: true });
      registerErrorHandlers(null, null);

      // Trigger a retry that uses a ptyClient spawn which throws a ConfigError
      const spawn = vi.fn(() => {
        throw new ConfigError("Bad config", { key: "config-key" });
      });
      // Re-register with spawn
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      // Critical error should be persisted to store
      expect(storeMock.store.set).toHaveBeenCalledWith(
        "pendingErrors",
        expect.arrayContaining([
          expect.objectContaining({
            type: "config",
          }),
        ])
      );
    });

    it("preserves correlationId through buffer and flush", async () => {
      const CHANNELS = await getChannels();
      createMockWindow({ destroyed: true });
      registerErrorHandlers(null, null);

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});

      const goodWindow = createMockWindow();
      registerErrorHandlers(null, null);
      flushPendingErrors();

      const sentError = goodWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("does not persist transient or non-critical errors to disk", async () => {
      const CHANNELS = await getChannels();
      createMockWindow({ destroyed: true });
      registerErrorHandlers(null, null);

      // Trigger an error (invalid retry payload creates an "unknown" type error)
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});

      // Should NOT have persisted (unknown type is not critical)
      expect(storeMock.store.set).not.toHaveBeenCalledWith("pendingErrors", expect.anything());
    });
  });

  describe("flushPendingErrors", () => {
    it("delivers buffered errors and clears persisted store on flush", async () => {
      const CHANNELS = await getChannels();
      createMockWindow({ destroyed: true });
      registerErrorHandlers(null, null);

      // Buffer some errors
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});
      await retryHandler({} as never, null as never).catch(() => {});

      storeMock.store.set.mockClear();

      // Re-initialize with good window and flush
      const goodWindow = createMockWindow();
      registerErrorHandlers(null, null);
      flushPendingErrors();

      // Errors delivered
      expect(goodWindow.webContents.send).toHaveBeenCalledWith(
        CHANNELS.ERROR_NOTIFY,
        expect.objectContaining({ type: expect.any(String) })
      );

      // Persisted errors cleared
      expect(storeMock.store.set).toHaveBeenCalledWith("pendingErrors", []);
    });

    it("is a no-op when buffer is empty", () => {
      const goodWindow = createMockWindow();
      registerErrorHandlers(null, null);

      flushPendingErrors();

      // Nothing sent since buffer was empty
      expect(goodWindow.webContents.send).not.toHaveBeenCalled();
    });

    it("prevents double delivery after flush", async () => {
      const CHANNELS = await getChannels();
      createMockWindow({ destroyed: true });
      registerErrorHandlers(null, null);

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});

      const goodWindow = createMockWindow();
      registerErrorHandlers(null, null);

      // First flush delivers
      flushPendingErrors();
      const firstCallCount = goodWindow.webContents.send.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      // Second flush is a no-op
      flushPendingErrors();
      expect(goodWindow.webContents.send.mock.calls.length).toBe(firstCallCount);
    });
  });

  describe("recoveryHint via createAppError", () => {
    it("returns permissions hint for EACCES with file syscall", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        err.syscall = "open";
        throw err;
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("permissions");
    });

    it("returns executable hint for EACCES with spawn syscall", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        err.syscall = "spawn git";
        throw err;
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("executable");
    });

    it("returns PATH hint for ENOENT with spawn syscall", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        err.syscall = "spawn npm";
        throw err;
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("PATH");
    });

    it("returns file path hint for ENOENT without spawn", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        err.syscall = "open";
        throw err;
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("file path");
    });

    it("returns PATH hint for posix_spawnp message", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        throw new Error("posix_spawnp: No such file or directory");
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("PATH");
    });

    it("returns DNS hint for ENOTFOUND", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        const err = new Error("getaddrinfo ENOTFOUND") as NodeJS.ErrnoException;
        err.code = "ENOTFOUND";
        throw err;
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("DNS");
    });

    it("returns server hint for ECONNREFUSED", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
        err.code = "ECONNREFUSED";
        throw err;
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("server");
    });

    it("returns network hint for ETIMEDOUT", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        const err = new Error("connect ETIMEDOUT") as NodeJS.ErrnoException;
        err.code = "ETIMEDOUT";
        throw err;
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("network");
    });

    it("returns git init hint for GitError with 'not a git repository'", async () => {
      const CHANNELS = await getChannels();
      const { GitError } = await import("../../utils/errorTypes.js");
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        throw new GitError("fatal: not a git repository");
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("git init");
    });

    it("returns credentials hint for GitError with 'Authentication failed'", async () => {
      const CHANNELS = await getChannels();
      const { GitError } = await import("../../utils/errorTypes.js");
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        throw new GitError("Authentication failed for repo");
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("credentials");
    });

    it("returns config hint for ConfigError", async () => {
      const CHANNELS = await getChannels();
      const { ConfigError } = await import("../../utils/errorTypes.js");
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        throw new ConfigError("bad config");
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("corrupted");
    });

    it("returns terminal hint for ProcessError", async () => {
      const CHANNELS = await getChannels();
      const { ProcessError } = await import("../../utils/errorTypes.js");
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        throw new ProcessError("pty failed");
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("terminal process");
    });

    it("returns git init hint when cause message contains 'not a git repository'", async () => {
      const CHANNELS = await getChannels();
      const { GitError } = await import("../../utils/errorTypes.js");
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        throw new GitError(
          "Git operation failed: status",
          { rootPath: "/tmp" },
          new Error("fatal: not a git repository (or any parent up to mount point /)")
        );
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("git init");
    });

    it("returns undefined for GitError with unrecognized message", async () => {
      const CHANNELS = await getChannels();
      const { GitError } = await import("../../utils/errorTypes.js");
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        throw new GitError("Git operation failed: merge");
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toBeUndefined();
    });

    it("returns reset hint for ECONNRESET", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        const err = new Error("read ECONNRESET") as NodeJS.ErrnoException;
        err.code = "ECONNRESET";
        throw err;
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("reset");
    });

    it("returns busy hint for EBUSY", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        const err = new Error("EBUSY: resource busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("Close");
    });

    it("returns system busy hint for EAGAIN", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const spawn = vi.fn(() => {
        const err = new Error("EAGAIN") as NodeJS.ErrnoException;
        err.code = "EAGAIN";
        throw err;
      });
      registerErrorHandlers(null, createPtyClientMock(spawn));

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, {
        errorId: "e",
        action: "terminal",
        args: { id: "t", cwd: "/" },
      }).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toContain("busy");
    });

    it("returns undefined recoveryHint for generic unknown error", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(null, null);

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});

      const sentError = mockWindow.webContents.send.mock.calls.find(
        ([channel]: string[]) => channel === CHANNELS.ERROR_NOTIFY
      )?.[1];
      expect(sentError.recoveryHint).toBeUndefined();
    });
  });

  describe("getPendingPersistedErrors", () => {
    it("returns persisted errors with fromPreviousSession flag and preserves correlationId", async () => {
      const CHANNELS = await getChannels();
      const persistedErrors = [
        {
          id: "error-prev-1",
          timestamp: Date.now() - 60000,
          type: "config" as const,
          message: "Config error from last session",
          isTransient: false,
          dismissed: false,
          correlationId: "aabbccdd-1111-2222-3333-444455556666",
        },
      ];
      storeMock.store.get.mockReturnValue(persistedErrors);

      registerErrorHandlers(null, null);
      const handler = getInvokeHandler(CHANNELS.ERROR_GET_PENDING);
      const result = handler({} as never);

      expect(result).toEqual([
        expect.objectContaining({
          id: "error-prev-1",
          message: "Config error from last session",
          fromPreviousSession: true,
          correlationId: "aabbccdd-1111-2222-3333-444455556666",
        }),
      ]);
    });

    it("clears persisted errors after retrieval", async () => {
      const CHANNELS = await getChannels();
      storeMock.store.get.mockReturnValue([
        {
          id: "error-1",
          timestamp: Date.now(),
          type: "filesystem",
          message: "test",
          isTransient: false,
          dismissed: false,
        },
      ]);

      registerErrorHandlers(null, null);
      const handler = getInvokeHandler(CHANNELS.ERROR_GET_PENDING);
      handler({} as never);

      expect(storeMock.store.set).toHaveBeenCalledWith("pendingErrors", []);
    });

    it("returns empty array when no persisted errors", async () => {
      const CHANNELS = await getChannels();
      storeMock.store.get.mockReturnValue([]);

      registerErrorHandlers(null, null);
      const handler = getInvokeHandler(CHANNELS.ERROR_GET_PENDING);
      const result = handler({} as never);

      expect(result).toEqual([]);
    });

    it("handles undefined store value gracefully", async () => {
      const CHANNELS = await getChannels();
      storeMock.store.get.mockReturnValue(undefined as unknown as unknown[]);

      registerErrorHandlers(null, null);
      const handler = getInvokeHandler(CHANNELS.ERROR_GET_PENDING);
      const result = handler({} as never);

      expect(result).toEqual([]);
    });

    it("does not return fromPreviousSession on same-session flushed errors", async () => {
      const CHANNELS = await getChannels();
      createMockWindow({ destroyed: true });
      registerErrorHandlers(null, null);

      // Buffer an error
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});

      // Flush to a good window
      const goodWindow = createMockWindow();
      registerErrorHandlers(null, null);
      flushPendingErrors();

      // Same-session flushed errors should NOT have fromPreviousSession
      const sentErrors = goodWindow.webContents.send.mock.calls
        .filter(([channel]) => channel === CHANNELS.ERROR_NOTIFY)
        .map(([, error]) => error);

      for (const error of sentErrors) {
        expect(error.fromPreviousSession).toBeUndefined();
      }
    });
  });
});
