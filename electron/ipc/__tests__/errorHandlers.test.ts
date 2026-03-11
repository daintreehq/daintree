import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  openPath: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  getLogFilePath: vi.fn(() => "/tmp/canopy.log"),
}));

const storeMock = vi.hoisted(() => ({
  store: {
    get: vi.fn((): unknown[] => []),
    set: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  shell: shellMock,
  BrowserWindow: class {},
}));

vi.mock("../../utils/logger.js", () => loggerMock);
vi.mock("../../store.js", () => storeMock);

function createMockWindow(options: { destroyed?: boolean } = {}) {
  return {
    isDestroyed: () => options.destroyed ?? false,
    webContents: {
      isDestroyed: () => false,
      send: vi.fn(),
    },
  };
}

describe("errorHandlers", () => {
  let registerErrorHandlers: typeof import("../errorHandlers.js").registerErrorHandlers;
  let flushPendingErrors: typeof import("../errorHandlers.js").flushPendingErrors;

  beforeEach(async () => {
    vi.clearAllMocks();
    shellMock.openPath.mockResolvedValue("");
    storeMock.store.get.mockReturnValue([]);

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

  // Re-import CHANNELS each time since we reset modules
  async function getChannels() {
    return (await import("../channels.js")).CHANNELS;
  }

  it("registers retry/open-log/get-pending handlers and removes them on cleanup", async () => {
    const CHANNELS = await getChannels();
    const cleanup = registerErrorHandlers(createMockWindow() as never, null, null);

    expect(ipcMainMock.handle).toHaveBeenCalledWith(CHANNELS.ERROR_RETRY, expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(CHANNELS.ERROR_OPEN_LOGS, expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      CHANNELS.ERROR_GET_PENDING,
      expect.any(Function)
    );

    cleanup();

    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.ERROR_RETRY);
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.ERROR_OPEN_LOGS);
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.ERROR_GET_PENDING);
  });

  it("retries terminal spawn with default cols/rows", async () => {
    const CHANNELS = await getChannels();
    const spawn = vi.fn();
    registerErrorHandlers(createMockWindow() as never, null, { spawn } as never);

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await retryHandler(
      {} as never,
      { errorId: "error-1", action: "terminal", args: { id: "term-1", cwd: "/tmp" } } as never
    );

    expect(spawn).toHaveBeenCalledWith("term-1", { cwd: "/tmp", cols: 80, rows: 30 });
  });

  it("sanitizes invalid terminal dimensions in retry args", async () => {
    const CHANNELS = await getChannels();
    const spawn = vi.fn();
    registerErrorHandlers(createMockWindow() as never, null, { spawn } as never);

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
    const expectedError = new Error("spawn failed");
    const spawn = vi.fn(() => {
      throw expectedError;
    });

    registerErrorHandlers(
      {
        isDestroyed: () => false,
      } as never,
      null,
      { spawn } as never
    );

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
    registerErrorHandlers(mockWindow as never, null, { spawn: vi.fn() } as never);

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await expect(retryHandler({} as never, undefined as never)).rejects.toThrow(
      "Invalid retry payload"
    );

    expect(mockWindow.webContents.send).toHaveBeenCalledWith(
      CHANNELS.ERROR_NOTIFY,
      expect.objectContaining({
        source: "retry-unknown",
      })
    );
  });

  describe("error buffering", () => {
    it("buffers errors when window is destroyed instead of sending", async () => {
      const CHANNELS = await getChannels();
      const destroyedWindow = createMockWindow({ destroyed: true });
      registerErrorHandlers(destroyedWindow as never, null, null);

      // Trigger an error via the retry handler with invalid payload
      // This causes notifyError -> sendError -> bufferError
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});

      // Error was NOT sent to the destroyed window
      expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();

      // Now re-initialize with a good window and flush
      const goodWindow = createMockWindow();
      registerErrorHandlers(goodWindow as never, null, null);
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
      const destroyedWindow = createMockWindow({ destroyed: true });
      registerErrorHandlers(destroyedWindow as never, null, null);

      // Trigger a retry that uses a ptyClient spawn which throws a ConfigError
      const spawn = vi.fn(() => {
        throw new ConfigError("Bad config", { key: "config-key" });
      });
      // Re-register with spawn
      registerErrorHandlers(destroyedWindow as never, null, { spawn } as never);

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

    it("does not persist transient or non-critical errors to disk", async () => {
      const CHANNELS = await getChannels();
      const destroyedWindow = createMockWindow({ destroyed: true });
      registerErrorHandlers(destroyedWindow as never, null, null);

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
      const destroyedWindow = createMockWindow({ destroyed: true });
      registerErrorHandlers(destroyedWindow as never, null, null);

      // Buffer some errors
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});
      await retryHandler({} as never, null as never).catch(() => {});

      storeMock.store.set.mockClear();

      // Re-initialize with good window and flush
      const goodWindow = createMockWindow();
      registerErrorHandlers(goodWindow as never, null, null);
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
      registerErrorHandlers(goodWindow as never, null, null);

      flushPendingErrors();

      // Nothing sent since buffer was empty
      expect(goodWindow.webContents.send).not.toHaveBeenCalled();
    });

    it("prevents double delivery after flush", async () => {
      const CHANNELS = await getChannels();
      const destroyedWindow = createMockWindow({ destroyed: true });
      registerErrorHandlers(destroyedWindow as never, null, null);

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});

      const goodWindow = createMockWindow();
      registerErrorHandlers(goodWindow as never, null, null);

      // First flush delivers
      flushPendingErrors();
      const firstCallCount = goodWindow.webContents.send.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      // Second flush is a no-op
      flushPendingErrors();
      expect(goodWindow.webContents.send.mock.calls.length).toBe(firstCallCount);
    });
  });

  describe("getPendingPersistedErrors", () => {
    it("returns persisted errors with fromPreviousSession flag", async () => {
      const CHANNELS = await getChannels();
      const persistedErrors = [
        {
          id: "error-prev-1",
          timestamp: Date.now() - 60000,
          type: "config" as const,
          message: "Config error from last session",
          isTransient: false,
          dismissed: false,
        },
      ];
      storeMock.store.get.mockReturnValue(persistedErrors);

      registerErrorHandlers(createMockWindow() as never, null, null);
      const handler = getInvokeHandler(CHANNELS.ERROR_GET_PENDING);
      const result = handler({} as never);

      expect(result).toEqual([
        expect.objectContaining({
          id: "error-prev-1",
          message: "Config error from last session",
          fromPreviousSession: true,
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

      registerErrorHandlers(createMockWindow() as never, null, null);
      const handler = getInvokeHandler(CHANNELS.ERROR_GET_PENDING);
      handler({} as never);

      expect(storeMock.store.set).toHaveBeenCalledWith("pendingErrors", []);
    });

    it("returns empty array when no persisted errors", async () => {
      const CHANNELS = await getChannels();
      storeMock.store.get.mockReturnValue([]);

      registerErrorHandlers(createMockWindow() as never, null, null);
      const handler = getInvokeHandler(CHANNELS.ERROR_GET_PENDING);
      const result = handler({} as never);

      expect(result).toEqual([]);
    });

    it("handles undefined store value gracefully", async () => {
      const CHANNELS = await getChannels();
      storeMock.store.get.mockReturnValue(undefined as unknown as unknown[]);

      registerErrorHandlers(createMockWindow() as never, null, null);
      const handler = getInvokeHandler(CHANNELS.ERROR_GET_PENDING);
      const result = handler({} as never);

      expect(result).toEqual([]);
    });

    it("does not return fromPreviousSession on same-session flushed errors", async () => {
      const CHANNELS = await getChannels();
      const destroyedWindow = createMockWindow({ destroyed: true });
      registerErrorHandlers(destroyedWindow as never, null, null);

      // Buffer an error
      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});

      // Flush to a good window
      const goodWindow = createMockWindow();
      registerErrorHandlers(goodWindow as never, null, null);
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
