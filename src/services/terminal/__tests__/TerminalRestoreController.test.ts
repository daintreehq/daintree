import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { TerminalRestoreController, safeChunkSlice } from "../TerminalRestoreController";
import { TerminalWriteController } from "../TerminalWriteController";
import { INCREMENTAL_RESTORE_CONFIG, type ManagedTerminal } from "../types";
import { streamRangeOf, utf8Length } from "../streamFence";
import type { SerializedTerminalSnapshot } from "@shared/types/terminal";
import { PARSER_GROUND, PartialEscapeTracker } from "@shared/utils/terminalPartialEscapeTail";
import { terminalClient } from "@/clients";

/** Wrap a payload in the snapshot envelope the IPC now returns (#11552). */
function snapshot(data: string, cols = 80, rows = 24): SerializedTerminalSnapshot {
  return { data, cols, rows };
}

vi.mock("@/clients", () => ({
  terminalClient: {
    getSerializedState: vi.fn(),
  },
}));

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("@/utils/performance", () => ({
  markRendererPerformance: vi.fn(),
}));

describe("TerminalRestoreController", () => {
  let controller: TerminalRestoreController;
  let instances: Map<string, ManagedTerminal>;
  let writeDataSpy: (id: string, data: string | Uint8Array, chunkCount: number) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTerminal: Record<string, any>;
  let writeCallbacks: Map<number, () => void>;
  let writeCallId: number;
  let postTaskCallbacks: Array<() => void>;
  let yieldCallbacks: Array<() => void>;
  // Standalone so a test can wrap `write` without reading the mock back out of
  // itself — doing that re-enters the wrapper and recurses until the stack dies.
  let baseWriteImpl: (data: string, callback?: () => void) => void;

  beforeEach(() => {
    vi.useFakeTimers();

    writeCallbacks = new Map();
    writeCallId = 0;
    postTaskCallbacks = [];
    yieldCallbacks = [];

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
      yield: vi.fn(() => {
        return new Promise<void>((resolve) => {
          yieldCallbacks.push(resolve);
        });
      }),
    });

    baseWriteImpl = (_data: string, callback?: () => void) => {
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
    };

    mockTerminal = {
      reset: vi.fn(),
      write: vi.fn(baseWriteImpl),
      scrollToLine: vi.fn(),
      scrollToBottom: vi.fn(),
      buffer: {
        active: { baseY: 0, viewportY: 0, length: 100 },
      },
      cols: 170,
      rows: 24,
      options: { reflowCursorLine: false },
      resize: vi.fn((cols: number, rows: number) => {
        mockTerminal.cols = cols;
        mockTerminal.rows = rows;
      }),
    };

    instances = new Map();
    writeDataSpy = vi.fn<(id: string, data: string | Uint8Array, chunkCount: number) => void>();

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
    yieldCallbacks = [];
  });

  function makeManagedTerminal(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
    return {
      terminal: mockTerminal,
      writeChain: Promise.resolve(),
      restoreGeneration: 0,
      restoreWindowToken: 0,
      isSerializedRestoreInProgress: false,
      deferredOutput: [],
      isUserScrolledBack: false,
      // These model an attached pane: `mockTerminal.cols` is a measured grid, so
      // the restore window may seed from it. A never-opened pane is still on its
      // constructor default and seeds from its target instead (#11718).
      isOpened: true,
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

  const flushYields = async () => {
    const callbacks = [...yieldCallbacks];
    yieldCallbacks = [];
    callbacks.forEach((cb) => cb());
    await flushMicrotasks();
  };

  const flushScheduler = async () => {
    await flushYields();
    await flushPostTasks();
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
      expect(mockTerminal.write).toHaveBeenCalledWith(
        PARSER_GROUND + smallState,
        expect.any(Function)
      );
    });

    it("flushes deferred output after restore", async () => {
      const managed = makeManagedTerminal();
      managed.deferredOutput = [
        { data: "deferred1", chunkCount: 1 },
        { data: "deferred2", chunkCount: 3 },
      ];
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "small-state");
      await flushMicrotasks();

      // Each replayed batch carries its own chunkCount so the write settles
      // exactly the pending port-ack FIFO entries the batch owns.
      expect(writeDataSpy).toHaveBeenCalledWith("t1", "deferred1", 1);
      expect(writeDataSpy).toHaveBeenCalledWith("t1", "deferred2", 3);
    });

    it("does not apply callback when destroyed mid-write", async () => {
      const managed = makeManagedTerminal({
        deferredOutput: [{ data: "should-not-flush", chunkCount: 1 }],
      });
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "small-state");

      // Destroy between write() and callback firing
      controller.destroy("t1");
      await flushMicrotasks();

      expect(writeDataSpy).not.toHaveBeenCalled();
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(mockTerminal.scrollToLine).not.toHaveBeenCalled();
    });

    it("does not apply first callback when a second restore starts before callback fires", async () => {
      const managed = makeManagedTerminal({
        deferredOutput: [{ data: "first-deferred", chunkCount: 1 }],
      });
      instances.set("t1", managed);

      // First restore — callback queued but not yet fired
      controller.restoreFromSerialized("t1", "first-state");

      // Second restore before first callback fires
      managed.deferredOutput = [{ data: "second-deferred", chunkCount: 2 }];
      controller.restoreFromSerialized("t1", "second-state");

      await flushMicrotasks();

      // Only the second restore's deferred output should have been flushed
      expect(writeDataSpy).toHaveBeenCalledTimes(1);
      expect(writeDataSpy).toHaveBeenCalledWith("t1", "second-deferred", 2);
      expect(managed.restoreGeneration).toBe(2);
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
      expect((global as any).scheduler.yield).toHaveBeenCalled();
      expect((global as any).scheduler.postTask).not.toHaveBeenCalled();

      for (let i = 0; i < 10; i++) {
        await flushScheduler();
      }

      await restorePromise;

      const totalWritten = mockTerminal.write.mock.calls
        .map((call: [string, ...unknown[]]) => call[0].length)
        .reduce((sum: number, len: number) => sum + len, 0);
      // One CAN leads the replay.
      expect(totalWritten).toBe(largeState.length + 1);
    });

    it("falls back to scheduler.postTask when yield is unavailable", async () => {
      (global as any).scheduler.yield = undefined;

      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const data = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2);

      const promise = controller.restoreFromSerializedIncremental("t1", data);
      await flushMicrotasks();

      expect((global as any).scheduler.postTask).toHaveBeenCalled();

      for (let i = 0; i < 10; i++) {
        await flushPostTasks();
      }
      await promise;

      const totalWritten = mockTerminal.write.mock.calls
        .map((call: [string, ...unknown[]]) => call[0].length)
        .reduce((sum: number, len: number) => sum + len, 0);
      // One CAN leads the replay.
      expect(totalWritten).toBe(data.length + 1);
    });

    it("does not split surrogate pairs across chunks", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      // Build a state where a surrogate pair (rocket emoji U+1F680 → "🚀")
      // straddles the configured chunk boundary. Fill up to one code unit short
      // of the boundary, then emit the pair, then pad the second chunk.
      const chunkBytes = INCREMENTAL_RESTORE_CONFIG.chunkBytes;
      const rocket = "🚀";
      const head = "a".repeat(chunkBytes - 1);
      const tail = "b".repeat(chunkBytes);
      const state = head + rocket + tail;

      const promise = controller.restoreFromSerializedIncremental("t1", state);
      await flushMicrotasks();

      for (let i = 0; i < 10; i++) {
        await flushScheduler();
      }
      await promise;

      const chunks = mockTerminal.write.mock.calls.map((call: [string, ...unknown[]]) => call[0]);
      expect((chunks as string[]).join("")).toBe(PARSER_GROUND + state);

      for (const chunk of chunks as string[]) {
        if (chunk.length === 0) continue;
        const firstCode = chunk.charCodeAt(0);
        const lastCode = chunk.charCodeAt(chunk.length - 1);
        // A chunk must not begin with a lone low surrogate or end with a lone high surrogate.
        expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
        expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      }
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
        await flushScheduler();
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

      await flushScheduler();
      await flushMicrotasks();
      await promise;

      expect(mockTerminal.write.mock.calls.length).toBeLessThanOrEqual(initialWrites + 1);
    });

    it("flushes deferred output via writeData callback", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const data = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2);

      managed.deferredOutput = [{ data: "deferred-data", chunkCount: 1 }];

      const promise = controller.restoreFromSerializedIncremental("t1", data);
      await flushMicrotasks();

      for (let i = 0; i < 10; i++) {
        await flushScheduler();
      }
      await promise;

      expect(writeDataSpy).toHaveBeenCalledWith("t1", "deferred-data", 1);
    });

    it("clears all timeout handles after successful multi-chunk restore", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const data = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 3);

      const promise = controller.restoreFromSerializedIncremental("t1", data);
      await flushMicrotasks();

      for (let i = 0; i < 10; i++) {
        await flushScheduler();
      }
      await promise;

      expect(vi.getTimerCount()).toBe(0);
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
      // One CAN leads the replay.
      expect(totalWritten).toBe(data.length + 1);
    });
  });

  describe("restoreFetchedState", () => {
    it("returns false for null state", async () => {
      const result = await controller.restoreFetchedState("t1", null);
      expect(result).toBe(false);
    });
  });

  describe("fetchAndRestore", () => {
    it("sets isSerializedRestoreInProgress before IPC fetch resolves", async () => {
      const { terminalClient } = await import("@/clients");
      let resolveFetch!: (value: SerializedTerminalSnapshot | null) => void;
      vi.mocked(terminalClient.getSerializedState).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      );

      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.fetchAndRestore("t1");
      await flushMicrotasks();

      // Flag should be set BEFORE the IPC call resolves
      expect(managed.isSerializedRestoreInProgress).toBe(true);

      resolveFetch(snapshot("small-state"));
      await flushMicrotasks();
      await promise;
    });

    it("returns false and clears flag when terminal becomes stale during fetch", async () => {
      const { terminalClient } = await import("@/clients");
      let resolveFetch!: (value: SerializedTerminalSnapshot | null) => void;
      vi.mocked(terminalClient.getSerializedState).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      );

      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.fetchAndRestore("t1");
      await flushMicrotasks();

      // Simulate terminal being destroyed during fetch
      controller.destroy("t1");

      resolveFetch(snapshot("state-data"));
      const result = await promise;

      expect(result).toBe(false);
    });

    it("returns false for unknown terminal", async () => {
      const result = await controller.fetchAndRestore("nonexistent");
      expect(result).toBe(false);
    });

    it("clears isSerializedRestoreInProgress when serialized state is null", async () => {
      const { terminalClient } = await import("@/clients");
      vi.mocked(terminalClient.getSerializedState).mockResolvedValue(null);

      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const result = await controller.fetchAndRestore("t1");

      expect(result).toBe(false);
      expect(managed.isSerializedRestoreInProgress).toBe(false);
    });

    it("replays output deferred during the fetch when the state comes back null", async () => {
      // Deferred entries carry unsettled ledger charges (port-ack FIFO, IPC
      // ledger, ingest inFlightBytes) — a restore that never runs must still
      // release them by replaying, or the ingest queue strands invisibly
      // (getStalledBytes reads inFlightBytes>0 as healthy).
      const { terminalClient } = await import("@/clients");
      let resolveFetch!: (value: SerializedTerminalSnapshot | null) => void;
      vi.mocked(terminalClient.getSerializedState).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      );

      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.fetchAndRestore("t1");
      await flushMicrotasks();

      // Live output arrives while the snapshot fetch is in flight.
      managed.deferredOutput.push({ data: "mid-fetch-output", chunkCount: 2 });

      resolveFetch(null);
      const result = await promise;

      expect(result).toBe(false);
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(writeDataSpy).toHaveBeenCalledWith("t1", "mid-fetch-output", 2);
      expect(managed.deferredOutput).toHaveLength(0);
    });

    it("replays output deferred during the fetch when the fetch rejects", async () => {
      const { terminalClient } = await import("@/clients");
      let rejectFetch!: (err: Error) => void;
      vi.mocked(terminalClient.getSerializedState).mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectFetch = reject;
          })
      );

      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.fetchAndRestore("t1");
      await flushMicrotasks();

      managed.deferredOutput.push({ data: "mid-fetch-output", chunkCount: 1 });

      rejectFetch(new Error("host gone"));
      const result = await promise;

      expect(result).toBe(false);
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(writeDataSpy).toHaveBeenCalledWith("t1", "mid-fetch-output", 1);
      expect(managed.deferredOutput).toHaveLength(0);
    });

    it("does NOT replay on a stale-generation fetch failure — the newer restore owns the entries", async () => {
      const { terminalClient } = await import("@/clients");
      let rejectFetch!: (err: Error) => void;
      vi.mocked(terminalClient.getSerializedState).mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectFetch = reject;
          })
      );

      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.fetchAndRestore("t1");
      await flushMicrotasks();
      managed.deferredOutput.push({ data: "held-for-next-gen", chunkCount: 1 });

      // A newer restore supersedes this one before the fetch settles.
      managed.restoreGeneration++;
      rejectFetch(new Error("host gone"));
      await promise;

      expect(writeDataSpy).not.toHaveBeenCalled();
      expect(managed.deferredOutput).toHaveLength(1);
    });
  });

  describe("recoverMissingOutput (#12754)", () => {
    async function deferredFetch() {
      const { terminalClient } = await import("@/clients");
      let resolveFetch!: (value: SerializedTerminalSnapshot | null) => void;
      vi.mocked(terminalClient.getSerializedState).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      );
      return (value: SerializedTerminalSnapshot | null) => resolveFetch(value);
    }

    it("repaints a never-fed pane from a non-empty host snapshot", async () => {
      const resolveFetch = await deferredFetch();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.recoverMissingOutput("t1");
      await flushMicrotasks();
      resolveFetch(snapshot("oh-my-zsh update prompt", 170, 24));
      const outcome = await promise;

      expect(outcome).toBe("recovered");
      expect(mockTerminal.reset).toHaveBeenCalledTimes(1);
      expect(mockTerminal.write).toHaveBeenCalledWith(
        PARSER_GROUND + "oh-my-zsh update prompt",
        expect.any(Function)
      );
      expect(managed.hasReceivedOutput).toBe(true);
    });

    it("leaves a silent pane untouched when the host mirror is empty too", async () => {
      const resolveFetch = await deferredFetch();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.recoverMissingOutput("t1");
      await flushMicrotasks();
      resolveFetch(snapshot(""));
      const outcome = await promise;

      expect(outcome).toBe("no-host-output");
      expect(mockTerminal.reset).not.toHaveBeenCalled();
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(managed.hasReceivedOutput).toBeUndefined();
    });

    it("abandons without a reset when live output lands during the fetch, releasing it once", async () => {
      const resolveFetch = await deferredFetch();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.recoverMissingOutput("t1");
      await flushMicrotasks();
      // The delayed first chunk arrives while the snapshot (which also holds
      // it) is in flight — restoring now would print it twice.
      managed.deferredOutput.push({ data: "prompt$ ", chunkCount: 1 });
      resolveFetch(snapshot("prompt$ "));
      const outcome = await promise;

      expect(outcome).toBe("live-output");
      expect(mockTerminal.reset).not.toHaveBeenCalled();
      expect(mockTerminal.write).not.toHaveBeenCalled();
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(writeDataSpy).toHaveBeenCalledTimes(1);
      expect(writeDataSpy).toHaveBeenCalledWith("t1", "prompt$ ", 1);
      expect(managed.deferredOutput).toHaveLength(0);
    });

    it("does nothing for a pane that has already received output", async () => {
      const { terminalClient } = await import("@/clients");
      vi.mocked(terminalClient.getSerializedState).mockClear();
      instances.set("t1", makeManagedTerminal({ hasReceivedOutput: true }));

      expect(await controller.recoverMissingOutput("t1")).toBe("live-output");
      expect(terminalClient.getSerializedState).not.toHaveBeenCalled();
    });

    it("reports stale when the terminal is replaced during the fetch", async () => {
      const resolveFetch = await deferredFetch();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.recoverMissingOutput("t1");
      await flushMicrotasks();
      instances.set("t1", makeManagedTerminal());
      resolveFetch(snapshot("data"));

      expect(await promise).toBe("stale");
      expect(mockTerminal.reset).not.toHaveBeenCalled();
    });

    it("does not count a failed fetch as a failure when live output arrived meanwhile", async () => {
      const { terminalClient } = await import("@/clients");
      let rejectFetch!: (err: Error) => void;
      vi.mocked(terminalClient.getSerializedState).mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectFetch = reject;
          })
      );
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.recoverMissingOutput("t1");
      await flushMicrotasks();
      managed.deferredOutput.push({ data: "late", chunkCount: 1 });
      rejectFetch(new Error("host gone"));

      expect(await promise).toBe("live-output");
      expect(managed.lastScrollbackRestoreError).toBeUndefined();
      expect(writeDataSpy).toHaveBeenCalledWith("t1", "late", 1);
    });

    it("reports stale when a newer restore supersedes the probe before its fetch rejects", async () => {
      const { terminalClient } = await import("@/clients");
      let rejectFetch!: (err: Error) => void;
      vi.mocked(terminalClient.getSerializedState).mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectFetch = reject;
          })
      );
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.recoverMissingOutput("t1");
      await flushMicrotasks();
      managed.restoreGeneration += 1;
      rejectFetch(new Error("host gone"));

      expect(await promise).toBe("stale");
      expect(managed.lastScrollbackRestoreError).toBeUndefined();
    });

    it("reports stale, not failed, when a newer restore supersedes a large replay", async () => {
      const resolveFetch = await deferredFetch();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const big = "x".repeat(INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes + 1);

      const promise = controller.recoverMissingOutput("t1");
      await flushMicrotasks();
      resolveFetch(snapshot(big));
      await flushMicrotasks();
      // A newer restore claims the terminal mid-replay.
      managed.restoreGeneration += 1;
      await flushScheduler();
      await flushMicrotasks();

      expect(await promise).toBe("stale");
      expect(managed.lastScrollbackRestoreError).toBeUndefined();
    });

    it("reports failed with a classified error when the fetch rejects", async () => {
      const { terminalClient } = await import("@/clients");
      vi.mocked(terminalClient.getSerializedState).mockRejectedValue(new Error("host gone"));
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      expect(await controller.recoverMissingOutput("t1")).toBe("failed");
      expect(managed.lastScrollbackRestoreError).toMatchObject({
        type: "error",
        message: "host gone",
      });
      expect(managed.isSerializedRestoreInProgress).toBe(false);
    });
  });

  describe("failure-path deferred replay (synchronous restore)", () => {
    it("replays deferred output when terminal.reset throws mid-restore", () => {
      const managed = makeManagedTerminal({
        deferredOutput: [{ data: "held", chunkCount: 3 }],
      });
      instances.set("t1", managed);
      mockTerminal.reset.mockImplementationOnce(() => {
        throw new Error("core torn down");
      });

      const result = controller.restoreFromSerialized("t1", "small-state");

      expect(result).toBe(false);
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(writeDataSpy).toHaveBeenCalledWith("t1", "held", 3);
      expect(managed.deferredOutput).toHaveLength(0);
    });
  });

  describe("capture-geometry alignment (#11552)", () => {
    // SerializeAddon encodes wrap state that only decodes at the width it was
    // captured on, and the damage a mismatched replay commits into cell data is
    // not repairable by any later reflow. These tests pin the ordering that
    // makes replay safe, not the fact that a resize happens.
    const captureAt80 = { cols: 80, rows: 24 };

    /** Ordered log of what happened to the grid, so ordering is assertable. */
    function traceGrid() {
      const trace: string[] = [];
      mockTerminal.reset.mockImplementation(() => trace.push("reset"));
      mockTerminal.resize.mockImplementation((cols: number, rows: number) => {
        mockTerminal.cols = cols;
        mockTerminal.rows = rows;
        trace.push(`resize:${cols}x${rows}`);
      });
      mockTerminal.write.mockImplementation((data: string, callback?: () => void) => {
        trace.push(`write:${data}`);
        baseWriteImpl(data, callback);
      });
      return trace;
    }

    it("writes the payload at the capture grid, then reflows to the live grid", async () => {
      const trace = traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "payload", captureAt80);
      await flushMicrotasks();

      // The resize must land between reset and write: xterm parses
      // asynchronously, so a grid corrected after write() returns would arrive
      // too late and the payload would lay out at the wrong width anyway.
      expect(trace).toEqual([
        "reset",
        "resize:80x24",
        `write:${PARSER_GROUND}payload`,
        "resize:170x24",
      ]);
      expect(managed.terminal.cols).toBe(170);
    });

    it("leaves the grid untouched when the capture already matches", async () => {
      traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "payload", { cols: 170, rows: 24 });
      await flushMicrotasks();

      expect(mockTerminal.resize).not.toHaveBeenCalled();
    });

    it("replays verbatim when the snapshot predates the geometry contract", async () => {
      traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      // An older pty host, or a preserved snapshot captured before #11552.
      // Reproducing today's behaviour beats dropping the session outright.
      controller.restoreFromSerialized("t1", "payload");
      await flushMicrotasks();

      expect(mockTerminal.resize).not.toHaveBeenCalled();
      expect(mockTerminal.write).toHaveBeenCalledWith(
        PARSER_GROUND + "payload",
        expect.any(Function)
      );
    });

    it("refuses a geometry no terminal could have been captured at", async () => {
      traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "payload", { cols: 0, rows: -4 });
      await flushMicrotasks();

      expect(mockTerminal.resize).not.toHaveBeenCalled();
    });

    it("refuses a collapsed capture grid and still replays the payload (#12442)", async () => {
      // Structurally valid, so the old validator aligned to it — and parking a
      // real xterm on a snapshot's 2x1 capture grid is how the renderer adopted
      // the collapse, which `collectTerminalSizes` then persisted as the pane's
      // real size. The session must still come back; only the alignment goes.
      traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "payload", { cols: 2, rows: 1 });
      await flushMicrotasks();

      expect(mockTerminal.resize).not.toHaveBeenCalled();
      expect(mockTerminal.write).toHaveBeenCalledWith(
        PARSER_GROUND + "payload",
        expect.any(Function)
      );
    });

    it("does not return an opened pane to a collapsed grid when the replay closes (#12442)", async () => {
      // The seed, not the capture. An opened pane already at 2x1 seeds the
      // restore window from its own live grid, aligns to a HEALTHY capture
      // grid for the replay, and would then be resized straight back to 2x1 on
      // completion — reintroducing the collapse from inside the fix.
      const trace = traceGrid();
      const managed = makeManagedTerminal();
      managed.isOpened = true;
      mockTerminal.cols = 2;
      mockTerminal.rows = 1;
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "payload", { cols: 80, rows: 24 });
      await flushMicrotasks();

      expect(trace).not.toContain("resize:2x1");
      expect(mockTerminal.write).toHaveBeenCalledWith(
        PARSER_GROUND + "payload",
        expect.any(Function)
      );
      expect(managed.isSerializedRestoreInProgress).toBe(false);
    });

    it("still lands a healthy target parked while an implausible resize was refused", async () => {
      // The restore must complete either way: a refused geometry cannot leave
      // the pane frozen with its write gate shut, and the healthy target that
      // was already parked still has to be applied.
      const trace = traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "payload", captureAt80);
      managed.pendingRestoreGeometry = { cols: 120, rows: 30 };
      await flushMicrotasks();

      expect(trace.at(-1)).toBe("resize:120x30");
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(managed.pendingRestoreGeometry).toBeUndefined();
    });

    it("normalizes to a resize that landed mid-replay, not the pre-replay grid", async () => {
      const trace = traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "payload", captureAt80);
      // A layout change while xterm is parked at the capture width. The resize
      // controller parks it here rather than applying it; without that, the
      // normalization below would reflow it straight back out.
      managed.pendingRestoreGeometry = { cols: 120, rows: 30 };
      await flushMicrotasks();

      expect(trace.at(-1)).toBe("resize:120x30");
      expect(managed.pendingRestoreGeometry).toBeUndefined();
    });

    it("keeps the live grid across a superseding restore instead of adopting the capture width", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      // First restore parks the grid at 80 and never completes (its callback is
      // dropped), leaving terminal.cols describing the payload, not the pane.
      mockTerminal.write.mockImplementationOnce(() => {});
      controller.restoreFromSerialized("t1", "first", captureAt80);
      expect(managed.terminal.cols).toBe(80);

      // The successor must normalize to 170 — the grid the pane actually has —
      // not to the 80 it would read off terminal.cols right now.
      controller.restoreFromSerialized("t1", "second", { cols: 100, rows: 24 });
      await flushMicrotasks();

      expect(managed.terminal.cols).toBe(170);
    });

    it("enables reflowCursorLine only for the corrective resize", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const seenDuringResize: Array<boolean | undefined> = [];
      mockTerminal.resize.mockImplementation((cols: number, rows: number) => {
        mockTerminal.cols = cols;
        mockTerminal.rows = rows;
        seenDuringResize.push(mockTerminal.options.reflowCursorLine);
      });

      controller.restoreFromSerialized("t1", "payload", captureAt80);
      await flushMicrotasks();

      // xterm skips the cursor's own wrapped group unless this is on, which
      // truncates that row when normalizing to a narrower grid.
      expect(seenDuringResize).toEqual([false, true]);
      expect(mockTerminal.options.reflowCursorLine).toBe(false);
    });

    it("restores the configured reflowCursorLine even when the resize throws", async () => {
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      mockTerminal.options.reflowCursorLine = true;
      mockTerminal.resize
        .mockImplementationOnce((cols: number, rows: number) => {
          mockTerminal.cols = cols;
          mockTerminal.rows = rows;
        })
        .mockImplementationOnce(() => {
          throw new Error("renderer gone");
        });

      controller.restoreFromSerialized("t1", "payload", captureAt80);
      await flushMicrotasks();

      expect(mockTerminal.options.reflowCursorLine).toBe(true);
      expect(managed.isSerializedRestoreInProgress).toBe(false);
    });

    it("puts the pane back on its live grid before releasing deferred output", () => {
      const trace = traceGrid();
      const managed = makeManagedTerminal({
        deferredOutput: [{ data: "held", chunkCount: 2 }],
      });
      instances.set("t1", managed);
      mockTerminal.write.mockImplementationOnce(() => {
        throw new Error("parser died");
      });

      const result = controller.restoreFromSerialized("t1", "payload", captureAt80);

      // Held chunks were produced for the live grid — replaying them into a
      // terminal still parked at the capture width would corrupt them too.
      expect(result).toBe(false);
      expect(trace.at(-1)).toBe("resize:170x24");
      expect(writeDataSpy).toHaveBeenCalledWith("t1", "held", 2);
    });

    it("does not let a failing fetch close a window a later restore opened", async () => {
      const { terminalClient } = await import("@/clients");
      let resolveFetch!: (value: SerializedTerminalSnapshot | null) => void;
      vi.mocked(terminalClient.getSerializedState).mockImplementation(
        () => new Promise((resolve) => (resolveFetch = resolve))
      );
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const fetchPromise = controller.fetchAndRestore("t1");
      await flushMicrotasks();

      // A restore starts and takes over the window while the fetch is still
      // waiting on IPC. Its write callback is dropped so it stays mid-replay.
      mockTerminal.write.mockImplementationOnce(() => {});
      controller.restoreFromSerialized("t1", "newer", { cols: 80, rows: 24 });
      expect(managed.isSerializedRestoreInProgress).toBe(true);

      // The fetch now comes back empty. It must not reopen the gate underneath
      // the restore that is still writing.
      resolveFetch(null);
      await fetchPromise;

      expect(managed.isSerializedRestoreInProgress).toBe(true);
    });

    it("does not cancel an in-flight restore just to identify its own window", async () => {
      const { terminalClient } = await import("@/clients");
      vi.mocked(terminalClient.getSerializedState).mockResolvedValue(null);
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const generationBefore = managed.restoreGeneration;
      await controller.fetchAndRestore("t1");

      // Bumping restoreGeneration to claim ownership would abort whatever was
      // replaying — and this fetch had no replacement to put in its place.
      expect(managed.restoreGeneration).toBe(generationBefore);
    });

    it("applies a resize parked mid-replay even when the snapshot needed no alignment", async () => {
      const trace = traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      // Geometry-less snapshot (legacy payload): nothing to align to, so the
      // replay never parks the grid. A resize arriving during the window is
      // still held by resizeTerminal, and dropping it here would leave xterm on
      // the old grid while the PTY had already been told the new one.
      controller.restoreFromSerialized("t1", "payload");
      managed.pendingRestoreGeometry = { cols: 120, rows: 30 };
      await flushMicrotasks();

      expect(trace.at(-1)).toBe("resize:120x30");
      expect(managed.pendingRestoreGeometry).toBeUndefined();
    });

    it("applies a parked resize when the fetched snapshot comes back null", async () => {
      const { terminalClient } = await import("@/clients");
      vi.mocked(terminalClient.getSerializedState).mockResolvedValue(null);
      const trace = traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      const promise = controller.fetchAndRestore("t1");
      managed.pendingRestoreGeometry = { cols: 90, rows: 20 };
      await promise;

      // No restore ran, but the window was open across the IPC round-trip, so
      // whatever it swallowed still has to land.
      expect(trace.at(-1)).toBe("resize:90x20");
      expect(managed.isSerializedRestoreInProgress).toBe(false);
    });

    it("aligns the incremental path and normalizes once every chunk has parsed", async () => {
      const trace = traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2 + 10);

      const promise = controller.restoreFromSerializedIncremental("t1", largeState, captureAt80);
      for (let i = 0; i < 6; i++) {
        await flushMicrotasks();
        await flushScheduler();
      }
      await promise;

      const resizes = trace.filter((entry) => entry.startsWith("resize:"));
      expect(resizes).toEqual(["resize:80x24", "resize:170x24"]);
      // The reflow must come after the last chunk, or it would only see part of
      // the payload laid out at the capture width.
      expect(trace.lastIndexOf("resize:170x24")).toBeGreaterThan(
        trace.map((e) => e.startsWith("write:")).lastIndexOf(true)
      );
    });

    it("leaves the grid to the successor when an incremental restore is superseded", async () => {
      traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);
      const largeState = "x".repeat(INCREMENTAL_RESTORE_CONFIG.chunkBytes * 2 + 10);

      const promise = controller.restoreFromSerializedIncremental("t1", largeState, captureAt80);
      await flushMicrotasks();
      // A newer restore takes ownership mid-replay.
      managed.restoreGeneration++;
      for (let i = 0; i < 6; i++) {
        await flushMicrotasks();
        await flushScheduler();
      }
      await promise;

      // The superseded attempt must not reflow: the successor is mid-replay at
      // its own capture width and owns the grid.
      expect(mockTerminal.resize).toHaveBeenCalledTimes(1);
      expect(mockTerminal.cols).toBe(80);
    });
  });

  describe("destroy", () => {
    it("bumps restore generation and clears restore state", () => {
      const managed = makeManagedTerminal({
        isSerializedRestoreInProgress: true,
        deferredOutput: [{ data: "data", chunkCount: 1 }],
      });
      instances.set("t1", managed);

      const prevGen = managed.restoreGeneration;
      controller.destroy("t1");

      expect(managed.restoreGeneration).toBe(prevGen + 1);
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(managed.pendingRestoreGeometry).toBeUndefined();
      expect(managed.deferredOutput).toHaveLength(0);
    });
  });
});

describe("safeChunkSlice", () => {
  it("returns exactly chunkSize when no surrogate at the boundary", () => {
    const input = "abcdefghij";
    expect(safeChunkSlice(input, 0, 4)).toBe("abcd");
    expect(safeChunkSlice(input, 4, 4)).toBe("efgh");
  });

  it("returns the full remainder when the chunk reaches the end", () => {
    const input = "abcdefghij";
    expect(safeChunkSlice(input, 0, 100)).toBe(input);
    expect(safeChunkSlice(input, 7, 100)).toBe("hij");
  });

  it("returns an empty string when offset is at or past the end", () => {
    const input = "abc";
    expect(safeChunkSlice(input, 3, 8)).toBe("");
    expect(safeChunkSlice(input, 10, 8)).toBe("");
  });

  it("retreats the boundary by one when the last code unit is a high surrogate", () => {
    // "🚀" is U+1F680, encoded in JS strings as two code units (0xD83D, 0xDE80).
    // Build a string where slicing at chunkSize=4 would land between the two halves.
    const input = "ab" + "🚀" + "cd"; // length 6, surrogate pair at indices 2-3
    // chunkSize=3 would slice up to index 3 — last char is high surrogate (0xD83D)
    expect(safeChunkSlice(input, 0, 3)).toBe("ab");
    // The next call from offset 2 should return the full surrogate pair plus more
    expect(safeChunkSlice(input, 2, 3)).toBe("🚀c");
  });

  it("does not retreat when the chunk reaches the very end of the string", () => {
    // Trailing unpaired high surrogate at the end of the string — we keep it
    // rather than emit an empty chunk and stall the caller's loop.
    const input = "ab\uD83D";
    expect(safeChunkSlice(input, 0, 100)).toBe(input);
  });

  it("emits at least one code unit even when an unpaired high surrogate would block progress", () => {
    // Pathological input: chunkSize=1 starting on a high surrogate that is not
    // at end-of-string. Without the floor guard the loop would stall.
    const input = "🚀🚀";
    const chunk = safeChunkSlice(input, 0, 1);
    expect(chunk.length).toBeGreaterThanOrEqual(1);
  });
});

// Real xterm buffers, no DOM: `@xterm/headless` is the same core the pty-host
// mirror runs, so reflow behaviour here is the behaviour that ships. The
// renderer's `@xterm/xterm` needs a live renderer to settle its write queue.
/**
 * Replay fidelity against a real xterm, not a mock (#11552).
 *
 * The contract a snapshot replay owes its caller is that the pane ends up in
 * the state it would have been in had the captured buffer simply been reflowed
 * to the live width. Measured against our pinned xterm, a verbatim
 * wrong-width replay preserves cell content and wrap flags but lands the CURSOR
 * on the wrong column — it re-derives the cursor from where the payload happens
 * to end at the replay width. That is not cosmetic: agent CLIs paint with
 * cursor-relative motion and erase-to-end-of-line, so every repaint after a
 * mis-placed restore writes against the wrong cells, and the damage only clears
 * once the agent redraws the region from scratch.
 *
 * These tests compare a restore against a twin terminal that was reflowed
 * rather than replayed, so they assert the invariant instead of a value copied
 * out of the implementation.
 */
describe("TerminalRestoreController replay fidelity (real xterm)", () => {
  /** Settle xterm's async parser queue. */
  const flush = (terminal: Terminal): Promise<void> =>
    new Promise<void>((resolve) => terminal.write("", () => resolve()));

  const writeAndFlush = (terminal: Terminal, data: string): Promise<void> =>
    new Promise<void>((resolve) => terminal.write(data, () => resolve()));

  function makeTerminal(cols: number, rows: number = 10): Terminal {
    return new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  }

  /** Capture a snapshot the way the pty-host mirror does. */
  async function capture(
    cols: number,
    content: string,
    rows?: number
  ): Promise<{ snapshot: SerializedTerminalSnapshot; source: Terminal }> {
    const source = makeTerminal(cols, rows);
    const addon = new SerializeAddon();
    source.loadAddon(addon);
    await writeAndFlush(source, content);
    return { snapshot: { data: addon.serialize(), cols, rows: source.rows }, source };
  }

  /** The state the captured buffer reaches by reflow alone — the ground truth. */
  async function reflowed(source: Terminal, toCols: number): Promise<Terminal> {
    source.options.reflowCursorLine = true;
    source.resize(toCols, source.rows);
    source.options.reflowCursorLine = false;
    await flush(source);
    return source;
  }

  function readBuffer(terminal: Terminal): string[] {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.length > 0) lines.push(`${line.isWrapped ? "W" : "H"}${text}`);
    }
    return lines;
  }

  const cursorOf = (terminal: Terminal) =>
    `${terminal.buffer.active.cursorX},${terminal.buffer.active.cursorY}`;

  function makeController(
    terminal: Terminal,
    overrides: Partial<ManagedTerminal> = {}
  ): {
    controller: TerminalRestoreController;
    managed: ManagedTerminal;
    writeData: ReturnType<typeof vi.fn>;
  } {
    const managed = {
      terminal,
      writeChain: Promise.resolve(),
      restoreGeneration: 0,
      restoreWindowToken: 0,
      isSerializedRestoreInProgress: false,
      deferredOutput: [],
      isUserScrolledBack: false,
      // Opened: these panes were attached and measured, so `terminal.cols/rows`
      // genuinely describes their grid. Parked panes are the exception and say
      // so explicitly (#11718).
      isOpened: true,
      ...overrides,
    } as unknown as ManagedTerminal;
    const writeData = vi.fn();
    const controller = new TerminalRestoreController({
      getInstance: (id) => (id === "t1" ? managed : undefined),
      writeData,
    });
    return { controller, managed, writeData };
  }

  // No trailing newline: the cursor is parked inside a wrapped group, which is
  // exactly where an agent leaves it between repaints.
  const WRAPPED_LINE = "Tip: press enter and the result will display beneath the input box";

  it.each([
    { label: "widening", captureCols: 40, liveCols: 100, content: WRAPPED_LINE },
    { label: "narrowing", captureCols: 100, liveCols: 40, content: WRAPPED_LINE },
    {
      label: "wide (CJK) cells",
      captureCols: 40,
      liveCols: 100,
      content: "日本語テキストの長い行".repeat(4),
    },
    {
      label: "row filled exactly to the capture width",
      captureCols: 100,
      liveCols: 40,
      content: `${"D".repeat(100)}TAIL`,
    },
  ])(
    "restores the reflow-equivalent buffer and cursor when $label",
    async ({ captureCols, liveCols, content }) => {
      const { snapshot, source } = await capture(captureCols, content);
      const truth = await reflowed(source, liveCols);

      const live = makeTerminal(liveCols);
      const { controller } = makeController(live);
      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      await flush(live);

      expect(live.cols).toBe(liveCols);
      expect(readBuffer(live)).toEqual(readBuffer(truth));
      expect(cursorOf(live)).toBe(cursorOf(truth));
    }
  );

  it("verbatim replay misplaces the cursor — the defect the alignment removes", async () => {
    const { snapshot, source } = await capture(40, WRAPPED_LINE);
    const truth = await reflowed(source, 100);

    // Exactly what the restore path did before the geometry contract existed.
    const verbatim = makeTerminal(100);
    verbatim.reset();
    verbatim.write(snapshot.data);
    await flush(verbatim);

    // Content survives, so a content-only assertion would pass either way and
    // prove nothing — the cursor is what actually diverges.
    expect(readBuffer(verbatim)).toEqual(readBuffer(truth));
    expect(cursorOf(verbatim)).not.toBe(cursorOf(truth));
  });

  it("aligns the incremental path the same way", async () => {
    const bulk = `${WRAPPED_LINE}\r\n`.repeat(40) + WRAPPED_LINE;
    const { snapshot, source } = await capture(40, bulk);
    const truth = await reflowed(source, 100);

    const live = makeTerminal(100);
    const { controller } = makeController(live);
    await controller.restoreFromSerializedIncremental("t1", snapshot.data, snapshot);
    await flush(live);

    expect(live.cols).toBe(100);
    expect(readBuffer(live)).toEqual(readBuffer(truth));
    expect(cursorOf(live)).toBe(cursorOf(truth));
  });

  it("replays a geometry-less snapshot without touching the live grid", async () => {
    const { snapshot } = await capture(40, WRAPPED_LINE);

    const live = makeTerminal(100);
    const { controller } = makeController(live);
    // Pre-#11552 payload: no geometry to align to, so it must behave exactly as
    // it always did rather than refuse the restore and lose the session.
    controller.restoreFromSerialized("t1", snapshot.data);
    await flush(live);

    expect(live.cols).toBe(100);
    expect(readBuffer(live).length).toBeGreaterThan(0);
  });

  /**
   * A parked pane must end a restore on the grid it is really on (#11718).
   *
   * A pane restored into a non-selected worktree is prewarmed but never
   * attached, so nothing fits it — yet it stays content-live and keeps parsing
   * whatever its surviving PTY streams. `terminal.cols/rows` for such a pane is
   * xterm's constructor default, not evidence of anything, and seeding the
   * restore window from it left the pane back at 80×24 after a correctly
   * aligned replay. Every subsequent agent repaint then wrapped into the wrong
   * rows, and because that is committed cell data no later fit or Redraw undoes
   * it — it only clears once new output scrolls it away.
   */
  describe("parked pane geometry", () => {
    const PARKED_COLS = 120;
    const PARKED_ROWS = 30;
    const CAPTURE_COLS = 90;

    // Longer than the 80-column default and shorter than the pane's real grid,
    // so it occupies one row on the real grid and wraps onto a second at the
    // default. Erase-line then only clears the first of those two rows, which
    // is how one repainting status line becomes fragments down the pane.
    const STATUS_LINE = "* Cooking".padEnd(95, ".");

    /** Cursor-addressed repaints, the way an agent CLI emits them. */
    async function streamStatusRepaints(terminal: Terminal): Promise<void> {
      for (let frame = 0; frame < 4; frame++) {
        await writeAndFlush(terminal, `\x1b[1;1H\x1b[2K${STATUS_LINE} ${frame}`);
      }
    }

    it("parses live output at the pane's real grid, not the constructor default", async () => {
      const { snapshot, source } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);

      // Ground truth: the same session on the real grid throughout — what the
      // user would have seen had the view never been evicted.
      const truth = await reflowed(source, PARKED_COLS);
      await streamStatusRepaints(truth);

      // The pane as hydration builds it: prewarmed at xterm's default, never
      // attached, carrying the persisted grid only as an attach target.
      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, {
        isOpened: false,
        targetCols: PARKED_COLS,
        targetRows: PARKED_ROWS,
      });

      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      await flush(live);
      // endRestoreWindow hops out of the write callback via queueMicrotask, so
      // the geometry is only settled one tick after the replay drains.
      await Promise.resolve();

      // Live PTY output arrives long before the user selects this worktree.
      await streamStatusRepaints(live);

      expect(live.cols).toBe(PARKED_COLS);
      expect(readBuffer(live)).toEqual(readBuffer(truth));
      expect(cursorOf(live)).toBe(cursorOf(truth));
    });

    it("falls back to the snapshot's capture grid when the pane has no target", async () => {
      // No persisted size reached this pane, so the grid the mirror and PTY were
      // last agreed on is the best evidence left — still better than a default
      // the pane was never on.
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);

      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, { isOpened: false });

      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(CAPTURE_COLS);
      expect(live.rows).toBe(PARKED_ROWS);
    });

    it("keeps that fallback through fetchAndRestore, the path hydration uses", async () => {
      // fetchAndRestore opens its window BEFORE the snapshot exists, and the
      // nested restore cannot reseed an open window — so a seed computed from
      // capture geometry would never survive this entry point. Expressing "no
      // target" as an absent seed is what makes the two paths agree.
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);
      vi.mocked(terminalClient.getSerializedState).mockResolvedValue(snapshot);

      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, { isOpened: false });

      await controller.fetchAndRestore("t1");
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(CAPTURE_COLS);
      expect(live.rows).toBe(PARKED_ROWS);
    });

    it("prefers the parked target over the capture grid through fetchAndRestore", async () => {
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);
      vi.mocked(terminalClient.getSerializedState).mockResolvedValue(snapshot);

      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, {
        isOpened: false,
        targetCols: PARKED_COLS,
        targetRows: PARKED_ROWS,
      });

      await controller.fetchAndRestore("t1");
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(PARKED_COLS);
    });

    it("applies the parked target on the incremental path too", async () => {
      // Large snapshots take the incremental route, which opens its own window.
      const bulk = `${WRAPPED_LINE}\r\n`.repeat(40) + WRAPPED_LINE;
      const { snapshot } = await capture(CAPTURE_COLS, bulk, PARKED_ROWS);

      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, {
        isOpened: false,
        targetCols: PARKED_COLS,
        targetRows: PARKED_ROWS,
      });

      await controller.restoreFromSerializedIncremental("t1", snapshot.data, snapshot);
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(PARKED_COLS);
      expect(live.rows).toBe(PARKED_ROWS);
    });

    it("ignores a parked target that is not a grid a terminal could have had", async () => {
      // Corrupt or legacy persisted state must not become the pane's grid; the
      // capture grid stands instead.
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);

      const live = makeTerminal(80, 24);
      const { controller } = makeController(live, {
        isOpened: false,
        targetCols: 100_000,
        targetRows: PARKED_ROWS,
      });

      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(CAPTURE_COLS);
    });

    it("keeps a resize that lands mid-replay ahead of the parked target", async () => {
      // The window seed is the only thing that changed: a real resize arriving
      // during the replay still parks into pendingRestoreGeometry and still
      // wins, exactly as before (#11552).
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);

      const live = makeTerminal(80, 24);
      const { controller, managed } = makeController(live, {
        isOpened: false,
        targetCols: PARKED_COLS,
        targetRows: PARKED_ROWS,
      });

      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      managed.pendingRestoreGeometry = { cols: 64, rows: 20 };
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(64);
      expect(live.rows).toBe(20);
    });

    it("leaves an opened pane's live grid authoritative", async () => {
      // An attached pane WAS measured, so its own grid outranks a stale target.
      const { snapshot } = await capture(CAPTURE_COLS, WRAPPED_LINE, PARKED_ROWS);

      const live = makeTerminal(100);
      const { controller } = makeController(live, {
        isOpened: true,
        targetCols: PARKED_COLS,
        targetRows: PARKED_ROWS,
      });

      controller.restoreFromSerialized("t1", snapshot.data, snapshot);
      await flush(live);
      await Promise.resolve();

      expect(live.cols).toBe(100);
    });
  });
  const getSerializedState = vi.mocked(terminalClient.getSerializedState);

  const settle = async (terminal: Terminal): Promise<void> => {
    // A restore hops through a microtask before replaying deferred output, and
    // each replayed write queues behind it.
    for (let i = 0; i < 4; i++) {
      await flush(terminal);
      await Promise.resolve();
    }
  };

  // Every terminal in a scenario — source, destination, reference — shares it.
  let gridScrollback = 200;
  function makeGrid(): Terminal {
    return new Terminal({ cols: 40, rows: 6, scrollback: gridScrollback, allowProposedApi: true });
  }

  function screen(terminal: Terminal): { lines: string[]; cursor: string; fg: number[] } {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    const fg: number[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      lines.push(line.translateToString(true));
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (cell?.getChars()) fg.push(cell.getFgColor());
      }
    }
    return { lines, cursor: `${buffer.cursorX},${buffer.cursorY}`, fg };
  }

  /** The pty-host side: a mirror that has parsed the first `parsed` chunks. */
  async function hostSnapshot(
    chunks: string[],
    parsed: number,
    withContinuation = true
  ): Promise<SerializedTerminalSnapshot> {
    const mirror = makeGrid();
    const addon = new SerializeAddon();
    mirror.loadAddon(addon);
    const tracker = new PartialEscapeTracker();
    let offset = 0;
    for (const chunk of chunks.slice(0, parsed)) {
      await new Promise<void>((resolve) => mirror.write(chunk, resolve));
      tracker.feed(chunk);
      offset += utf8Length(chunk);
    }
    return {
      data: addon.serialize(),
      cols: mirror.cols,
      rows: mirror.rows,
      ...(withContinuation
        ? { continuation: { pendingEscapeTail: tracker.tail, streamOffset: offset } }
        : {}),
    };
  }

  function makePane(terminal: Terminal) {
    const { managed } = makeController(terminal, {
      // Skips the rAF activity-marker refresh, which has no bearing here.
      isAltBuffer: true,
      parserTail: new PartialEscapeTracker(),
    });
    const acks = { port: 0, ipcBytes: 0 };
    const writer = new TerminalWriteController({
      getInstance: (id) => (id === "t1" ? managed : undefined),
      acknowledgePortData: (_id, _bytes, chunkCount) => {
        acks.port += chunkCount;
      },
      acknowledgeData: (_id, bytes) => {
        acks.ipcBytes += bytes;
      },
      notifyWriteComplete: vi.fn(),
      incrementUnseen: vi.fn(),
    });
    const restorer = new TerminalRestoreController({
      getInstance: (id) => (id === "t1" ? managed : undefined),
      writeData: (id, data, chunkCount, range) => writer.write(id, data, chunkCount, range),
    });
    const stream = { end: 0 };
    // What the ingest path does per delivered chunk: stamp its stream range at
    // receipt, then hand it to the write controller.
    const deliver = (chunk: string, asBytes = false): void => {
      stream.end += utf8Length(chunk);
      // Port chunks arrive as UTF-8 bytes, IPC chunks as strings.
      const data = asBytes ? new TextEncoder().encode(chunk) : chunk;
      writer.write("t1", data, 1, streamRangeOf(data, stream.end));
    };
    return { managed, restorer, deliver, acks, stream };
  }

  async function uninterrupted(chunks: string[]): Promise<ReturnType<typeof screen>> {
    const terminal = makeGrid();
    for (const chunk of chunks) terminal.write(chunk);
    await flush(terminal);
    return screen(terminal);
  }

  /**
   * The renderer painted `painted` chunks live, then a fetch-and-restore opened
   * its window; every later chunk arrives during the fetch. The host serialized
   * after parsing `parsed` of them, so chunks `painted..parsed` are delivered
   * but already in the snapshot.
   */
  async function restoreMidStream(
    chunks: string[],
    painted: number,
    parsed: number,
    options: { withContinuation?: boolean; lateChunks?: number; asBytes?: boolean } = {}
  ): Promise<{ result: ReturnType<typeof screen>; acks: { port: number; ipcBytes: number } }> {
    const terminal = makeGrid();
    const pane = makePane(terminal);
    const late = options.lateChunks ?? 0;
    const deliver = (chunk: string) => pane.deliver(chunk, options.asBytes);
    for (const chunk of chunks.slice(0, painted)) deliver(chunk);
    await flush(terminal);

    const snapshot = await hostSnapshot(chunks, parsed, options.withContinuation ?? true);
    getSerializedState.mockImplementationOnce(async () => {
      for (const chunk of chunks.slice(painted, chunks.length - late)) deliver(chunk);
      return snapshot;
    });
    await pane.restorer.fetchAndRestore("t1");
    await settle(terminal);
    for (const chunk of chunks.slice(chunks.length - late)) deliver(chunk);
    await settle(terminal);
    return { result: screen(terminal), acks: pane.acks };
  }

  const SPLITS: Record<string, string[]> = {
    "CSI SGR": ["hello \x1b[3", "1mRED", " done"],
    "OSC title": ["hello \x1b]0;ti", "tle\x07world", "!"],
    "lone ESC": ["hello \x1b", "[31mRED", " done"],
    "cursor position": ["hello \x1b[2;", "3Hworld", "!"],
  };

  describe("fetch-and-restore across a split escape sequence (#12791)", () => {
    beforeEach(() => {
      getSerializedState.mockReset();
      gridScrollback = 200;
    });

    for (const [name, chunks] of Object.entries(SPLITS)) {
      it(`renders a ${name} split the same as uninterrupted playback`, async () => {
        const expected = await uninterrupted(chunks);
        // Snapshot cut right after the chunk that ends mid-sequence, with that
        // chunk either painted before the fetch or held back during it.
        for (const painted of [0, 1]) {
          const { result } = await restoreMidStream(chunks, painted, 1);
          expect(result, `painted=${painted}`).toEqual(expected);
        }
      });
    }

    it("drops held-back chunks the snapshot already contains instead of repeating them", async () => {
      const chunks = ["one\r\n", "two\r\n", "three\r\n", "four\r\n"];
      const expected = await uninterrupted(chunks);
      for (let parsed = 0; parsed <= chunks.length; parsed++) {
        const { result } = await restoreMidStream(chunks, 0, parsed);
        expect(result, `parsed=${parsed}`).toEqual(expected);
      }
    });

    it("repeats held-back chunks when the snapshot carries no fence (the defect)", async () => {
      const chunks = ["one\r\n", "two\r\n", "three\r\n"];
      const { result } = await restoreMidStream(chunks, 0, 2, { withContinuation: false });
      expect(result).not.toEqual(await uninterrupted(chunks));
    });

    it("drops a covered chunk that lands after the replay has finished", async () => {
      const chunks = ["hello \x1b[3", "1mRED", " done"];
      const { result } = await restoreMidStream(chunks, 0, 2, { lateChunks: 2 });
      expect(result).toEqual(await uninterrupted(chunks));
    });

    it("settles every held-back chunk's ledger exactly once, painted or not", async () => {
      const chunks = ["a", "b", "c", "d", "e"];
      const { acks } = await restoreMidStream(chunks, 1, 3);
      expect(acks.port).toBe(chunks.length);
      expect(acks.ipcBytes).toBe(chunks.join("").length);
    });

    it("trims a held-back batch that straddles the snapshot's offset", async () => {
      const chunks = ["ōne ", "twö 😀 ", "three"];
      const terminal = makeGrid();
      const pane = makePane(terminal);
      const snapshot = await hostSnapshot(chunks, 1);
      getSerializedState.mockImplementationOnce(async () => {
        // The ingest queue coalesced the first two chunks into one batch.
        const batch = chunks[0]! + chunks[1]!;
        pane.stream.end = utf8Length(batch);
        const range = streamRangeOf(batch, pane.stream.end);
        pane.managed.deferredOutput.push({ data: batch, chunkCount: 2, range });
        return snapshot;
      });
      await pane.restorer.fetchAndRestore("t1");
      await settle(terminal);
      pane.deliver(chunks[2]!);
      await settle(terminal);
      expect(screen(terminal)).toEqual(await uninterrupted(chunks));
    });

    it("fences port-delivered byte chunks the same way", async () => {
      for (const chunks of Object.values(SPLITS)) {
        const expected = await uninterrupted(chunks);
        const { result } = await restoreMidStream(chunks, 0, 2, { asBytes: true });
        expect(result).toEqual(expected);
      }
    });

    it("restores a split through the incremental path for a large snapshot", async () => {
      gridScrollback = 12000;
      const filler = Array.from({ length: 11000 }, (_, i) => `line ${i} ${"x".repeat(24)}\r\n`);
      const chunks = [filler.join(""), "tail \x1b[3", "1mRED"];
      const snapshot = await hostSnapshot(chunks, 2);
      expect(snapshot.data.length).toBeGreaterThan(
        INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes
      );
      const expected = await uninterrupted(chunks);
      const { result } = await restoreMidStream(chunks, 0, 2);
      expect(result).toEqual(expected);
    });

    it("applies an empty screen when the source is only mid-sequence", async () => {
      const chunks = ["\x1b[3", "1mRED"];
      const { result } = await restoreMidStream(chunks, 0, 1);
      expect(result).toEqual(await uninterrupted(chunks));
    });

    it("swallows the rest of a sequence too long to carry instead of printing it", async () => {
      const chunks = ["hi \x1b]52;c;" + "QUFB".repeat(20000), "QUFB\x07world"];
      const { result } = await restoreMidStream(chunks, 0, 1);
      expect(result).toEqual(await uninterrupted(chunks));
    });

    it("grounds a destination parser left mid-sequence before the snapshot lands", async () => {
      const chunks = ["prompt$ "];
      const terminal = makeGrid();
      const pane = makePane(terminal);
      // A stale live write left the pane inside an OSC string, which would eat
      // everything up to the next BEL without the leading CAN.
      terminal.write("\x1b]0;stale");
      await flush(terminal);
      getSerializedState.mockResolvedValueOnce(await hostSnapshot(chunks, 1));
      await pane.restorer.fetchAndRestore("t1");
      await settle(terminal);
      expect(screen(terminal).lines[0]?.trimEnd()).toBe("prompt$");
    });
  });

  describe("host reset", () => {
    it("clears a visible screen when the reset carries no snapshot", async () => {
      const live = makeTerminal(40, 5);
      await writeAndFlush(live, "OLD SCREEN");
      const { controller, managed } = makeController(live);

      await controller.applyReset("t1", "", { cols: 40, rows: 5 });
      await flush(live);
      await Promise.resolve();

      expect(readBuffer(live)).toEqual([]);
      expect(managed.isSerializedRestoreInProgress).toBe(false);
    });

    it("forgets the previous stream fence, since a reset starts the host's stream over", async () => {
      const live = makeTerminal(40, 5);
      const { controller, managed } = makeController(live);
      managed.streamFence = 5000;

      await controller.applyReset("t1", null, { cols: 40, rows: 5 });
      await flush(live);

      expect(managed.streamFence).toBeUndefined();
    });

    it("a null reset supersedes a paused incremental restore and releases later output", async () => {
      const live = makeTerminal(40, 5);
      await writeAndFlush(live, "OLD SCREEN");
      const { controller, managed, writeData } = makeController(live);

      // Hold the incremental restore between its first and second chunk.
      let releaseYield!: () => void;
      const yieldGate = new Promise<void>((resolve) => (releaseYield = resolve));
      let paused!: () => void;
      const pausedAtYield = new Promise<void>((resolve) => (paused = resolve));
      Reflect.set(controller, "yieldToUI", () => {
        paused();
        return yieldGate;
      });

      const large = "STALE-RESTORE\r\n".repeat(30_000);
      const incremental = controller.restoreFromSerializedIncremental("t1", large);
      await pausedAtYield;

      void controller.applyReset("t1", null);
      // Output that arrived after the reset, held while its window is open.
      managed.deferredOutput.push({ data: "LIVE", chunkCount: 1, ackGeneration: 1 });

      await flush(live);
      await Promise.resolve();
      releaseYield();
      await expect(incremental).resolves.toBe(false);
      await flush(live);

      expect(readBuffer(live)).toEqual([]);
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(writeData).toHaveBeenCalledWith("t1", "LIVE", 1, undefined, 1);
      expect(managed.deferredOutput).toEqual([]);
    });
  });
});
