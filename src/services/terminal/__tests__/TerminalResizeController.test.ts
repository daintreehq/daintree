import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";

const { resizeMock } = vi.hoisted(() => ({
  resizeMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: resizeMock,
  },
}));

import { TerminalResizeController } from "../TerminalResizeController";

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
      getBoundingClientRect: vi.fn(() => ({ left: 0, width: 1000, height: 700 })),
      querySelector: vi.fn(() => null),
    } as unknown as HTMLDivElement,
    isFocused: true,
    isVisible: true,
    lastAppliedTier: TerminalRefreshTier.FOCUSED,
    getRefreshTier: vi.fn(() => TerminalRefreshTier.FOCUSED),
    lastWidth: 800,
    lastHeight: 600,
    resizeXJob: undefined,
    resizeYJob: undefined,
    lastYResizeTime: 0,
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    isUserScrolledBack: false,
    isAltBuffer: false,
  } as any;
}

describe("TerminalResizeController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
});
