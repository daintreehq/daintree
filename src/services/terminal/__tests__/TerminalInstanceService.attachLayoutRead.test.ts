// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTerminal } from "../types";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
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
    discardPortAcks: vi.fn(),
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
  waitForAttachSettled: (id: string, options?: { timeoutMs?: number }) => Promise<void>;
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

// attach() runs inside useLayoutEffect: any layout read here forces a
// synchronous style/layout pass on the mount path, debug logging on or off.
describe("TerminalInstanceService attach layout reads", () => {
  let service: AttachTestService;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: AttachTestService;
      });
    vi.useFakeTimers();
    service.instances.clear();
  });

  afterEach(() => {
    service.instances.clear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not measure the container synchronously while attaching", () => {
    const hostElement = document.createElement("div");
    const offscreen = document.createElement("div");
    offscreen.appendChild(hostElement);
    service.instances.set("t1", {
      id: "t1",
      terminal: {
        blur: vi.fn(),
        refresh: vi.fn(),
        dispose: vi.fn(),
        resize: vi.fn(),
        open: vi.fn(),
        element: document.createElement("div"),
        rows: 24,
        buffer: { active: { length: 100 } },
        onRender: vi.fn(() => ({ dispose: vi.fn() })),
      },
      hostElement,
      isOpened: true,
      isDetached: false,
      isVisible: true,
      lastAttachAt: 0,
      lastDetachAt: 0,
      lastWidth: 0,
      lastHeight: 0,
      isAttaching: true,
      attachGeneration: 0,
      attachRevealToken: 0,
      listeners: [],
      exitSubscribers: new Set(),
      agentStateSubscribers: new Set(),
      altBufferListeners: new Set(),
    });
    vi.spyOn(service.resizeController, "fit").mockImplementation(() => {});
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");

    service.attach("t1", document.createElement("div"));

    process.stderr.write(
      `[bench:attach-layout-read] ${JSON.stringify({ getBoundingClientRect: rectSpy.mock.calls.length })}` +
        "\n"
    );
    expect(rectSpy).not.toHaveBeenCalled();
  });
});
