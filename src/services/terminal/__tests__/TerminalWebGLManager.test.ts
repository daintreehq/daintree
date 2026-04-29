import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("stale context loss callback does not tear down reacquired addon for same id", () => {
    let firstContextLossHandler: (() => void) | undefined;
    let callCount = 0;
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();

    WebglAddonMock.mockImplementation(function () {
      callCount++;
      const d = callCount === 1 ? firstDispose : secondDispose;
      return {
        dispose: d,
        onContextLoss: vi.fn((handler: () => void) => {
          if (callCount === 1) firstContextLossHandler = handler;
          return { dispose: vi.fn() };
        }),
      };
    });

    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    manager.releaseContext("t1");

    // Reacquire the same id with a new addon
    manager.ensureContext("t1", managed);
    expect(manager.isActive("t1")).toBe(true);

    // Fire stale context loss from the first addon — must NOT release the new addon
    firstContextLossHandler!();
    expect(manager.isActive("t1")).toBe(true);
    expect(secondDispose).not.toHaveBeenCalled();
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

  describe("GPU hardware availability", () => {
    it("ensureContext is a no-op when hardware is unavailable", () => {
      manager.setHardwareAvailable(false);
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);

      expect(WebglAddonMock).not.toHaveBeenCalled();
      expect(managed.terminal.loadAddon).not.toHaveBeenCalled();
      expect(manager.isActive("t1")).toBe(false);
    });

    it("ensureContext attaches after restoring hardware availability", () => {
      manager.setHardwareAvailable(false);
      manager.setHardwareAvailable(true);
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);

      expect(WebglAddonMock).toHaveBeenCalledTimes(1);
      expect(manager.isActive("t1")).toBe(true);
    });

    it("setting hardware unavailable does not affect already-active contexts", () => {
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      expect(manager.isActive("t1")).toBe(true);

      manager.setHardwareAvailable(false);
      expect(manager.isActive("t1")).toBe(true);
    });

    it("logs a warning only once when skipping due to software GPU", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      manager.setHardwareAvailable(false);

      const managed1 = makeManagedTerminal();
      const managed2 = makeManagedTerminal();
      manager.ensureContext("t1", managed1);
      manager.ensureContext("t2", managed2);

      const softwareWarnings = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("software-only GPU")
      );
      expect(softwareWarnings).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });

  describe("circuit breaker", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function captureContextLossHandlers(): Array<() => void> {
      const handlers: Array<() => void> = [];
      WebglAddonMock.mockImplementation(function () {
        return {
          dispose: vi.fn(),
          onContextLoss: vi.fn((handler: () => void) => {
            handlers.push(handler);
            return { dispose: vi.fn() };
          }),
        };
      });
      return handlers;
    }

    it("trips after LOSS_THRESHOLD rapid losses and disables WebGL for the session", () => {
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      const before = WebglAddonMock.mock.calls.length;
      const m4 = makeManagedTerminal();
      manager.ensureContext("t4", m4);
      expect(WebglAddonMock.mock.calls.length).toBe(before);
      expect(manager.isActive("t4")).toBe(false);
    });

    it("does not trip when losses fall outside the sliding window", () => {
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);

      handlers[0]!();
      handlers[1]!();

      vi.setSystemTime(60_000);

      const m3 = makeManagedTerminal();
      manager.ensureContext("t3", m3);
      handlers[2]!();

      const before = WebglAddonMock.mock.calls.length;
      const m4 = makeManagedTerminal();
      manager.ensureContext("t4", m4);
      expect(WebglAddonMock.mock.calls.length).toBe(before + 1);
      expect(manager.isActive("t4")).toBe(true);
    });

    it("does not evict already-active contexts when the breaker trips", () => {
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      const m4 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);
      manager.ensureContext("t4", m4);

      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      expect(manager.isActive("t4")).toBe(true);
    });

    it("stale handlers from recycled ids do not contribute to the loss count", () => {
      const handlers = captureContextLossHandlers();

      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      manager.releaseContext("t1");
      manager.ensureContext("t1", managed);
      manager.releaseContext("t1");
      manager.ensureContext("t1", managed);
      manager.releaseContext("t1");
      manager.ensureContext("t1", managed);

      // Fire all three stale handlers — must NOT trip the breaker
      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      const before = WebglAddonMock.mock.calls.length;
      const m2 = makeManagedTerminal();
      manager.ensureContext("t2", m2);
      expect(WebglAddonMock.mock.calls.length).toBe(before + 1);
      expect(manager.isActive("t2")).toBe(true);
    });

    it("does not log the software-GPU warning after the breaker trips", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      const m4 = makeManagedTerminal();
      manager.ensureContext("t4", m4);

      const softwareWarnings = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("software-only GPU")
      );
      expect(softwareWarnings).toHaveLength(0);
      warnSpy.mockRestore();
    });

    it("logs the breaker-trip warning only once", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      // Re-acquire and trip again — should not log a second time
      const m4 = makeManagedTerminal();
      const m5 = makeManagedTerminal();
      const m6 = makeManagedTerminal();
      manager.setHardwareAvailable(true);
      manager.ensureContext("t4", m4);
      manager.ensureContext("t5", m5);
      manager.ensureContext("t6", m6);
      handlers[3]?.();
      handlers[4]?.();
      handlers[5]?.();

      const breakerWarnings = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("circuit breaker")
      );
      expect(breakerWarnings).toHaveLength(1);
      warnSpy.mockRestore();
    });
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
