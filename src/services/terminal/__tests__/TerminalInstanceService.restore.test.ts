import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { terminalInstanceService } from "../TerminalInstanceService";
import { INCREMENTAL_RESTORE_CONFIG } from "../types";

vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class {
    dispose() {}
  },
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffer: vi.fn(() => null),
  },
  systemClient: {
    openExternal: vi.fn(),
  },
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    canvasAddon: { dispose: vi.fn() },
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    webLinksAddon: {},
    imageAddon: {},
    searchAddon: {},
  })),
}));

const mockDocument = {
  createElement: vi.fn(() => ({
    style: {},
    className: "",
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    parentElement: null,
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
  let idleCallbacks: Map<number, () => void>;
  let idleCallbackId: number;
  let timeouts: Map<number, () => void>;
  let timeoutId: number;

  beforeEach(() => {
    vi.useFakeTimers();
    writeCallbacks = new Map();
    writeCallId = 0;
    idleCallbacks = new Map();
    idleCallbackId = 0;
    timeouts = new Map();
    timeoutId = 0;

    global.requestIdleCallback = vi.fn((callback: () => void) => {
      const id = ++idleCallbackId;
      idleCallbacks.set(id, callback);
      return id;
    }) as any;

    global.cancelIdleCallback = vi.fn((id: number) => {
      idleCallbacks.delete(id);
    }) as any;

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
    writeCallbacks.clear();
    idleCallbacks.clear();
    timeouts.clear();
  });

  const flushMicrotasks = async () => {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  };

  const flushIdleCallbacks = () => {
    const callbacks = Array.from(idleCallbacks.values());
    idleCallbacks.clear();
    callbacks.forEach((cb) => cb());
  };

  it("should use synchronous restore for small serialized state", async () => {
    const id = "test-terminal-1";
    const smallState = "x".repeat(1000);

    const terminal = terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;

    const result = terminalInstanceService.restoreFromSerialized(id, smallState);

    expect(result).toBe(true);
    expect(mockTerminal.reset).toHaveBeenCalledTimes(1);
    expect(mockTerminal.write).toHaveBeenCalledTimes(1);
    expect(mockTerminal.write).toHaveBeenCalledWith(smallState, expect.any(Function));

    terminalInstanceService.destroy(id);
  });

  it("should use incremental restore for large serialized state", async () => {
    const id = "test-terminal-2";
    const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes + 1000);

    const terminal = terminalInstanceService.getOrCreate(
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

    expect(mockTerminal.reset).toHaveBeenCalledTimes(1);
    expect(mockTerminal.write).toHaveBeenCalled();

    for (let i = 0; i < 20; i++) {
      flushIdleCallbacks();
      await flushMicrotasks();
    }

    await restorePromise;

    expect(mockTerminal.write.mock.calls.length).toBeGreaterThan(1);

    const totalWritten = mockTerminal.write.mock.calls
      .map((call: any) => call[0].length)
      .reduce((sum: number, len: number) => sum + len, 0);

    expect(totalWritten).toBe(largeState.length);

    terminalInstanceService.destroy(id);
  });

  it("should yield to UI between chunks", async () => {
    const id = "test-terminal-3";
    const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 3);

    const terminal = terminalInstanceService.getOrCreate(
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

    expect(global.requestIdleCallback).toHaveBeenCalled();

    flushIdleCallbacks();
    await flushMicrotasks();

    flushIdleCallbacks();
    await flushMicrotasks();

    await restorePromise;

    terminalInstanceService.destroy(id);
  });

  it("should cancel restore when terminal is destroyed mid-restore", async () => {
    const id = "test-terminal-4";
    const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 5);

    const terminal = terminalInstanceService.getOrCreate(
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

    flushIdleCallbacks();
    await flushMicrotasks();

    await restorePromise;

    expect(mockTerminal.write.mock.calls.length).toBeLessThanOrEqual(initialWriteCount + 1);
  });

  it("should handle concurrent restore requests with generation tracking", async () => {
    const id = "test-terminal-5";
    const state1 = "a".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2);
    const state2 = "b".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2);

    const terminal = terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;

    const restore1 = (terminalInstanceService as any).restoreFromSerializedIncremental(id, state1);

    await flushMicrotasks();

    const restore2 = (terminalInstanceService as any).restoreFromSerializedIncremental(id, state2);

    await flushMicrotasks();

    for (let i = 0; i < 10; i++) {
      flushIdleCallbacks();
      await flushMicrotasks();
    }

    await Promise.all([restore1, restore2]);

    terminalInstanceService.destroy(id);
  });

  it("should gate writes through writeChain to prevent interleaving", async () => {
    const id = "test-terminal-6";
    const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2);

    const terminal = terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;

    const writeOrder: string[] = [];

    mockTerminal.write = vi.fn((data: string, callback?: () => void) => {
      writeOrder.push(data.substring(0, 10));
      if (callback) {
        queueMicrotask(callback);
      }
    });

    const restorePromise = (terminalInstanceService as any).restoreFromSerializedIncremental(
      id,
      largeState
    );

    await flushMicrotasks();
    flushIdleCallbacks();
    await flushMicrotasks();
    flushIdleCallbacks();
    await flushMicrotasks();

    await restorePromise;

    expect(writeOrder.length).toBeGreaterThan(1);

    terminalInstanceService.destroy(id);
  });

  it("should set and clear isSerializedRestoreInProgress flag", async () => {
    const id = "test-terminal-7";
    const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2);

    const terminal = terminalInstanceService.getOrCreate(
      id,
      "terminal",
      {},
      () => 3 as any,
      undefined
    );

    terminal.terminal = mockTerminal;

    expect(terminal.isSerializedRestoreInProgress).toBe(false);

    const restorePromise = (terminalInstanceService as any).restoreFromSerializedIncremental(
      id,
      largeState
    );

    await flushMicrotasks();

    expect(terminal.isSerializedRestoreInProgress).toBe(true);

    flushIdleCallbacks();
    await flushMicrotasks();
    flushIdleCallbacks();
    await flushMicrotasks();

    await restorePromise;

    expect(terminal.isSerializedRestoreInProgress).toBe(false);

    terminalInstanceService.destroy(id);
  });

  it("should fallback to setTimeout when requestIdleCallback is unavailable", async () => {
    const id = "test-terminal-8";
    const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2);

    (global as any).requestIdleCallback = undefined;

    const terminal = terminalInstanceService.getOrCreate(
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

    expect(global.setTimeout).toHaveBeenCalled();

    const timeoutCallbacks = Array.from(timeouts.values());
    timeouts.clear();
    timeoutCallbacks.forEach((cb) => cb());
    await flushMicrotasks();

    await restorePromise;

    terminalInstanceService.destroy(id);

    global.requestIdleCallback = vi.fn((callback: () => void) => {
      const id = ++idleCallbackId;
      idleCallbacks.set(id, callback);
      return id;
    }) as any;
  });
});
