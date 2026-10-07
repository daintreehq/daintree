import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";

const { resizeMock, getEffectiveAgentConfigMock } = vi.hoisted(() => ({
  resizeMock: vi.fn(),
  getEffectiveAgentConfigMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  terminalClient: { resize: resizeMock },
}));

vi.mock("@shared/config/agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/config/agentRegistry")>();
  return { ...actual, getEffectiveAgentConfig: getEffectiveAgentConfigMock };
});

import { TerminalResizeController, type ResizeControllerDeps } from "../TerminalResizeController";

// An unfocused, visible pane with a deep buffer: the shape the large-buffer
// debounce applies to.
function createManaged() {
  return {
    terminal: {
      cols: 80,
      rows: 24,
      options: { scrollback: 1000, scrollbar: { width: 14 } },
      buffer: { active: { baseY: 0, viewportY: 0, length: 5000 } },
      resize: vi.fn(function (this: { cols: number; rows: number }, cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
      }),
      write: vi.fn(),
      scrollToBottom: vi.fn(),
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    },
    fitAddon: { fit: vi.fn(), proposeDimensions: vi.fn(() => undefined) },
    hostElement: {
      style: { width: "100%" },
      checkVisibility: vi.fn(() => true),
      getBoundingClientRect: vi.fn(() => ({ left: 0, width: 1000, height: 700 })),
      querySelector: vi.fn(() => null),
    },
    isFocused: false,
    isVisible: true,
    lastAppliedTier: TerminalRefreshTier.VISIBLE,
    getRefreshTier: vi.fn(() => TerminalRefreshTier.VISIBLE),
    lastWidth: 0,
    lastHeight: 0,
    resizeJob: undefined,
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    isUserScrolledBack: false,
    isAltBuffer: false,
  } as any;
}

function setup() {
  const managed = createManaged();
  const controller = new TerminalResizeController({
    getInstance: vi.fn(() => managed),
    dataBuffer: {
      flushForTerminal: vi.fn(),
      resetForTerminal: vi.fn(),
      getQueuedBytes: vi.fn(() => 0),
      resumeFlush: vi.fn(),
    } as unknown as ResizeControllerDeps["dataBuffer"],
  });
  return { managed, controller };
}

describe("TerminalResizeController immediate request for an already-queued box", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeMock.mockReset();
    getEffectiveAgentConfigMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the observer's debounced job now instead of deduping the request away", () => {
    const { managed, controller } = setup();

    // The pane's own observer measures the new box first and is debounced.
    controller.resize("t", 620, 420);
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(controller.hasPendingResize("t")).toBe(true);

    // The grid's leading pass then asks for the same box, immediately.
    controller.resize("t", 620, 420, { immediate: true });

    // (620 - 14px scrollbar) / 10px cells, 420 / 20px rows.
    expect(managed.terminal.resize).toHaveBeenCalledWith(60, 21);
    expect(resizeMock).toHaveBeenCalledWith("t", 60, 21);
    expect(controller.hasPendingResize("t")).toBe(false);

    vi.advanceTimersByTime(500);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
  });

  it("leaves a debounced job alone when the repeat request is not immediate", () => {
    const { managed, controller } = setup();
    controller.resize("t", 620, 420);
    controller.resize("t", 620, 420);
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
  });

  describe("a settled-strategy agent", () => {
    function settledSetup() {
      getEffectiveAgentConfigMock.mockReturnValue({ capabilities: { resizeStrategy: "settled" } });
      const ctx = setup();
      ctx.managed.runtimeAgentId = "codex";
      ctx.managed.isFocused = true;
      return ctx;
    }

    it("still waits for a stable grid when the box may still be moving", () => {
      const { managed, controller } = settledSetup();
      controller.resize("t", 620, 420);
      expect(managed.terminal.resize).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    });

    it("moves both grids at once for a box known to be final", () => {
      const { managed, controller } = settledSetup();
      controller.resize("t", 620, 420, { immediate: true });
      expect(managed.terminal.resize).toHaveBeenCalledWith(60, 21);
      expect(resizeMock).toHaveBeenLastCalledWith("t", 60, 21);
      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    });

    it("commits an already-waiting settle when the final box is confirmed", () => {
      const { managed, controller } = settledSetup();
      controller.resize("t", 620, 420);
      controller.resize("t", 620, 420, { immediate: true });
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(managed.terminal.resize).toHaveBeenCalledTimes(1);
    });
  });
});
