import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { terminalInstanceService } from "../TerminalInstanceService";
import { INCREMENTAL_RESTORE_CONFIG } from "../types";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onResizeResult: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    onReset: vi.fn(() => vi.fn()),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffer: vi.fn(() => null),
    discardPortAcks: vi.fn(),
  },
  systemClient: {
    openExternal: vi.fn(),
  },
  appClient: {
    getHydrationState: vi.fn(),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() },
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

const mockDocument = {
  createElement: vi.fn(() => ({
    style: {},
    className: "",
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    parentElement: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
  body: {
    appendChild: vi.fn(),
  },
};

(global as any).document = mockDocument;

describe("TerminalInstanceService - Incremental Restore", () => {
  let mockTerminal: any;
  let writeCallbacks: Map<number, () => void>;
  let writeCallId: number;
  let postTaskCallbacks: Array<() => void>;
  let timeouts: Map<number, () => void>;
  let timeoutId: number;

  beforeEach(() => {
    vi.useFakeTimers();
    writeCallbacks = new Map();
    writeCallId = 0;
    postTaskCallbacks = [];
    timeouts = new Map();
    timeoutId = 0;

    vi.stubGlobal("scheduler", {
      postTask: vi.fn((cb: () => unknown) => {
        return new Promise<unknown>((resolve, reject) => {
          postTaskCallbacks.push(() => {
            try {
              resolve(cb());
            } catch (e) {
              reject(e);
            }
          });
        });
      }),
    });

    global.setTimeout = vi.fn((callback: () => void, _ms: number) => {
      const id = ++timeoutId;
      timeouts.set(id, callback);
      return id;
    }) as any;

    mockTerminal = {
      reset: vi.fn(),
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) {
          const id = ++writeCallId;
          writeCallbacks.set(id, callback);
          queueMicrotask(() => {
            const cb = writeCallbacks.get(id);
            if (cb) {
              cb();
              writeCallbacks.delete(id);
            }
          });
        }
      }),
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
      open: vi.fn(),
      dispose: vi.fn(),
      refresh: vi.fn(),
      buffer: {
        active: {
          baseY: 0,
          viewportY: 0,
          length: 100,
        },
      },
      rows: 24,
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      parser: {
        registerEscHandler: vi.fn(() => ({ dispose: vi.fn() })),
        registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
      },
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    writeCallbacks.clear();
    postTaskCallbacks = [];
    timeouts.clear();
  });

  const flushMicrotasks = async () => {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  };

  const flushPostTasks = async () => {
    const callbacks = [...postTaskCallbacks];
    postTaskCallbacks = [];
    callbacks.forEach((cb) => cb());
    await flushMicrotasks();
  };

  it("should cancel restore when terminal is destroyed mid-restore", async () => {
    const id = "test-terminal-4";
    const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 5);

    const terminal = await terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;

    const restorePromise = (terminalInstanceService as any).restoreFromSerializedIncremental(
      id,
      largeState
    );

    await flushMicrotasks();

    const initialWriteCount = mockTerminal.write.mock.calls.length;

    terminalInstanceService.destroy(id);

    await flushPostTasks();
    await flushMicrotasks();

    await restorePromise;

    expect(mockTerminal.write.mock.calls.length).toBeLessThanOrEqual(initialWriteCount + 1);
  });

  it("should not auto-scroll to bottom after synchronous restore", async () => {
    const id = "test-terminal-no-scroll-sync";
    const smallState = "x".repeat(1000);

    const terminal = await terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;
    terminal.latestWasAtBottom = true;

    terminalInstanceService.restoreFromSerialized(id, smallState);

    await flushMicrotasks();

    expect(mockTerminal.scrollToBottom).not.toHaveBeenCalled();

    terminalInstanceService.destroy(id);
  });

  it("should not auto-scroll to bottom after incremental restore", async () => {
    const id = "test-terminal-no-scroll-incr";
    const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes + 1000);

    const terminal = await terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;
    terminal.latestWasAtBottom = true;

    const restorePromise = (terminalInstanceService as any).restoreFromSerializedIncremental(
      id,
      largeState
    );

    await flushMicrotasks();

    for (let i = 0; i < 20; i++) {
      await flushPostTasks();
    }

    await restorePromise;

    expect(mockTerminal.scrollToBottom).not.toHaveBeenCalled();

    terminalInstanceService.destroy(id);
  });

  it("sync restore does not scroll when user is at bottom", async () => {
    const id = "test-scroll-sync-at-bottom";
    const smallState = "x".repeat(1000);

    const terminal = await terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;
    terminal.isUserScrolledBack = false;
    mockTerminal.buffer.active.baseY = 200;
    mockTerminal.buffer.active.viewportY = 200;

    terminalInstanceService.restoreFromSerialized(id, smallState);
    await flushMicrotasks();

    expect(mockTerminal.scrollToLine).not.toHaveBeenCalled();

    terminalInstanceService.destroy(id);
  });

  it("incremental restore preserves scroll when user is scrolled back", async () => {
    const id = "test-scroll-incr-preserve";
    const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes + 1000);

    const terminal = await terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;
    terminal.isUserScrolledBack = true;
    mockTerminal.buffer.active.baseY = 200;
    mockTerminal.buffer.active.viewportY = 150;

    // After reset+writes, simulate buffer repopulated
    const origReset = mockTerminal.reset;
    mockTerminal.reset = vi.fn(() => {
      origReset();
      mockTerminal.buffer.active.baseY = 0;
      mockTerminal.buffer.active.viewportY = 0;
    });

    const origWrite = mockTerminal.write;
    mockTerminal.write = vi.fn((data: string, callback?: () => void) => {
      mockTerminal.buffer.active.baseY = 300;
      mockTerminal.buffer.active.viewportY = 300;
      origWrite(data, callback);
    });

    const restorePromise = (terminalInstanceService as any).restoreFromSerializedIncremental(
      id,
      largeState
    );

    await flushMicrotasks();

    for (let i = 0; i < 20; i++) {
      await flushPostTasks();
    }

    await restorePromise;

    // offset was 200 - 150 = 50, new baseY = 300, so scrollToLine(250)
    expect(mockTerminal.scrollToLine).toHaveBeenCalledTimes(1);
    expect(mockTerminal.scrollToLine).toHaveBeenCalledWith(250);
    expect(mockTerminal.scrollToBottom).not.toHaveBeenCalled();

    terminalInstanceService.destroy(id);
  });

  it("sync restore clamps scroll to 0 when offset exceeds new baseY", async () => {
    const id = "test-scroll-sync-clamp";
    const smallState = "x".repeat(1000);

    const terminal = await terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;
    terminal.isUserScrolledBack = true;
    mockTerminal.buffer.active.baseY = 200;
    mockTerminal.buffer.active.viewportY = 100;

    const origWrite = mockTerminal.write;
    mockTerminal.write = vi.fn((data: string, callback?: () => void) => {
      mockTerminal.buffer.active.baseY = 50;
      mockTerminal.buffer.active.viewportY = 50;
      origWrite(data, callback);
    });

    terminalInstanceService.restoreFromSerialized(id, smallState);
    await flushMicrotasks();

    // offset was 200 - 100 = 100, new baseY = 50, so Math.max(0, 50 - 100) = 0
    expect(mockTerminal.scrollToLine).toHaveBeenCalledTimes(1);
    expect(mockTerminal.scrollToLine).toHaveBeenCalledWith(0);

    terminalInstanceService.destroy(id);
  });

  it("incremental restore clamps scroll to 0 when offset exceeds new baseY", async () => {
    const id = "test-scroll-incr-clamp";
    const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes + 1000);

    const terminal = await terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;
    terminal.isUserScrolledBack = true;
    mockTerminal.buffer.active.baseY = 200;
    mockTerminal.buffer.active.viewportY = 100;

    // After writes, simulate shorter buffer
    const origWrite = mockTerminal.write;
    mockTerminal.write = vi.fn((data: string, callback?: () => void) => {
      mockTerminal.buffer.active.baseY = 50;
      mockTerminal.buffer.active.viewportY = 50;
      origWrite(data, callback);
    });

    const restorePromise = (terminalInstanceService as any).restoreFromSerializedIncremental(
      id,
      largeState
    );

    await flushMicrotasks();

    for (let i = 0; i < 20; i++) {
      await flushPostTasks();
    }

    await restorePromise;

    // offset was 200 - 100 = 100, new baseY = 50, so Math.max(0, 50 - 100) = 0
    expect(mockTerminal.scrollToLine).toHaveBeenCalledTimes(1);
    expect(mockTerminal.scrollToLine).toHaveBeenCalledWith(0);

    terminalInstanceService.destroy(id);
  });
});
