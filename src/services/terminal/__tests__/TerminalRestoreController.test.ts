import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalRestoreController, safeChunkSlice } from "../TerminalRestoreController";
import { INCREMENTAL_RESTORE_CONFIG, type ManagedTerminal } from "../types";
import type { SerializedTerminalSnapshot } from "@shared/types/terminal";

/** Wrap a payload in the snapshot envelope the IPC now returns (#11552). */
function snapshot(
  data: string,
  cols = 80,
  rows = 24
): SerializedTerminalSnapshot {
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
      expect(totalWritten).toBe(largeState.length);
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
      expect(totalWritten).toBe(data.length);
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
      const totalWritten = chunks.reduce((sum: number, c: string) => sum + c.length, 0);
      expect(totalWritten).toBe(state.length);
      expect((chunks as string[]).join("")).toBe(state);

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
      expect(trace).toEqual(["reset", "resize:80x24", "write:payload", "resize:170x24"]);
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
      expect(mockTerminal.write).toHaveBeenCalledWith("payload", expect.any(Function));
    });

    it("refuses a geometry no terminal could have been captured at", async () => {
      traceGrid();
      const managed = makeManagedTerminal();
      instances.set("t1", managed);

      controller.restoreFromSerialized("t1", "payload", { cols: 0, rows: -4 });
      await flushMicrotasks();

      expect(mockTerminal.resize).not.toHaveBeenCalled();
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
