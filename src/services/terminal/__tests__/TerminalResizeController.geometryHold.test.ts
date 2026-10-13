import { beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * A pane held while another view draws its terminal at that view's own size
 * (Canopy's live pane): nothing in this pane may take the PTY back, including
 * the lock-exempt reveal reconcile, until the last hold is released.
 */

const PROPOSAL = { cols: 100, rows: 30 };

function createManaged() {
  return {
    terminal: {
      cols: 80,
      rows: 24,
      options: { scrollback: 1000, scrollbar: { width: 14 } },
      buffer: { active: { baseY: 0, viewportY: 0, length: 20 } },
      resize: vi.fn(function (this: { cols: number; rows: number }, cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
      }),
      write: vi.fn(),
      scrollToBottom: vi.fn(),
    },
    fitAddon: { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ ...PROPOSAL })) },
    hostElement: {
      style: { width: "100%" },
      checkVisibility: vi.fn(() => true),
      getBoundingClientRect: vi.fn(() => ({ left: 0, width: 1000, height: 700 })),
      querySelector: vi.fn(() => null),
    },
    isFocused: true,
    isVisible: true,
    lastAppliedTier: TerminalRefreshTier.FOCUSED,
    getRefreshTier: vi.fn(() => TerminalRefreshTier.FOCUSED),
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

function createDataBuffer() {
  return {
    flushForTerminal: vi.fn(),
    resetForTerminal: vi.fn(),
    getQueuedBytes: vi.fn(() => 0),
    resumeFlush: vi.fn(),
  };
}

function setup(count = 1) {
  const panes = new Map<string, any>();
  for (let i = 0; i < count; i++) panes.set(`term-${i}`, createManaged());
  const dataBuffer = createDataBuffer();
  const controller = new TerminalResizeController({
    getInstance: vi.fn((id: string) => panes.get(id)),
    dataBuffer: dataBuffer as unknown as ResizeControllerDeps["dataBuffer"],
  });
  return { panes, dataBuffer, controller };
}

describe("TerminalResizeController geometry hold", () => {
  beforeEach(() => {
    resizeMock.mockReset();
    getEffectiveAgentConfigMock.mockReset();
  });

  it("neither fits nor sends a size while held, not even from the reveal reconcile", () => {
    const { panes, controller } = setup();
    const managed = panes.get("term-0");
    controller.holdGeometry("term-0");

    expect(controller.fit("term-0")).toBeNull();
    controller.sendPtyResize("term-0", 100, 30);
    // Reported as done, so a reveal sweep doesn't retry it frame after frame.
    expect(controller.reconcileGeometryFresh("term-0")).toBe(true);

    expect(resizeMock).not.toHaveBeenCalled();
    expect(managed.terminal.resize).not.toHaveBeenCalled();
    expect(managed.terminal.cols).toBe(80);
  });

  it("outlasts a layout transition's unlock", () => {
    const { controller } = setup();
    controller.holdGeometry("term-0");
    controller.lockResize("term-0", true, 1_000);
    controller.lockResize("term-0", false);

    expect(controller.isResizeLocked("term-0")).toBe(true);
    expect(controller.fit("term-0")).toBeNull();
    expect(resizeMock).not.toHaveBeenCalled();
  });

  it("lets go only at the last release, and then the pane fits and sends again", () => {
    const { controller } = setup();
    controller.holdGeometry("term-0");
    controller.holdGeometry("term-0");

    expect(controller.releaseGeometry("term-0")).toBe(false);
    expect(controller.fit("term-0")).toBeNull();

    expect(controller.releaseGeometry("term-0")).toBe(true);
    expect(controller.fit("term-0")).toEqual(PROPOSAL);
    expect(resizeMock).toHaveBeenCalledWith("term-0", PROPOSAL.cols, PROPOSAL.rows);
  });

  it("asks for no re-measure when released under another lock, or never held", () => {
    const { controller } = setup();
    expect(controller.releaseGeometry("term-0")).toBe(false);

    controller.holdGeometry("term-0");
    controller.lockResize("term-0", true, 1_000);
    expect(controller.releaseGeometry("term-0")).toBe(false);
    expect(controller.isResizeLocked("term-0")).toBe(true);
  });

  describe("adopting the PTY's grid while another frontend drives (#13282)", () => {
    it("puts xterm on the PTY's grid without sending anything to the PTY", () => {
      const { panes, dataBuffer, controller } = setup();
      const managed = panes.get("term-0");
      controller.holdGeometry("term-0");

      controller.adoptPtyGeometry("term-0", 200, 50);

      expect(managed.terminal.resize).toHaveBeenCalledWith(200, 50);
      expect(managed.terminal.cols).toBe(200);
      expect(managed.terminal.rows).toBe(50);
      expect(managed.targetCols).toBe(200);
      expect(managed.targetRows).toBe(50);
      expect(dataBuffer.flushForTerminal).toHaveBeenCalledWith("term-0");
      expect(resizeMock).not.toHaveBeenCalled();
      // Still held: the pane's own box can't take the grid back.
      expect(controller.fit("term-0")).toBeNull();
      expect(managed.terminal.cols).toBe(200);
    });

    it("leaves an unheld pane to its own fit", () => {
      const { panes, controller } = setup();
      controller.adoptPtyGeometry("term-0", 200, 50);

      expect(panes.get("term-0").terminal.resize).not.toHaveBeenCalled();
    });

    it("doesn't reflow a pane already on that grid", () => {
      const { panes, dataBuffer, controller } = setup();
      controller.holdGeometry("term-0");

      controller.adoptPtyGeometry("term-0", 80, 24);

      expect(panes.get("term-0").terminal.resize).not.toHaveBeenCalled();
      expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
    });

    it("parks the grid for a serialized restore to normalize to", () => {
      const { panes, controller } = setup();
      const managed = panes.get("term-0");
      managed.isSerializedRestoreInProgress = true;
      controller.holdGeometry("term-0");

      controller.adoptPtyGeometry("term-0", 200, 50);

      expect(managed.terminal.resize).not.toHaveBeenCalled();
      expect(managed.pendingRestoreGeometry).toEqual({ cols: 200, rows: 50 });
    });

    it("keeps an over-budget backlog queued and resumes it after the resize", () => {
      const { panes, dataBuffer, controller } = setup();
      dataBuffer.getQueuedBytes.mockReturnValue(Number.MAX_SAFE_INTEGER);
      controller.holdGeometry("term-0");

      controller.adoptPtyGeometry("term-0", 200, 50);

      expect(dataBuffer.flushForTerminal).not.toHaveBeenCalled();
      expect(dataBuffer.resumeFlush).toHaveBeenCalledWith("term-0");
      expect(panes.get("term-0").terminal.resize).toHaveBeenCalledWith(200, 50);
    });
  });
});
