import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";

const { resizeMock, getEffectiveAgentConfigMock } = vi.hoisted(() => ({
  resizeMock: vi.fn(),
  getEffectiveAgentConfigMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: resizeMock,
  },
}));

vi.mock("@shared/config/agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/config/agentRegistry")>();
  return {
    ...actual,
    getEffectiveAgentConfig: getEffectiveAgentConfigMock,
  };
});

import {
  TerminalResizeController,
  getXtermCellDimensions,
  type ResizeControllerDeps,
} from "../TerminalResizeController";

function createManagedTerminal() {
  const terminal = {
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        baseY: 0,
        viewportY: 0,
        length: 20,
      },
    },
    resize: vi.fn(function (this: { cols: number; rows: number }, cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }),
    write: vi.fn(),
  } as unknown as {
    cols: number;
    rows: number;
    buffer: { active: { baseY: number; viewportY: number; length: number } };
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  return {
    terminal,
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 100, rows: 30 })),
    },
    hostElement: {
      style: { width: "100%" },
      checkVisibility: vi.fn(() => true),
      getBoundingClientRect: vi.fn(() => ({ left: 0, width: 1000, height: 700 })),
      querySelector: vi.fn(() => null),
    } as unknown as HTMLDivElement,
    isFocused: true,
    isVisible: true,
    lastAppliedTier: TerminalRefreshTier.FOCUSED,
    getRefreshTier: vi.fn(() => TerminalRefreshTier.FOCUSED),
    lastWidth: 800,
    lastHeight: 600,
    resizeJob: undefined,
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    isUserScrolledBack: false,
    isAltBuffer: false,
  } as any;
}

describe("TerminalResizeController", () => {
  let postTaskCallbacks: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    postTaskCallbacks = [];

    vi.stubGlobal("scheduler", {
      postTask: vi.fn((cb: () => unknown, opts?: { signal?: AbortSignal }) => {
        return new Promise<unknown>((resolve, reject) => {
          if (opts?.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          postTaskCallbacks.push(() => {
            if (opts?.signal?.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            try {
              resolve(cb());
            } catch (e) {
              reject(e);
            }
          });
        });
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    postTaskCallbacks = [];
  });

  const flushPostTasks = async () => {
    const callbacks = [...postTaskCallbacks];
    postTaskCallbacks = [];
    callbacks.forEach((cb) => cb());
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  };

  it("skips resize in background tier when terminal is unfocused", () => {
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    const result = controller.resize("term-1", 1200, 900);
    expect(result).toBeNull();
    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("flushes and resets ingest buffers before applying resize", () => {
    const managed = createManagedTerminal();
    const flushForTerminal = vi.fn();
    const resetForTerminal = vi.fn();
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal,
        resetForTerminal,
      } as any,
    });

    controller.applyResize("term-1", 132, 41);

    expect(flushForTerminal).toHaveBeenCalledWith("term-1");
    expect(resetForTerminal).toHaveBeenCalledWith("term-1");
    expect(managed.terminal.resize).toHaveBeenCalledWith(132, 41);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 132, 41);
  });

  it("does not apply deferred resize while resize lock is active", () => {
    const managed = createManagedTerminal();
    managed.latestCols = 120;
    managed.latestRows = 40;

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    controller.lockResize("term-1", true);
    controller.applyDeferredResize("term-1");

    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("does not run fit while resize lock is active", () => {
    const managed = createManagedTerminal();
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    controller.lockResize("term-1", true);
    const result = controller.fit("term-1");

    expect(result).toBeNull();
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("fit() returns null without calling getBoundingClientRect when checkVisibility returns false", () => {
    const managed = createManagedTerminal();
    (managed.hostElement.checkVisibility as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    const result = controller.fit("term-1");
    expect(result).toBeNull();
    expect(managed.hostElement.getBoundingClientRect).not.toHaveBeenCalled();
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
  });

  it("fit() returns null when visible but dimensions are too small", () => {
    const managed = createManagedTerminal();
    (managed.hostElement.getBoundingClientRect as ReturnType<typeof vi.fn>).mockReturnValue({
      left: 0,
      width: 40,
      height: 30,
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    const result = controller.fit("term-1");
    expect(result).toBeNull();
    expect(managed.hostElement.checkVisibility).toHaveBeenCalled();
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
  });

  it("fit() succeeds when visible and dimensions are adequate", () => {
    const managed = createManagedTerminal();

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    const result = controller.fit("term-1");
    expect(result).not.toBeNull();
    expect(managed.hostElement.checkVisibility).toHaveBeenCalled();
    expect(managed.fitAddon.fit).toHaveBeenCalled();
    expect(resizeMock).toHaveBeenCalledWith("term-1", managed.terminal.cols, managed.terminal.rows);
  });

  it("settled strategy batches rapid resizes into a single PTY resize", () => {
    const managed = createManagedTerminal();
    managed.agentId = "codex";

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    controller.sendPtyResize("term-1", 100, 30);
    controller.sendPtyResize("term-1", 110, 35);
    controller.sendPtyResize("term-1", 120, 40);

    expect(resizeMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 120, 40);
    expect(managed.terminal.write).not.toHaveBeenCalled();
  });

  it("default strategy sends PTY resize immediately", () => {
    const managed = createManagedTerminal();
    managed.agentId = "claude";

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "default" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    controller.sendPtyResize("term-1", 100, 30);

    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
  });

  it("clearSettledTimer cancels a pending settled resize", () => {
    const managed = createManagedTerminal();
    managed.agentId = "codex";

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    controller.sendPtyResize("term-1", 120, 40);
    expect(resizeMock).not.toHaveBeenCalled();

    controller.clearSettledTimer("term-1");
    vi.advanceTimersByTime(500);

    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("forceImmediateResize sends an immediate resize and cancels pending settled timer", () => {
    const managed = createManagedTerminal();
    managed.agentId = "codex";
    managed.latestCols = 132;
    managed.latestRows = 41;
    const dataBuffer = {
      flushForTerminal: vi.fn(),
      resetForTerminal: vi.fn(),
    } as unknown as ResizeControllerDeps["dataBuffer"];

    getEffectiveAgentConfigMock.mockReturnValue({
      capabilities: { resizeStrategy: "settled" },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer,
    });

    controller.sendPtyResize("term-1", 100, 30);
    expect(resizeMock).not.toHaveBeenCalled();

    controller.forceImmediateResize("term-1");
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 132, 41);

    vi.advanceTimersByTime(500);
    expect(resizeMock).toHaveBeenCalledTimes(1);
  });

  it("forceImmediateResize skips invalid terminal dimensions", () => {
    const managed = createManagedTerminal();
    managed.latestCols = 0;
    managed.latestRows = 24;
    const dataBuffer = {
      flushForTerminal: vi.fn(),
      resetForTerminal: vi.fn(),
    } as unknown as ResizeControllerDeps["dataBuffer"];

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer,
    });

    controller.forceImmediateResize("term-1");

    expect(resizeMock).not.toHaveBeenCalled();
  });

  describe("getXtermCellDimensions", () => {
    function fakeTerminal(core?: unknown) {
      const t = {} as Record<string, unknown>;
      if (core !== undefined) t._core = core;
      return t as unknown as import("@xterm/xterm").Terminal;
    }

    it("returns cell dimensions when internal structure is populated", () => {
      const terminal = fakeTerminal({
        _renderService: {
          dimensions: { css: { cell: { width: 8.5, height: 17 } } },
        },
      });

      expect(getXtermCellDimensions(terminal)).toEqual({
        width: 8.5,
        height: 17,
      });
    });

    it("returns null when _core is undefined", () => {
      expect(getXtermCellDimensions(fakeTerminal())).toBeNull();
    });

    it("returns null when _renderService is undefined", () => {
      expect(getXtermCellDimensions(fakeTerminal({}))).toBeNull();
    });

    it("returns null when cell dimensions have non-number values", () => {
      const terminal = fakeTerminal({
        _renderService: {
          dimensions: {
            css: { cell: { width: "bad", height: "data" } },
          },
        },
      });

      expect(getXtermCellDimensions(terminal)).toBeNull();
    });

    it("returns null when accessing _core throws", () => {
      const terminal = {} as Record<string, unknown>;
      Object.defineProperty(terminal, "_core", {
        get() {
          throw new Error("exploded");
        },
      });

      expect(
        getXtermCellDimensions(terminal as unknown as import("@xterm/xterm").Terminal)
      ).toBeNull();
    });

    it("returns null for NaN dimensions", () => {
      expect(
        getXtermCellDimensions(
          fakeTerminal({
            _renderService: { dimensions: { css: { cell: { width: NaN, height: 17 } } } },
          })
        )
      ).toBeNull();
    });

    it("returns null for negative dimensions", () => {
      expect(
        getXtermCellDimensions(
          fakeTerminal({
            _renderService: { dimensions: { css: { cell: { width: 8, height: -1 } } } },
          })
        )
      ).toBeNull();
    });

    it("returns null for Infinity dimensions", () => {
      expect(
        getXtermCellDimensions(
          fakeTerminal({
            _renderService: { dimensions: { css: { cell: { width: Infinity, height: 17 } } } },
          })
        )
      ).toBeNull();
    });

    it("returns null when intermediate levels are null", () => {
      expect(
        getXtermCellDimensions(
          fakeTerminal({
            _renderService: { dimensions: { css: null } },
          })
        )
      ).toBeNull();
      expect(
        getXtermCellDimensions(
          fakeTerminal({
            _renderService: { dimensions: null },
          })
        )
      ).toBeNull();
    });
  });

  describe("scheduleIdleResize and clearResizeJob", () => {
    function mockDataBuffer(): ResizeControllerDeps["dataBuffer"] {
      return {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"];
    }

    function attachCellDims(
      managed: ReturnType<typeof createManagedTerminal>,
      cell: { width: number; height: number } = { width: 10, height: 20 }
    ) {
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell } } } },
      });
    }

    it("scheduleIdleResize stores an AbortController on managed.resizeJob", () => {
      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 900);

      expect(managed.resizeJob).toBeInstanceOf(AbortController);
      expect((global as any).scheduler.postTask).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ priority: "background" })
      );
    });

    it("clearResizeJob aborts the AbortController and prevents the task from running", async () => {
      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;

      const dataBuffer = mockDataBuffer();
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer,
      });

      controller.resize("term-1", 1200, 900);

      const abortController = managed.resizeJob as AbortController;
      expect(abortController).toBeInstanceOf(AbortController);
      expect(abortController.signal.aborted).toBe(false);

      controller.clearResizeJob(managed);

      expect(abortController.signal.aborted).toBe(true);
      expect(managed.resizeJob).toBeUndefined();

      // Task in queue should not run since signal is aborted
      await flushPostTasks();
      expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
      expect(managed.terminal.resize).not.toHaveBeenCalled();
    });

    it("flushResize applies resize when resizeJob is pending", async () => {
      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;
      managed.latestCols = 100;
      managed.latestRows = 30;

      const dataBuffer = mockDataBuffer();
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer,
      });

      controller.resize("term-1", 1200, 900);
      expect(managed.resizeJob).toBeInstanceOf(AbortController);

      controller.flushResize("term-1");

      expect(managed.resizeJob).toBeUndefined();
      expect(dataBuffer.flushForTerminal).toHaveBeenCalled();
      expect(dataBuffer.resetForTerminal).toHaveBeenCalled();
    });

    it("flushResize applies resize when resizeDebounceTimer is pending", () => {
      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = true;
      managed.terminal.buffer.active.length = 300;
      managed.latestCols = 100;
      managed.latestRows = 30;

      const dataBuffer = mockDataBuffer();
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer,
      });

      controller.resize("term-1", 1200, 900);
      expect(managed.resizeDebounceTimer).toBeDefined();

      controller.flushResize("term-1");

      expect(managed.resizeDebounceTimer).toBeUndefined();
      expect(dataBuffer.flushForTerminal).toHaveBeenCalled();
    });

    it("debounceResize stores timer in resizeDebounceTimer, not resizeJob", () => {
      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = true;
      managed.terminal.buffer.active.length = 300;

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 900);

      expect(managed.resizeJob).toBeUndefined();
      expect(managed.resizeDebounceTimer).toBeDefined();
    });

    it("scheduleIdleResize falls back to setTimeout when scheduler is unavailable", () => {
      (global as any).scheduler = undefined;

      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 900);

      expect(managed.resizeJob).toBeUndefined();
      expect(managed.resizeDebounceTimer).toBeDefined();
    });

    it("scheduleIdleResize does not queue a second timer when fallback timer already pending", () => {
      (global as any).scheduler = undefined;

      const managed = createManagedTerminal();
      attachCellDims(managed);
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      controller.resize("term-1", 1200, 900);
      const firstTimerCount = setTimeoutSpy.mock.calls.length;

      // Second resize while timer pending — should not queue another timer
      controller.resize("term-1", 1300, 950);
      expect(setTimeoutSpy.mock.calls.length).toBe(firstTimerCount);
    });

    it("postTask callback applies resize and clears resizeJob", async () => {
      const managed = createManagedTerminal();
      attachCellDims(managed); // width:10, height:20 → 1200/10=120 cols, 900/20=45 rows
      managed.isFocused = false;
      managed.isVisible = false;
      managed.terminal.buffer.active.length = 300;

      const dataBuffer = mockDataBuffer();
      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer,
      });

      controller.resize("term-1", 1200, 900);
      expect(managed.resizeJob).toBeInstanceOf(AbortController);

      await flushPostTasks();

      expect(managed.resizeJob).toBeUndefined();
      expect(dataBuffer.flushForTerminal).toHaveBeenCalledWith("term-1");
      expect(managed.terminal.resize).toHaveBeenCalledWith(120, 45);
    });
  });

  describe("resize cell-dimension paths", () => {
    function mockDataBuffer(): ResizeControllerDeps["dataBuffer"] {
      return {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as unknown as ResizeControllerDeps["dataBuffer"];
    }

    function attachCellDims(
      managed: ReturnType<typeof createManagedTerminal>,
      cell: { width: number; height: number }
    ) {
      Object.assign(managed.terminal, {
        _core: {
          _renderService: { dimensions: { css: { cell } } },
        },
      });
    }

    it("computes cols/rows from cell dims without calling fitAddon.fit()", () => {
      const managed = createManagedTerminal();
      attachCellDims(managed, { width: 10, height: 20 });

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const result = controller.resize("term-1", 1000, 500);

      expect(result).toEqual({ cols: 100, rows: 25 });
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 25);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 25);
    });

    it("falls back to fitAddon.fit() when cell dims are null", () => {
      const managed = createManagedTerminal();

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const result = controller.resize("term-1", 1200, 900);

      expect(result).not.toBeNull();
      expect(managed.fitAddon.fit).toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledWith(
        "term-1",
        managed.terminal.cols,
        managed.terminal.rows
      );
    });

    it("falls back to fitAddon.fit() when cell dims are zero", () => {
      const managed = createManagedTerminal();
      attachCellDims(managed, { width: 0, height: 0 });

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const result = controller.resize("term-1", 1200, 900);

      expect(result).not.toBeNull();
      expect(managed.fitAddon.fit).toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledWith(
        "term-1",
        managed.terminal.cols,
        managed.terminal.rows
      );
    });
  });
});
