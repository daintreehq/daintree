import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ManagedTerminal } from "../types";

const mockDispose = vi.fn();
const mockOnContextLoss = vi.fn(() => ({ dispose: vi.fn() }));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: mockDispose,
    onContextLoss: mockOnContextLoss,
  })),
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
  let WebglAddon: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../TerminalWebGLManager");
    manager = new mod.TerminalWebGLManager();
    WebglAddon = (await import("@xterm/addon-webgl")).WebglAddon as unknown as ReturnType<
      typeof vi.fn
    >;
  });

  it("attaches WebGL addon to focused terminal", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);

    expect(WebglAddon).toHaveBeenCalledTimes(1);
    expect(managed.terminal.loadAddon).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when terminal is not opened", () => {
    const managed = makeManagedTerminal({ isOpened: false });
    manager.attachToFocused("t1", managed);

    expect(WebglAddon).not.toHaveBeenCalled();
  });

  it("is a no-op when already attached to the same terminal", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);
    manager.attachToFocused("t1", managed);

    expect(WebglAddon).toHaveBeenCalledTimes(1);
  });

  it("disposes previous addon before attaching to a new terminal", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();

    manager.attachToFocused("t1", managed1);
    expect(WebglAddon).toHaveBeenCalledTimes(1);

    manager.attachToFocused("t2", managed2);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(WebglAddon).toHaveBeenCalledTimes(2);
  });

  it("silently falls back when loadAddon throws", () => {
    const managed = makeManagedTerminal();
    (managed.terminal.loadAddon as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("WebGL not supported");
    });

    expect(() => manager.attachToFocused("t1", managed)).not.toThrow();
    expect(WebglAddon).toHaveBeenCalledTimes(1);
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
    expect(mockDispose).toHaveBeenCalled();
  });

  it("onTerminalDestroyed clears state for matching terminal", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);
    manager.onTerminalDestroyed("t1");

    // After destroy, attaching same id should create new addon (not skip)
    manager.attachToFocused("t1", managed);
    expect(WebglAddon).toHaveBeenCalledTimes(2);
  });

  it("onTerminalDestroyed is a no-op for non-matching terminal", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);
    manager.onTerminalDestroyed("t2");

    // Should still skip since t1 is still attached
    manager.attachToFocused("t1", managed);
    expect(WebglAddon).toHaveBeenCalledTimes(1);
  });

  it("dispose detaches current addon", () => {
    const managed = makeManagedTerminal();
    manager.attachToFocused("t1", managed);
    manager.dispose();

    expect(mockDispose).toHaveBeenCalled();
  });

  it("detachCurrent is safe to call when no addon is attached", () => {
    expect(() => manager.detachCurrent()).not.toThrow();
  });
});
