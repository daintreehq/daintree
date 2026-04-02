// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTerminal } from "../types";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({
      visualBuffers: [],
      signalBuffer: null,
    })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() },
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

type AttachTestService = {
  instances: Map<string, unknown>;
  offscreenManager: {
    ensureHiddenContainer: () => HTMLDivElement | null;
    getOffscreenSlot: (id: string) => HTMLDivElement | undefined;
  };
  attach: (id: string, container: HTMLElement) => ManagedTerminal | null;
  detach: (id: string, container: HTMLElement | null) => void;
  destroy: (id: string) => void;
  resizeController: {
    fit: (id: string) => void;
    applyResize: (id: string, cols: number, rows: number) => void;
    lockResize: (id: string, lock: boolean, ms?: number) => void;
    clearResizeJob: (managed: unknown) => void;
    clearResizeLock: (id: string) => void;
    clearSettledTimer: (id: string) => void;
  };
  webGLManager: {
    ensureContext: (id: string, managed: unknown) => void;
    onTerminalDestroyed: (id: string) => void;
  };
  agentStateController: {
    destroy: (id: string) => void;
  };
  restoreController: {
    destroy: (id: string) => void;
  };
  dataBuffer: {
    resetForTerminal: (id: string) => void;
  };
  unseenTracker: {
    destroy: (id: string) => void;
  };
};

describe("TerminalInstanceService attach reveal", () => {
  let service: AttachTestService;
  let onRenderCallbacks: Array<() => void>;

  const makeMockManaged = (id: string) => {
    onRenderCallbacks = [];
    const hostElement = document.createElement("div");
    return {
      id,
      terminal: {
        blur: vi.fn(),
        refresh: vi.fn(),
        dispose: vi.fn(),
        element: document.createElement("div"),
        rows: 24,
        buffer: { active: { length: 100 } },
        onRender: vi.fn((cb: () => void) => {
          onRenderCallbacks.push(cb);
          return {
            dispose: vi.fn(() => {
              const idx = onRenderCallbacks.indexOf(cb);
              if (idx >= 0) onRenderCallbacks.splice(idx, 1);
            }),
          };
        }),
      },
      hostElement,
      isOpened: true,
      isDetached: false,
      isVisible: true,
      isHibernated: false,
      lastAttachAt: 0,
      lastDetachAt: 0,
      lastWidth: 0,
      lastHeight: 0,
      isAttaching: true,
      attachRevealToken: 0,
      listeners: [],
      exitSubscribers: new Set(),
      agentStateSubscribers: new Set(),
      altBufferListeners: new Set(),
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: AttachTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    service.instances.clear();
    vi.useRealTimers();
  });

  it("sets opacity 0 before reparent and reveals on onRender", () => {
    const managed = makeMockManaged("t1");
    const offscreen = document.createElement("div");
    offscreen.appendChild(managed.hostElement);
    service.instances.set("t1", managed);

    vi.spyOn(service.resizeController, "fit").mockImplementation(() => {});

    const container = document.createElement("div");
    service.attach("t1", container);

    // Host element should be hidden after reparent
    expect(managed.hostElement.style.opacity).toBe("0");
    expect(managed.hostElement.parentElement).toBe(container);

    // Simulate first rAF (triggers refresh + sets up reveal)
    vi.advanceTimersByTime(16);

    expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(managed.terminal.onRender).toHaveBeenCalledTimes(1);

    // Still hidden until onRender fires
    expect(managed.hostElement.style.opacity).toBe("0");

    // Fire onRender
    onRenderCallbacks.forEach((cb) => cb());

    expect(managed.hostElement.style.opacity).toBe("");
  });

  it("reveals via safety timeout if onRender never fires", () => {
    const managed = makeMockManaged("t1");
    const offscreen = document.createElement("div");
    offscreen.appendChild(managed.hostElement);
    service.instances.set("t1", managed);

    vi.spyOn(service.resizeController, "fit").mockImplementation(() => {});

    const container = document.createElement("div");
    service.attach("t1", container);

    expect(managed.hostElement.style.opacity).toBe("0");

    // Simulate first rAF
    vi.advanceTimersByTime(16);

    // Don't fire onRender; instead advance past safety timeout
    vi.advanceTimersByTime(150);

    expect(managed.hostElement.style.opacity).toBe("");
  });

  it("stale onRender callback does not reveal after detach", () => {
    const managed = makeMockManaged("t1");
    const offscreen = document.createElement("div");
    offscreen.appendChild(managed.hostElement);
    service.instances.set("t1", managed);

    vi.spyOn(service.resizeController, "fit").mockImplementation(() => {});
    vi.spyOn(service.offscreenManager, "getOffscreenSlot").mockReturnValue(undefined);
    vi.spyOn(service.offscreenManager, "ensureHiddenContainer").mockReturnValue(
      document.createElement("div")
    );

    const container = document.createElement("div");
    service.attach("t1", container);

    // Simulate first rAF
    vi.advanceTimersByTime(16);

    // Detach before onRender fires
    service.detach("t1", container);

    // cancelAttachReveal should have reset opacity
    expect(managed.hostElement.style.opacity).toBe("");

    // Fire stale onRender — should not change anything
    const savedCallbacks = [...onRenderCallbacks];
    savedCallbacks.forEach((cb) => cb());

    // opacity should remain reset (empty string from cancelAttachReveal)
    expect(managed.hostElement.style.opacity).toBe("");
  });

  it("rapid re-attach invalidates old token callbacks", () => {
    const managed = makeMockManaged("t1");
    const offscreen = document.createElement("div");
    offscreen.appendChild(managed.hostElement);
    service.instances.set("t1", managed);

    vi.spyOn(service.resizeController, "fit").mockImplementation(() => {});
    vi.spyOn(service.offscreenManager, "getOffscreenSlot").mockReturnValue(undefined);
    vi.spyOn(service.offscreenManager, "ensureHiddenContainer").mockReturnValue(
      document.createElement("div")
    );

    const container1 = document.createElement("div");
    service.attach("t1", container1);

    // First rAF for first attach
    vi.advanceTimersByTime(16);
    const firstRenderCallbacks = [...onRenderCallbacks];

    // Move to offscreen and re-attach to different container
    offscreen.appendChild(managed.hostElement);
    const container2 = document.createElement("div");
    service.attach("t1", container2);

    expect(managed.hostElement.style.opacity).toBe("0");

    // First rAF for second attach
    vi.advanceTimersByTime(16);

    // Fire old onRender callbacks — should be no-ops due to token mismatch
    firstRenderCallbacks.forEach((cb) => cb());
    expect(managed.hostElement.style.opacity).toBe("0");

    // Fire new onRender callbacks
    onRenderCallbacks.forEach((cb) => cb());
    expect(managed.hostElement.style.opacity).toBe("");
  });

  it("non-reparented attach does not set opacity", () => {
    const managed = makeMockManaged("t1");
    const container = document.createElement("div");
    container.appendChild(managed.hostElement);
    service.instances.set("t1", managed);

    // Attach to same container (not reparented)
    service.attach("t1", container);

    expect(managed.hostElement.style.opacity).toBe("");
  });

  describe("early synchronous resize for warm terminals", () => {
    it("applies resize synchronously before rAF when warm terminal has target dimensions", () => {
      const managed = makeMockManaged("t1");
      managed.isDetached = true;
      managed.isOpened = true;
      (managed as Record<string, unknown>).targetCols = 120;
      (managed as Record<string, unknown>).targetRows = 40;
      const offscreen = document.createElement("div");
      offscreen.appendChild(managed.hostElement);
      service.instances.set("t1", managed);

      const applyResizeSpy = vi
        .spyOn(service.resizeController, "applyResize")
        .mockImplementation(() => {});

      const container = document.createElement("div");
      service.attach("t1", container);

      // applyResize called synchronously (no timer advancement needed)
      expect(applyResizeSpy).toHaveBeenCalledWith("t1", 120, 40);
      expect((managed as Record<string, unknown>).targetCols).toBeUndefined();
      expect((managed as Record<string, unknown>).targetRows).toBeUndefined();
    });

    it("does not double-resize in inner rAF when early resize was applied", () => {
      const managed = makeMockManaged("t1");
      managed.isDetached = true;
      managed.isOpened = true;
      (managed as Record<string, unknown>).targetCols = 120;
      (managed as Record<string, unknown>).targetRows = 40;
      const offscreen = document.createElement("div");
      offscreen.appendChild(managed.hostElement);
      service.instances.set("t1", managed);

      const applyResizeSpy = vi
        .spyOn(service.resizeController, "applyResize")
        .mockImplementation(() => {});
      vi.spyOn(service.resizeController, "fit").mockImplementation(() => {});

      const container = document.createElement("div");
      service.attach("t1", container);

      // Advance past both rAFs (outer + inner)
      vi.advanceTimersByTime(32);

      // applyResize should have been called exactly once (synchronously), not again in rAF
      expect(applyResizeSpy).toHaveBeenCalledTimes(1);
    });

    it("uses lock bypass when resize is suppressed during project switch", () => {
      const managed = makeMockManaged("t1");
      managed.isDetached = true;
      managed.isOpened = true;
      (managed as Record<string, unknown>).targetCols = 80;
      (managed as Record<string, unknown>).targetRows = 24;
      (managed as Record<string, unknown>).isResizeSuppressed = true;
      (managed as Record<string, unknown>).resizeSuppressionEndTime = Date.now() + 500;
      const offscreen = document.createElement("div");
      offscreen.appendChild(managed.hostElement);
      service.instances.set("t1", managed);

      vi.spyOn(service.resizeController, "applyResize").mockImplementation(() => {});
      const lockResizeSpy = vi
        .spyOn(service.resizeController, "lockResize")
        .mockImplementation(() => {});

      const container = document.createElement("div");
      service.attach("t1", container);

      // Should unlock before resize, then re-lock after
      expect(lockResizeSpy).toHaveBeenCalledWith("t1", false);
      expect(lockResizeSpy).toHaveBeenCalledWith("t1", true, expect.any(Number));
      const relockCall = lockResizeSpy.mock.calls.find((c) => c[0] === "t1" && c[1] === true);
      expect(relockCall).toBeDefined();
      expect(relockCall![2]).toBeGreaterThanOrEqual(0);
      expect(relockCall![2]).toBeLessThanOrEqual(500);
    });

    it("skips early resize for cold terminals (isOpened=false)", () => {
      const managed = makeMockManaged("t1");
      managed.isDetached = true;
      managed.isOpened = false;
      (managed as Record<string, unknown>).targetCols = 120;
      (managed as Record<string, unknown>).targetRows = 40;
      // Cold terminals need terminal.open() mock
      (managed.terminal as Record<string, unknown>).open = vi.fn();
      const offscreen = document.createElement("div");
      offscreen.appendChild(managed.hostElement);
      service.instances.set("t1", managed);

      const applyResizeSpy = vi
        .spyOn(service.resizeController, "applyResize")
        .mockImplementation(() => {});

      const container = document.createElement("div");
      service.attach("t1", container);

      // applyResize should NOT have been called synchronously
      expect(applyResizeSpy).not.toHaveBeenCalled();
    });

    it("skips early resize for warm terminals without target dimensions", () => {
      const managed = makeMockManaged("t1");
      managed.isDetached = true;
      managed.isOpened = true;
      // No targetCols/targetRows set
      const offscreen = document.createElement("div");
      offscreen.appendChild(managed.hostElement);
      service.instances.set("t1", managed);

      const applyResizeSpy = vi
        .spyOn(service.resizeController, "applyResize")
        .mockImplementation(() => {});
      vi.spyOn(service.resizeController, "fit").mockImplementation(() => {});

      const container = document.createElement("div");
      service.attach("t1", container);

      // applyResize should NOT have been called synchronously
      expect(applyResizeSpy).not.toHaveBeenCalled();

      // But fit should be called in the inner rAF
      vi.advanceTimersByTime(32);
      expect(service.resizeController.fit).toHaveBeenCalledWith("t1");
    });
  });

  it("destroy cleans up attach reveal timer and disposable", () => {
    const managed = makeMockManaged("t1");
    const offscreen = document.createElement("div");
    offscreen.appendChild(managed.hostElement);
    service.instances.set("t1", managed);

    vi.spyOn(service.resizeController, "fit").mockImplementation(() => {});
    vi.spyOn(service.resizeController, "clearResizeJob").mockImplementation(() => {});
    vi.spyOn(service.resizeController, "clearResizeLock").mockImplementation(() => {});
    vi.spyOn(service.resizeController, "clearSettledTimer").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "onTerminalDestroyed").mockImplementation(() => {});
    vi.spyOn(service.agentStateController, "destroy").mockImplementation(() => {});
    vi.spyOn(service.restoreController, "destroy").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resetForTerminal").mockImplementation(() => {});
    vi.spyOn(service.unseenTracker, "destroy").mockImplementation(() => {});

    const container = document.createElement("div");
    service.attach("t1", container);

    // Simulate first rAF to set up timer/disposable
    vi.advanceTimersByTime(16);

    // Verify timer and disposable are set
    expect((managed as Record<string, unknown>).attachRevealTimer).toBeDefined();
    expect((managed as Record<string, unknown>).attachRevealDisposable).toBeDefined();

    service.destroy("t1");

    // After destroy, timer and disposable should be cleaned up
    expect((managed as Record<string, unknown>).attachRevealTimer).toBeUndefined();
    expect((managed as Record<string, unknown>).attachRevealDisposable).toBeUndefined();
    expect(managed.hostElement.style.opacity).toBe("");
  });
});
