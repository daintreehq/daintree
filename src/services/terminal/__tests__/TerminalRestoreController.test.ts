import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalRestoreController } from "../TerminalRestoreController";
import { INCREMENTAL_RESTORE_CONFIG, type ManagedTerminal } from "../types";

vi.mock("@/clients", () => ({
  terminalClient: {
    getSerializedState: vi.fn(),
  },
}));

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

describe("TerminalRestoreController", () => {
  let controller: TerminalRestoreController;
  let instances: Map<string, ManagedTerminal>;
  let writeDataSpy: (id: string, data: string | Uint8Array) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTerminal: Record<string, any>;
  let writeCallbacks: Map<number, () => void>;
  let writeCallId: number;
  let postTaskCallbacks: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();

    writeCallbacks = new Map();
    writeCallId = 0;
    postTaskCallbacks = [];

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
      scrollToLine: vi.fn(),
      scrollToBottom: vi.fn(),
      buffer: {
        active: { baseY: 0, viewportY: 0, length: 100 },
      },
      rows: 24,
    };

    instances = new Map();
    writeDataSpy = vi.fn<(id: string, data: string | Uint8Array) => void>();

    controller = new TerminalRestoreController({
      getInstance: (id) => instances.get(id),
      writeData: writeDataSpy,
    });
  });

  afterEach(() => {
    controller.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    writeCallbacks.clear();
    postTaskCallbacks = [];
  });

  function makeManagedTerminal(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
    return {
      terminal: mockTerminal,
      writeChain: Promise.resolve(),
      restoreGeneration: 0,
      isSerializedRestoreInProgress: false,
      deferredOutput: [],
      isUserScrolledBack: false,
      ...overrides,
    } as unknown as ManagedTerminal;
  }

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

  describe("restoreFromSerialized", () => {
    it("returns false for unknown terminal", () => {
      const result = controller.restoreFromSerialized("nonexistent", "data");
      expect(result).toBe(false);
    });

    it("performs synchronous restore for small state", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const smallState = "x".repeat(1000);

      const result = controller.restoreFromSerialized("t1", smallState);

      expect(result).toBe(true);
      expect(mockTerminal.reset).toHaveBeenCalledTimes(1);
      expect(mockTerminal.write).toHaveBeenCalledWith(smallState, expect.any(Function));
    });

    it("delegates to incremental for large state", () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes + 1);

      const result = controller.restoreFromSerialized("t1", largeState);
      expect(result).toBe(true);
    });

    it("flushes deferred output after restore", async () => {
      const managed = makeManagedTerminal();
      managed.deferredOutput = ["deferred1", "deferred2"];
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "small-state");
      await flushMicrotasks();

      expect(writeDataSpy).toHaveBeenCalledWith("t1", "deferred1");
      expect(writeDataSpy).toHaveBeenCalledWith("t1", "deferred2");
    });

    it("preserves scroll position when user is scrolled back", async () => {
      const managed = makeManagedTerminal({ isUserScrolledBack: true });
      instances.set("t1", managed);
      mockTerminal.buffer.active.baseY = 200;
      mockTerminal.buffer.active.viewportY = 150;

      const origWrite = mockTerminal.write;
      mockTerminal.write = vi.fn((data: string, callback?: () => void) => {
        mockTerminal.buffer.active.baseY = 300;
        mockTerminal.buffer.active.viewportY = 300;
        origWrite(data, callback);
      });

      controller.restoreFromSerialized("t1", "state");
      await flushMicrotasks();

      expect(mockTerminal.scrollToLine).toHaveBeenCalledWith(250);
    });
  });

  describe("restoreFromSerializedIncremental", () => {
    it("returns false for unknown terminal", async () => {
      const result = await controller.restoreFromSerializedIncremental("nonexistent", "data");
      expect(result).toBe(false);
    });

    it("chunks large data and yields to UI", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 3);

      const restorePromise = controller.restoreFromSerializedIncremental("t1", largeState);
      await flushMicrotasks();

      expect(mockTerminal.reset).toHaveBeenCalledTimes(1);
      expect((global as any).scheduler.postTask).toHaveBeenCalled();

      for (let i = 0; i < 10; i++) {
        await flushPostTasks();
      }

      await restorePromise;

      const totalWritten = mockTerminal.write.mock.calls
        .map((call: [string, ...unknown[]]) => call[0].length)
        .reduce((sum: number, len: number) => sum + len, 0);
      expect(totalWritten).toBe(largeState.length);
    });

    it("sets and clears isSerializedRestoreInProgress flag", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const data = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2);

      expect(managed.isSerializedRestoreInProgress).toBe(false);

      const promise = controller.restoreFromSerializedIncremental("t1", data);
      await flushMicrotasks();
      expect(managed.isSerializedRestoreInProgress).toBe(true);

      for (let i = 0; i < 10; i++) {
        await flushPostTasks();
      }
      await promise;

      expect(managed.isSerializedRestoreInProgress).toBe(false);
    });

    it("cancels when terminal is destroyed mid-restore", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const data = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 5);

      const promise = controller.restoreFromSerializedIncremental("t1", data);
      await flushMicrotasks();

      const initialWrites = mockTerminal.write.mock.calls.length;

      controller.destroy("t1");

      await flushPostTasks();
      await flushMicrotasks();
      await promise;

      expect(mockTerminal.write.mock.calls.length).toBeLessThanOrEqual(initialWrites + 1);
    });

    it("flushes deferred output via writeData callback", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const data = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2);

      managed.deferredOutput = ["deferred-data"];

      const promise = controller.restoreFromSerializedIncremental("t1", data);
      await flushMicrotasks();

      for (let i = 0; i < 10; i++) {
        await flushPostTasks();
      }
      await promise;

      expect(writeDataSpy).toHaveBeenCalledWith("t1", "deferred-data");
    });

    it("falls back to setTimeout when scheduler is unavailable", async () => {
      (global as any).scheduler = undefined;

      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const data = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2);

      const promise = controller.restoreFromSerializedIncremental("t1", data);
      await flushMicrotasks();

      vi.advanceTimersByTime(INCREMENTAL_RESTORE_CONFIG.timeBudgetMs + 1);
      await flushMicrotasks();
      vi.advanceTimersByTime(INCREMENTAL_RESTORE_CONFIG.timeBudgetMs + 1);
      await flushMicrotasks();

      await promise;

      const totalWritten = mockTerminal.write.mock.calls
        .map((call: [string, ...unknown[]]) => call[0].length)
        .reduce((sum: number, len: number) => sum + len, 0);
      expect(totalWritten).toBe(data.length);
    });
  });

  describe("restoreFetchedState", () => {
    it("returns false for null state", async () => {
      const result = await controller.restoreFetchedState("t1", null);
      expect(result).toBe(false);
    });

    it("uses sync restore for small state", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const result = await controller.restoreFetchedState("t1", "small");
      expect(result).toBe(true);
      expect(mockTerminal.reset).toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("bumps restore generation and clears restore state", () => {
      const managed = makeManagedTerminal({
        isSerializedRestoreInProgress: true,
        deferredOutput: ["data"],
      });
      instances.set("t1", managed);

      const prevGen = managed.restoreGeneration;
      controller.destroy("t1");

      expect(managed.restoreGeneration).toBe(prevGen + 1);
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(managed.deferredOutput).toHaveLength(0);
    });
  });
});
