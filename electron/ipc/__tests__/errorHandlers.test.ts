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
  logError: vi.fn(),
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
        correlationId: expect.any(String),
      })
    );
  });

  it("generates a correlationId on every error and logs it", async () => {
    const CHANNELS = await getChannels();
    const mockWindow = createMockWindow();
    registerErrorHandlers(mockWindow as never, null, null);

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

    it("preserves correlationId through buffer and flush", async () => {
      const CHANNELS = await getChannels();
      const destroyedWindow = createMockWindow({ destroyed: true });
      registerErrorHandlers(destroyedWindow as never, null, null);

      const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
      await retryHandler({} as never, undefined as never).catch(() => {});

      const goodWindow = createMockWindow();
      registerErrorHandlers(goodWindow as never, null, null);
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

  describe("recoveryHint via createAppError", () => {
    it("returns permissions hint for EACCES with file syscall", async () => {
      const CHANNELS = await getChannels();
      const mockWindow = createMockWindow();
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        err.syscall = "open";
        throw err;
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        err.syscall = "spawn git";
        throw err;
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        err.syscall = "spawn npm";
        throw err;
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        err.syscall = "open";
        throw err;
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        throw new Error("posix_spawnp: No such file or directory");
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        const err = new Error("getaddrinfo ENOTFOUND") as NodeJS.ErrnoException;
        err.code = "ENOTFOUND";
        throw err;
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
        err.code = "ECONNREFUSED";
        throw err;
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        const err = new Error("connect ETIMEDOUT") as NodeJS.ErrnoException;
        err.code = "ETIMEDOUT";
        throw err;
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        throw new GitError("fatal: not a git repository");
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        throw new GitError("Authentication failed for repo");
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        throw new ConfigError("bad config");
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        throw new ProcessError("pty failed");
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        throw new GitError(
          "Git operation failed: status",
          { rootPath: "/tmp" },
          new Error("fatal: not a git repository (or any parent up to mount point /)")
        );
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        throw new GitError("Git operation failed: merge");
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        const err = new Error("read ECONNRESET") as NodeJS.ErrnoException;
        err.code = "ECONNRESET";
        throw err;
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        const err = new Error("EBUSY: resource busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

      const spawn = vi.fn(() => {
        const err = new Error("EAGAIN") as NodeJS.ErrnoException;
        err.code = "EAGAIN";
        throw err;
      });
      registerErrorHandlers(mockWindow as never, null, { spawn } as never);

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
      registerErrorHandlers(mockWindow as never, null, null);

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

      registerErrorHandlers(createMockWindow() as never, null, null);
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
