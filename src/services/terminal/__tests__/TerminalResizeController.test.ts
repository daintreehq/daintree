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
  REVEAL_REWRAP_QUIESCENT_MS,
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
    scrollToBottom: vi.fn(),
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

  it("background-tier resize captures dims and notifies PTY without calling fitAddon.fit()", () => {
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    const result = controller.resize("term-1", 1600, 800);
    expect(result).toEqual({ cols: 160, rows: 40 });
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    // Buffer reflow is deferred to wake — xterm.resize() must NOT fire while paint is paused.
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(resizeMock).toHaveBeenCalledWith("term-1", 160, 40);
    expect(managed.latestCols).toBe(160);
    expect(managed.latestRows).toBe(40);
    expect(managed.lastWidth).toBe(1600);
    expect(managed.lastHeight).toBe(800);
  });

  it("background-tier resize returns null when cell dims are unavailable", () => {
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    // No _core attached — cellDims will be null.

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    const result = controller.resize("term-1", 1600, 800);
    expect(result).toBeNull();
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
    // Dedup cache must not be touched on a no-op early return.
    expect(managed.lastWidth).toBe(800);
    expect(managed.lastHeight).toBe(600);
  });

  it("background-tier resize dedups identical follow-up call without re-notifying PTY", () => {
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    controller.resize("term-1", 1600, 800);
    expect(resizeMock).toHaveBeenCalledTimes(1);

    // Same pixel dims → dedup guard returns null before any side effects.
    const second = controller.resize("term-1", 1600, 800);
    expect(second).toBeNull();
    expect(resizeMock).toHaveBeenCalledTimes(1);
  });

  it("background-tier settled agents batch the deferred PTY resize", () => {
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = false;
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

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

    controller.resize("term-1", 1600, 800);
    controller.resize("term-1", 1700, 800);
    // PTY should not fire synchronously — settled 500ms guard owns the resize.
    expect(resizeMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 170, 40);
  });

  it("background-tier resize reflows xterm when the terminal is visible", () => {
    // A freshly prewarmed terminal carries lastAppliedTier === BACKGROUND until
    // applyRendererPolicy promotes it, but it can already be attached and
    // visible on screen. A visible terminal must keep xterm's grid in sync with
    // its container — the deferred-reflow path is only for genuinely hidden
    // (offscreen / content-visibility:hidden) terminals. Regression guard for
    // the two-pane split second-panel sizing bug.
    const managed = createManagedTerminal();
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    managed.isVisible = true;
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    const result = controller.resize("term-1", 1600, 800, { immediate: true });
    expect(result).toEqual({ cols: 160, rows: 40 });
    // Visible terminal: xterm's grid is reflowed, not deferred to wake.
    expect(managed.terminal.resize).toHaveBeenCalledWith(160, 40);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 160, 40);
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

  it("lockResize with custom TTL expires after specified duration", () => {
    const managed = createManagedTerminal();
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    controller.lockResize("term-1", true, 300);
    expect(controller.isResizeLocked("term-1")).toBe(true);

    vi.advanceTimersByTime(200);
    expect(controller.isResizeLocked("term-1")).toBe(true);

    vi.advanceTimersByTime(200);
    expect(controller.isResizeLocked("term-1")).toBe(false);
  });

  it("later lockResize call overwrites earlier TTL", () => {
    const managed = createManagedTerminal();
    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    controller.lockResize("term-1", true, 500);
    controller.lockResize("term-1", true, 200);

    vi.advanceTimersByTime(300);
    expect(controller.isResizeLocked("term-1")).toBe(false);
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

  it("applyDeferredResize is a no-op when xterm dims already match latest", () => {
    const managed = createManagedTerminal();
    managed.terminal.cols = 120;
    managed.terminal.rows = 40;
    managed.latestCols = 120;
    managed.latestRows = 40;

    const controller = new TerminalResizeController({
      getInstance: vi.fn(() => managed),
      dataBuffer: {
        flushForTerminal: vi.fn(),
        resetForTerminal: vi.fn(),
      } as any,
    });

    controller.applyDeferredResize("term-1");

    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("applyDeferredResize syncs xterm and PTY atomically for settled-strategy agents", () => {
    const managed = createManagedTerminal();
    managed.terminal.cols = 80;
    managed.terminal.rows = 24;
    managed.latestCols = 160;
    managed.latestRows = 40;
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";

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

    controller.applyDeferredResize("term-1");

    // Wake-path resync must NOT split xterm and PTY across the 500ms settled
    // window — both must fire synchronously so refresh paints a coherent grid.
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(managed.terminal.resize).toHaveBeenCalledWith(160, 40);
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledWith("term-1", 160, 40);

    // Advancing past the settled delay must not produce a spurious second resize.
    vi.advanceTimersByTime(500);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledTimes(1);
  });

  it("applyDeferredResize cancels a pending settled timer before atomic resync", () => {
    const managed = createManagedTerminal();
    managed.terminal.cols = 80;
    managed.terminal.rows = 24;
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";
    Object.assign(managed.terminal, {
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    });

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

    // Background resize arms the settled timer with dims 120x35.
    managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
    managed.isFocused = false;
    controller.resize("term-1", 1200, 700);
    expect(resizeMock).not.toHaveBeenCalled();

    // Wake fires applyDeferredResize before the timer would have run.
    managed.lastAppliedTier = TerminalRefreshTier.FOCUSED;
    managed.isFocused = true;
    controller.applyDeferredResize("term-1");

    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledTimes(1);

    // Pending settled timer must have been cancelled — no second fire.
    vi.advanceTimersByTime(500);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledTimes(1);
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
      } as unknown as ResizeControllerDeps["dataBuffer"],
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
      } as unknown as ResizeControllerDeps["dataBuffer"],
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
      } as unknown as ResizeControllerDeps["dataBuffer"],
    });

    const result = controller.fit("term-1");
    expect(result).not.toBeNull();
    expect(managed.hostElement.checkVisibility).toHaveBeenCalled();
    expect(managed.fitAddon.fit).toHaveBeenCalled();
    expect(resizeMock).toHaveBeenCalledWith("term-1", managed.terminal.cols, managed.terminal.rows);
  });

  it("settled strategy batches rapid resizes into a single PTY resize", () => {
    const managed = createManagedTerminal();
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";

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
    managed.launchAgentId = "claude";
    managed.runtimeAgentId = "claude";

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
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";

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
    managed.launchAgentId = "codex";
    managed.runtimeAgentId = "codex";
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

    it("returns null without mutating cache when proposeDimensions returns undefined", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions.mockReturnValue(undefined);

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const result = controller.resize("term-1", 1200, 900);

      expect(result).toBeNull();
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.lastWidth).toBe(800);
      expect(managed.lastHeight).toBe(600);
    });

    it("does not suppress later resize after proposeDimensions initially returns undefined", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions.mockReturnValue(undefined);

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      // First call: proposeDimensions undefined → null, cache unchanged
      const result1 = controller.resize("term-1", 1200, 900);
      expect(result1).toBeNull();
      expect(managed.lastWidth).toBe(800);
      expect(managed.lastHeight).toBe(600);

      // Second call: proposeDimensions now returns valid result
      managed.fitAddon.proposeDimensions.mockReturnValue({ cols: 120, rows: 45 });
      const result2 = controller.resize("term-1", 1200, 900);

      // Should NOT be suppressed by dedup guard since lastWidth was never updated
      expect(result2).not.toBeNull();
      expect(managed.fitAddon.fit).toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledWith(
        "term-1",
        managed.terminal.cols,
        managed.terminal.rows
      );
    });

    it("returns null when proposeDimensions returns degenerate 1x1", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions.mockReturnValue({ cols: 1, rows: 1 });

      const controller = new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: mockDataBuffer(),
      });

      const result = controller.resize("term-1", 1200, 900);

      expect(result).toBeNull();
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
    });
  });

  describe("resizePtyOnly", () => {
    function makeController(managed: ReturnType<typeof createManagedTerminal> | undefined) {
      return new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: {
          flushForTerminal: vi.fn(),
          resetForTerminal: vi.fn(),
        } as any,
      });
    }

    it("resizes the PTY without reflowing xterm, even for a visible focused terminal", () => {
      const managed = createManagedTerminal();
      managed.isFocused = true;
      managed.isVisible = true;
      managed.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });

      const controller = makeController(managed);
      const result = controller.resizePtyOnly("term-1", 1600, 800);

      expect(result).toEqual({ cols: 160, rows: 40 });
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledWith("term-1", 160, 40);
      expect(managed.latestCols).toBe(160);
      expect(managed.latestRows).toBe(40);
      expect(managed.lastWidth).toBe(1600);
      expect(managed.lastHeight).toBe(800);
    });

    it("returns null for a missing instance", () => {
      const controller = makeController(undefined);
      expect(controller.resizePtyOnly("term-1", 1600, 800)).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("respects an active resize lock", () => {
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const controller = makeController(managed);
      controller.lockResize("term-1", true);

      expect(controller.resizePtyOnly("term-1", 1600, 800)).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("dedups when pixel dimensions are unchanged", () => {
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const controller = makeController(managed);

      controller.resizePtyOnly("term-1", 1600, 800);
      expect(resizeMock).toHaveBeenCalledTimes(1);

      expect(controller.resizePtyOnly("term-1", 1600, 800)).toBeNull();
      expect(resizeMock).toHaveBeenCalledTimes(1);
    });

    it("updates pixel cache without re-notifying the PTY when cols/rows are unchanged", () => {
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const controller = makeController(managed);

      controller.resizePtyOnly("term-1", 1600, 800);
      expect(resizeMock).toHaveBeenCalledTimes(1);

      // +5px is under one 10px cell — same cols/rows, but the cache must
      // track the new pixels so the next delta computes against them.
      const second = controller.resizePtyOnly("term-1", 1605, 800);
      expect(second).toBeNull();
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(managed.lastWidth).toBe(1605);
    });

    it("returns null without poisoning the dedup cache when cell dims are unavailable", () => {
      const managed = createManagedTerminal();
      const controller = makeController(managed);

      expect(controller.resizePtyOnly("term-1", 1600, 800)).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.lastWidth).toBe(800);
      expect(managed.lastHeight).toBe(600);
    });

    it("rejects degenerate pixel dimensions without touching state", () => {
      const managed = createManagedTerminal();
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      const controller = makeController(managed);

      expect(controller.resizePtyOnly("term-1", Number.NaN, 800)).toBeNull();
      expect(controller.resizePtyOnly("term-1", 1600, Number.POSITIVE_INFINITY)).toBeNull();
      expect(controller.resizePtyOnly("term-1", 0, 800)).toBeNull();
      expect(controller.resizePtyOnly("term-1", -100, 800)).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.lastWidth).toBe(800);
      expect(managed.latestCols).toBe(80);
    });

    it("delivers the PTY resize immediately for settled-strategy agents, with no xterm reflow", () => {
      const managed = createManagedTerminal();
      managed.launchAgentId = "codex";
      managed.runtimeAgentId = "codex";
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });

      const controller = makeController(managed);
      const result = controller.resizePtyOnly("term-1", 1600, 800);

      expect(result).toEqual({ cols: 160, rows: 40 });
      // Direct delivery — not deferred behind the settled 500ms timer, which
      // would also reflow xterm in a hidden (possibly frozen) renderer.
      expect(resizeMock).toHaveBeenCalledWith("term-1", 160, 40);

      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledTimes(1);
    });

    it("supersedes a pending settled timer scheduled before backgrounding", () => {
      const managed = createManagedTerminal();
      managed.launchAgentId = "codex";
      managed.runtimeAgentId = "codex";
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });

      const controller = makeController(managed);
      // A pre-background resize armed the settled timer with stale geometry.
      controller.sendPtyResize("term-1", 120, 30);
      expect(resizeMock).not.toHaveBeenCalled();

      controller.resizePtyOnly("term-1", 1600, 800);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 160, 40);

      vi.advanceTimersByTime(500);
      // The stale timer must not fire its 120x30 resize or reflow xterm.
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
    });
  });

  describe("reconcileGeometryFresh (project-switch reveal)", () => {
    function makeController(managed: ReturnType<typeof createManagedTerminal> | undefined) {
      return new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: {
          flushForTerminal: vi.fn(),
          resetForTerminal: vi.fn(),
        } as any,
      });
    }

    it("reflows xterm AND the PTY atomically from a fresh DOM measurement", () => {
      const managed = createManagedTerminal();
      // DOM box proposes 100x30; xterm grid is stale at 80x24.
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
      expect(managed.latestCols).toBe(100);
      expect(managed.latestRows).toBe(30);
      // Must NOT route through fitAddon.fit() — that resizes xterm before the PTY
      // and would break settled-strategy atomicity.
      expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    });

    it("does NOT reflow a live alt-screen TUI even when the grid drifted (OpenCode clobber regression)", () => {
      const managed = createManagedTerminal();
      managed.isAltBuffer = true;
      // Same stale-grid setup as above (box proposes 100x30, grid is 80x24): a
      // main-buffer pane gets reflowed, but an alt-screen pane must be left
      // untouched — an out-of-band xterm resize mangles its absolutely-positioned
      // frame (the "settled OpenCode goes weird on click" corruption, #10632).
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      // Reports success so the reveal repaint does not retry-loop, but resizes
      // neither xterm nor the PTY.
      expect(ok).toBe(true);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("defers a grid-changing reflow while the pane is still streaming output (#10863)", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      // A write landed just now — the CLI is mid-paint.
      (managed as { lastWriteAt?: number }).lastWriteAt = Date.now();

      const controller = makeController(managed);
      const before = {
        latestCols: managed.latestCols,
        latestRows: managed.latestRows,
        lastWidth: managed.lastWidth,
        lastHeight: managed.lastHeight,
      };
      const ok = controller.reconcileGeometryFresh("term-1");

      // Reports "not paintable yet" so the reveal sweep retries later, and
      // must not have re-wrapped xterm, resized the PTY, or poisoned the dim
      // caches (applyDeferredResize's cache==current check relies on them).
      expect(ok).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.latestCols).toBe(before.latestCols);
      expect(managed.latestRows).toBe(before.latestRows);
      expect(managed.lastWidth).toBe(before.lastWidth);
      expect(managed.lastHeight).toBe(before.lastHeight);
    });

    it("applies the deferred reflow once the pane has gone write-quiescent", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      (managed as { lastWriteAt?: number }).lastWriteAt = Date.now();

      const controller = makeController(managed);
      expect(controller.reconcileGeometryFresh("term-1")).toBe(false);

      vi.advanceTimersByTime(REVEAL_REWRAP_QUIESCENT_MS + 1);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
    });

    it("still re-asserts the PTY during streaming when the grid has not drifted", () => {
      const managed = createManagedTerminal();
      managed.terminal.cols = 100;
      managed.terminal.rows = 30;
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      (managed as { lastWriteAt?: number }).lastWriteAt = Date.now();

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      // No re-wrap is involved, so streaming doesn't defer the dedupe-safe
      // PTY re-assert.
      expect(ok).toBe(true);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
    });

    it("ignores an active resize lock without clearing it (the reveal exception)", () => {
      const managed = createManagedTerminal();
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      controller.lockResize("term-1", true);
      // Under the same lock a normal fit() no-ops.
      expect(controller.fit("term-1")).toBeNull();
      expect(managed.terminal.resize).not.toHaveBeenCalled();

      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
      // The shared lock survives so ResizeObserver-storm damping keeps working.
      expect(controller.isResizeLocked("term-1")).toBe(true);
    });

    it("applies atomically for a settled-strategy agent with no 500ms deferral", () => {
      const managed = createManagedTerminal();
      managed.runtimeAgentId = "codex";
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
      getEffectiveAgentConfigMock.mockReturnValue({
        capabilities: { resizeStrategy: "settled" },
      });

      const controller = makeController(managed);
      controller.lockResize("term-1", true);

      // Arm a pending settled (500ms) PTY resize carrying STALE dims; the
      // one-shot reveal reconcile must cancel it so that geometry never lands.
      controller.sendPtyResize("term-1", 50, 10);
      expect(resizeMock).not.toHaveBeenCalled();

      controller.reconcileGeometryFresh("term-1");

      // xterm + PTY both move now to the FRESH dims — not deferred behind 500ms.
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);

      vi.advanceTimersByTime(500);
      // The stale settled timer was cancelled — no 50x10 resize fires afterward.
      expect(resizeMock).toHaveBeenCalledTimes(1);
      expect(managed.terminal.resize).not.toHaveBeenCalledWith(50, 10);
    });

    it("uses fresh DOM dims even when cached latestCols equals the current grid", () => {
      const managed = createManagedTerminal();
      // Cache matches the stale xterm grid (80x24) — applyDeferredResize would
      // early-return here — but the live box actually grew to 100x30.
      managed.latestCols = 80;
      managed.latestRows = 24;
      managed.terminal.cols = 80;
      managed.terminal.rows = 24;
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      controller.reconcileGeometryFresh("term-1");

      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 30);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
    });

    it("re-asserts only the PTY when the grid is already correct", () => {
      const managed = createManagedTerminal();
      managed.terminal.cols = 100;
      managed.terminal.rows = 30;
      managed.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 30);
    });

    it("falls back to cell-metric math when no proposable dimensions exist", () => {
      const managed = createManagedTerminal();
      // host box is 1000x700; cell is 10x20 → 100 cols x 35 rows.
      managed.fitAddon.proposeDimensions = vi.fn(() => undefined);
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(true);
      expect(managed.terminal.resize).toHaveBeenCalledWith(100, 35);
      expect(resizeMock).toHaveBeenCalledWith("term-1", 100, 35);
    });

    it("returns false (retry next frame) when the box is not measurable yet", () => {
      const managed = createManagedTerminal();
      // No proposable dims and no cell metrics → unmeasurable transitional box.
      managed.fitAddon.proposeDimensions = vi.fn(() => undefined);

      const controller = makeController(managed);
      const ok = controller.reconcileGeometryFresh("term-1");

      expect(ok).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("returns false for a zero/too-small layout box", () => {
      const managed = createManagedTerminal();
      managed.hostElement.getBoundingClientRect = vi.fn(() => ({
        left: 0,
        width: 10,
        height: 10,
      })) as any;

      const controller = makeController(managed);
      expect(controller.reconcileGeometryFresh("term-1")).toBe(false);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("returns false when the host is not visible", () => {
      const managed = createManagedTerminal();
      managed.hostElement.checkVisibility = vi.fn(() => false);

      const controller = makeController(managed);
      expect(controller.reconcileGeometryFresh("term-1")).toBe(false);
      expect(resizeMock).not.toHaveBeenCalled();
    });

    it("returns false for a missing instance", () => {
      const controller = makeController(undefined);
      expect(controller.reconcileGeometryFresh("term-1")).toBe(false);
      expect(resizeMock).not.toHaveBeenCalled();
    });
  });

  describe("background resize lock replay + custom TTL", () => {
    function makeManagedWithMetrics() {
      const managed = createManagedTerminal();
      managed.isFocused = false;
      managed.isVisible = false;
      managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      Object.assign(managed.terminal, {
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      });
      return managed;
    }

    function makeCtl(managed: ReturnType<typeof createManagedTerminal>) {
      return new TerminalResizeController({
        getInstance: vi.fn(() => managed),
        dataBuffer: { flushForTerminal: vi.fn(), resetForTerminal: vi.fn() } as any,
      });
    }

    it("stashes a background resize that lands while the resize lock is held instead of dropping it", () => {
      const managed = makeManagedWithMetrics();
      const controller = makeCtl(managed);

      controller.lockResize("term-1", true);
      const result = controller.resizePtyOnly("term-1", 1600, 800);

      // Locked: the PTY is not resized now, but the geometry is preserved.
      expect(result).toBeNull();
      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.pendingBackgroundResize).toEqual({ width: 1600, height: 800 });
    });

    it("replays the stashed background resize when the lock releases", () => {
      const managed = makeManagedWithMetrics();
      const controller = makeCtl(managed);

      controller.lockResize("term-1", true);
      controller.resizePtyOnly("term-1", 1600, 800);
      expect(resizeMock).not.toHaveBeenCalled();

      controller.lockResize("term-1", false);

      // The held geometry is delivered to the PTY once on unlock, stash cleared.
      expect(resizeMock).toHaveBeenCalledWith("term-1", 160, 40);
      expect(managed.pendingBackgroundResize).toBeUndefined();
    });

    it("releasing the lock with no stashed resize is a no-op", () => {
      const managed = makeManagedWithMetrics();
      const controller = makeCtl(managed);

      controller.lockResize("term-1", true);
      controller.lockResize("term-1", false);

      expect(resizeMock).not.toHaveBeenCalled();
      expect(managed.pendingBackgroundResize).toBeUndefined();
    });

    it("honors a custom lock TTL longer than the default", () => {
      const managed = makeManagedWithMetrics();
      const controller = makeCtl(managed);

      // 10s custom TTL — the project-switch suppression window.
      controller.lockResize("term-1", true, 10_000);

      // Past the 5s default lock TTL, a custom-TTL lock is still held.
      vi.advanceTimersByTime(6_000);
      expect(controller.isResizeLocked("term-1")).toBe(true);

      // Past the 10s custom TTL, the lock has expired.
      vi.advanceTimersByTime(4_001);
      expect(controller.isResizeLocked("term-1")).toBe(false);
    });
  });
});
