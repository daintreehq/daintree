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
    lastActiveTime: Date.now(),
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

  it("attaches WebGL addon via ensureContext", () => {
    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);

    expect(WebglAddonMock).toHaveBeenCalledTimes(1);
    expect(managed.terminal.loadAddon).toHaveBeenCalledTimes(1);
    expect(manager.isActive("t1")).toBe(true);
  });

  it("is a no-op when terminal is not opened", () => {
    const managed = makeManagedTerminal({ isOpened: false });
    manager.ensureContext("t1", managed);

    expect(WebglAddonMock).not.toHaveBeenCalled();
    expect(manager.isActive("t1")).toBe(false);
  });

  it("is a no-op when already active for the same terminal", () => {
    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    manager.ensureContext("t1", managed);

    expect(WebglAddonMock).toHaveBeenCalledTimes(1);
  });

  it("two terminals can both be active simultaneously", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();

    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);

    expect(WebglAddonMock).toHaveBeenCalledTimes(2);
    expect(manager.isActive("t1")).toBe(true);
    expect(manager.isActive("t2")).toBe(true);
    expect(mockAddonDispose).not.toHaveBeenCalled();
  });

  it("releaseContext disposes only the targeted entry", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();

    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);

    manager.releaseContext("t1");

    expect(manager.isActive("t1")).toBe(false);
    expect(manager.isActive("t2")).toBe(true);
    expect(mockAddonDispose).toHaveBeenCalledTimes(1);
  });

  it("releaseContext is a no-op for unknown id", () => {
    expect(() => manager.releaseContext("unknown")).not.toThrow();
  });

  it("silently falls back when loadAddon throws", () => {
    const managed = makeManagedTerminal();
    (managed.terminal.loadAddon as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("WebGL not supported");
    });

    expect(() => manager.ensureContext("t1", managed)).not.toThrow();
    expect(manager.isActive("t1")).toBe(false);
  });

  it("disposes addon on context loss", () => {
    let contextLossHandler: (() => void) | undefined;
    mockOnContextLoss.mockImplementation((handler: () => void) => {
      contextLossHandler = handler;
      return { dispose: vi.fn() };
    });

    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);

    expect(contextLossHandler).toBeDefined();
    contextLossHandler!();
    expect(mockAddonDispose).toHaveBeenCalled();
    expect(manager.isActive("t1")).toBe(false);
  });

  it("stale context loss callback is a no-op after release", () => {
    let contextLossHandler: (() => void) | undefined;
    mockOnContextLoss.mockImplementation((handler: () => void) => {
      contextLossHandler = handler;
      return { dispose: vi.fn() };
    });

    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    manager.releaseContext("t1");

    // Firing stale handler after release should not throw
    expect(() => contextLossHandler!()).not.toThrow();
  });

  it("onTerminalDestroyed removes state without calling addon.dispose", () => {
    const perAddonDispose = vi.fn();
    WebglAddonMock.mockImplementation(function () {
      return { dispose: perAddonDispose, onContextLoss: mockOnContextLoss };
    });

    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    manager.onTerminalDestroyed("t1");

    expect(manager.isActive("t1")).toBe(false);
    expect(perAddonDispose).not.toHaveBeenCalled();
    expect(mockContextLossDispose).toHaveBeenCalled();
  });

  it("onTerminalDestroyed is a no-op for non-matching terminal", () => {
    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    manager.onTerminalDestroyed("t2");

    expect(manager.isActive("t1")).toBe(true);
  });

  it("dispose releases all entries", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();

    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);
    manager.dispose();

    expect(manager.isActive("t1")).toBe(false);
    expect(manager.isActive("t2")).toBe(false);
    expect(mockAddonDispose).toHaveBeenCalledTimes(2);
  });

  it("isActive returns false for unknown terminals", () => {
    expect(manager.isActive("unknown")).toBe(false);
  });

  it("recovers cleanly after failed attach", () => {
    const managed = makeManagedTerminal();
    (managed.terminal.loadAddon as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("WebGL init failed");
    });

    manager.ensureContext("t1", managed);
    expect(manager.isActive("t1")).toBe(false);

    const managed2 = makeManagedTerminal();
    manager.ensureContext("t2", managed2);
    expect(WebglAddonMock).toHaveBeenCalledTimes(2);
    expect(managed2.terminal.loadAddon).toHaveBeenCalledTimes(1);
    expect(manager.isActive("t2")).toBe(true);
  });

  describe("LRU eviction", () => {
    it("evicts the least recently used entry when pool reaches MAX_CONTEXTS", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      const maxContexts = TerminalWebGLManager.MAX_CONTEXTS;

      const disposes: ReturnType<typeof vi.fn>[] = [];
      WebglAddonMock.mockImplementation(function () {
        const d = vi.fn();
        disposes.push(d);
        return { dispose: d, onContextLoss: mockOnContextLoss };
      });

      const localManager = new TerminalWebGLManager();

      for (let i = 0; i < maxContexts; i++) {
        const m = makeManagedTerminal({ lastActiveTime: i });
        localManager.ensureContext(`t${i}`, m);
      }

      expect(disposes).toHaveLength(maxContexts);
      disposes.forEach((d) => expect(d).not.toHaveBeenCalled());

      // Add one more — should evict t0 (oldest in LRU order)
      const extra = makeManagedTerminal({ lastActiveTime: maxContexts });
      localManager.ensureContext(`t${maxContexts}`, extra);

      expect(disposes[0]).toHaveBeenCalledTimes(1);
      expect(localManager.isActive("t0")).toBe(false);
      expect(localManager.isActive(`t${maxContexts}`)).toBe(true);

      // t1 through t{maxContexts-1} should still be active
      for (let i = 1; i < maxContexts; i++) {
        expect(localManager.isActive(`t${i}`)).toBe(true);
      }
    });

    it("touching an entry moves it to the end of LRU", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      const maxContexts = TerminalWebGLManager.MAX_CONTEXTS;

      const disposes: ReturnType<typeof vi.fn>[] = [];
      WebglAddonMock.mockImplementation(function () {
        const d = vi.fn();
        disposes.push(d);
        return { dispose: d, onContextLoss: mockOnContextLoss };
      });

      const localManager = new TerminalWebGLManager();

      for (let i = 0; i < maxContexts; i++) {
        const m = makeManagedTerminal({ lastActiveTime: i });
        localManager.ensureContext(`t${i}`, m);
      }

      // Touch t0 — should move it to end of LRU
      const m0 = makeManagedTerminal({ lastActiveTime: maxContexts + 1 });
      localManager.ensureContext("t0", m0);

      // Add one more — should evict t1 (now the oldest), not t0
      const extra = makeManagedTerminal({ lastActiveTime: maxContexts + 2 });
      localManager.ensureContext(`t${maxContexts}`, extra);

      expect(localManager.isActive("t0")).toBe(true);
      expect(localManager.isActive("t1")).toBe(false);
      expect(disposes[1]).toHaveBeenCalledTimes(1);
    });
  });
});
