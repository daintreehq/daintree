import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ManagedTerminal } from "../types";

let mockAddonDispose: ReturnType<typeof vi.fn>;
let mockContextLossDispose: ReturnType<typeof vi.fn>;
let mockOnContextLoss: ReturnType<typeof vi.fn>;

function createMockAddon() {
  return { dispose: mockAddonDispose, onContextLoss: mockOnContextLoss };
}

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () {
    return createMockAddon();
  }),
}));

function makeManagedTerminal(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    terminal: {
      loadAddon: vi.fn(),
    },
    isOpened: true,
    ...overrides,
  } as unknown as ManagedTerminal;
}

describe("TerminalWebGLManager", () => {
  let manager: import("../TerminalWebGLManager").TerminalWebGLManager;
  let WebglAddonMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockAddonDispose = vi.fn();
    mockContextLossDispose = vi.fn();
    mockOnContextLoss = vi.fn((_handler: () => void) => ({ dispose: mockContextLossDispose }));

    vi.clearAllMocks();

    const webglMod = await import("@xterm/addon-webgl");
    WebglAddonMock = webglMod.WebglAddon as unknown as ReturnType<typeof vi.fn>;
    WebglAddonMock.mockImplementation(function () {
      return createMockAddon();
    });

    const mod = await import("../TerminalWebGLManager");
    manager = new mod.TerminalWebGLManager();
  });

  it("attaches WebGL addon to focused terminal", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);

    expect(WebglAddonMock).toHaveBeenCalledTimes(1);
    expect(managed.terminal.loadAddon).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when terminal is not opened", () => {
    const managed = makeManagedTerminal({ isOpened: false });
    manager.attachToFocused("t1", managed);

    expect(WebglAddonMock).not.toHaveBeenCalled();
  });

  it("is a no-op when already attached to the same terminal", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);
    manager.attachToFocused("t1", managed);

    expect(WebglAddonMock).toHaveBeenCalledTimes(1);
  });

  it("disposes previous addon before attaching to a new terminal", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();

    manager.attachToFocused("t1", managed1);
    expect(WebglAddonMock).toHaveBeenCalledTimes(1);

    manager.attachToFocused("t2", managed2);
    expect(mockAddonDispose).toHaveBeenCalledTimes(1);
    expect(WebglAddonMock).toHaveBeenCalledTimes(2);
  });

  it("silently falls back when loadAddon throws", () => {
    const managed = makeManagedTerminal();
    (managed.terminal.loadAddon as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("WebGL not supported");
    });

    expect(() => manager.attachToFocused("t1", managed)).not.toThrow();
    expect(WebglAddonMock).toHaveBeenCalledTimes(1);
  });

  it("disposes addon on context loss", () => {
    let contextLossHandler: (() => void) | undefined;
    mockOnContextLoss.mockImplementation((handler: () => void) => {
      contextLossHandler = handler;
      return { dispose: vi.fn() };
    });

    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);

    expect(contextLossHandler).toBeDefined();
    contextLossHandler!();
    expect(mockAddonDispose).toHaveBeenCalled();
  });

  it("onTerminalDestroyed clears state for matching terminal", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);
    manager.onTerminalDestroyed("t1");

    manager.attachToFocused("t1", managed);
    expect(WebglAddonMock).toHaveBeenCalledTimes(2);
  });

  it("onTerminalDestroyed is a no-op for non-matching terminal", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);
    manager.onTerminalDestroyed("t2");

    manager.attachToFocused("t1", managed);
    expect(WebglAddonMock).toHaveBeenCalledTimes(1);
  });

  it("dispose detaches current addon", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);
    manager.dispose();

    expect(mockAddonDispose).toHaveBeenCalled();
  });

  it("detachCurrent is safe to call when no addon is attached", () => {
    expect(() => manager.detachCurrent()).not.toThrow();
  });

  it("stale context loss callback does not detach new terminal's addon", () => {
    let firstContextLossHandler: (() => void) | undefined;
    let callCount = 0;
    mockOnContextLoss.mockImplementation((handler: () => void) => {
      callCount++;
      if (callCount === 1) {
        firstContextLossHandler = handler;
      }
      return { dispose: vi.fn() };
    });

    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();

    manager.attachToFocused("t1", managed1);
    manager.attachToFocused("t2", managed2);

    // Firing stale context loss from t1's addon should NOT detach t2
    firstContextLossHandler!();
    // t2 should still be attached — a new attach should be a no-op
    manager.attachToFocused("t2", managed2);
    expect(WebglAddonMock).toHaveBeenCalledTimes(2); // only 2, not 3
  });

  it("recovers cleanly after failed attach", () => {
    const managed = makeManagedTerminal();
    (managed.terminal.loadAddon as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("WebGL init failed");
    });

    manager.attachToFocused("t1", managed);

    // Internal state should be clean — next attach should work
    const managed2 = makeManagedTerminal();
    manager.attachToFocused("t2", managed2);
    expect(WebglAddonMock).toHaveBeenCalledTimes(2);
    expect(managed2.terminal.loadAddon).toHaveBeenCalledTimes(1);
  });

  it("isCurrent returns true only for the attached terminal", () => {
    const managed = makeManagedTerminal();
    expect(manager.isCurrent("t1")).toBe(false);

    manager.attachToFocused("t1", managed);
    expect(manager.isCurrent("t1")).toBe(true);
    expect(manager.isCurrent("t2")).toBe(false);

    manager.detachCurrent();
    expect(manager.isCurrent("t1")).toBe(false);
  });

  it("detachIfCurrent only detaches when id matches", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);

    manager.detachIfCurrent("t2"); // should be no-op
    manager.attachToFocused("t1", managed); // should be no-op (still attached)
    expect(WebglAddonMock).toHaveBeenCalledTimes(1);

    manager.detachIfCurrent("t1"); // should detach
    expect(mockAddonDispose).toHaveBeenCalled();
  });
});
