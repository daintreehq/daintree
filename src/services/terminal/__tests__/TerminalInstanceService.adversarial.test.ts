// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import type { ManagedTerminal } from "../types";
import { preloadMockWebglAddon } from "./_preloadWebglAddon";

const testState = vi.hoisted(() => ({
  webglAddons: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    onContextLoss: ReturnType<typeof vi.fn>;
  }>,
  clientMocks: {
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
}));

vi.mock("@/clients", () => ({
  terminalClient: testState.clientMocks,
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () {
    const addon = {
      dispose: vi.fn(),
      onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
    };
    testState.webglAddons.push(addon);
    return addon;
  }),
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

type AdversarialService = {
  instances: Map<string, ManagedTerminal>;
  maybeReflowTerminal: (managed: ManagedTerminal) => void;
  writeToTerminal: (id: string, data: string | Uint8Array) => void;
  attach: (id: string, container: HTMLElement) => ManagedTerminal | null;
  destroy: (id: string) => void;
  dispose: () => void;
  dataBuffer: {
    notifyWriteComplete: (id: string, bytes: number) => void;
  };
  webGLManager: {
    ensureContext: (id: string, managed: ManagedTerminal) => void;
    isActive: (id: string) => boolean;
    getMode: () => "webgl" | "dom";
    getWantsSize: () => number;
  };
  resizeController: {
    fit: (id: string) => void;
    applyResize: (id: string, cols: number, rows: number) => void;
    lockResize: (id: string, lock: boolean, ms?: number) => void;
  };
};

function makeHostElement(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  return host;
}

function makeTerminalElement(): HTMLDivElement {
  return document.createElement("div");
}

function renderService(managed: ManagedTerminal): { _isPaused: boolean } {
  return (managed.terminal as unknown as { _core: { _renderService: { _isPaused: boolean } } })
    ._core._renderService;
}

/** Put the renderer in the paused state — the only one a repair acts on. */
function pauseRenderer(managed: ManagedTerminal): void {
  renderService(managed)._isPaused = true;
}

function makeManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  const hostElement = makeHostElement();
  const terminalElement = makeTerminalElement();
  hostElement.appendChild(terminalElement);

  const managed = {
    terminal: {
      element: terminalElement,
      rows: 24,
      // Starts unpaused; the reflow tests below opt in via `pauseRenderer`.
      _core: { _renderService: { _isPaused: false } },
      buffer: { active: { length: 100, type: "normal", baseY: 0, viewportY: 0 } },
      open: vi.fn(),
      write: vi.fn(),
      loadAddon: vi.fn(),
      refresh: vi.fn(),
      registerMarker: vi.fn(() => ({ dispose: vi.fn() })),
      blur: vi.fn(),
      onRender: vi.fn(() => ({ dispose: vi.fn() })),
      clearTextureAtlas: vi.fn(),
      dispose: vi.fn(),
      options: {},
    } as unknown as ManagedTerminal["terminal"],
    kind: "terminal",
    agentStateSubscribers: new Set(),
    fitAddon: { fit: vi.fn() } as unknown as ManagedTerminal["fitAddon"],
    serializeAddon: { serialize: vi.fn() } as unknown as ManagedTerminal["serializeAddon"],
    imageAddon: null,
    searchAddon: {} as ManagedTerminal["searchAddon"],
    fileLinksDisposable: null,
    webLinksAddon: null,
    hoveredLink: null,
    hostElement,
    isOpened: true,
    listeners: [],
    exitSubscribers: new Set(),
    getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    keyHandlerInstalled: false,
    lastAttachAt: 0,
    lastDetachAt: 0,
    lastReflowAt: 0,
    isVisible: true,
    lastActiveTime: Date.now(),
    lastWidth: 0,
    lastHeight: 0,
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    isUserScrolledBack: false,
    isFocused: false,
    writeChain: Promise.resolve(),
    restoreGeneration: 0,
    isSerializedRestoreInProgress: false,
    deferredOutput: [],
    scrollbackRestoreState: "none",
    altBufferListeners: new Set(),
    attachGeneration: 0,
    attachRevealToken: 0,
    ipcListenerCount: 0,
    isAltBuffer: false,
    pendingWrites: 0,
    ...overrides,
  } as ManagedTerminal;
  managed.runtimeAgentId ??= managed.launchAgentId;
  return managed;
}

describe("TerminalInstanceService adversarial", () => {
  let service: AdversarialService;
  let originalUpperThreshold: number;
  let originalLowerThreshold: number;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    // useFakeTimers replaces requestAnimationFrame with its own queue; the
    // WebGL manager's drain queue needs sync rAF for these tests to retain
    // their ensureContext()→isActive() inline expectations.
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      cb(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
    testState.webglAddons.length = 0;
    Object.values(testState.clientMocks).forEach((mock) => {
      if ("mockReset" in mock && typeof mock.mockReset === "function") {
        mock.mockReset();
      }
    });
    testState.clientMocks.onData.mockReturnValue(vi.fn());
    testState.clientMocks.onExit.mockReturnValue(vi.fn());
    testState.clientMocks.getSharedBuffers.mockResolvedValue({
      visualBuffers: [],
      signalBuffer: null,
    });

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: AdversarialService;
      });
    service.instances.clear();

    const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
    originalUpperThreshold = TerminalWebGLManager.UPPER_THRESHOLD;
    originalLowerThreshold = TerminalWebGLManager.LOWER_THRESHOLD;
    await preloadMockWebglAddon();
  });

  afterEach(async () => {
    service.dispose();
    document.body.innerHTML = "";
    const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
    TerminalWebGLManager.setWebglThresholds(originalUpperThreshold, originalLowerThreshold);
    vi.useRealTimers();
  });

  it("CONCURRENT_REFLOW_IS_PER_TERMINAL_NOT_GLOBAL", () => {
    const managedA = makeManaged({ lastReflowAt: 2990 });
    const managedB = makeManaged({ lastReflowAt: 0 });
    pauseRenderer(managedA);
    pauseRenderer(managedB);
    document.body.appendChild(managedA.hostElement);
    document.body.appendChild(managedB.hostElement);
    service.instances.set("a", managedA);
    service.instances.set("b", managedB);

    vi.advanceTimersByTime(3000);

    // A sits inside its 250ms throttle window and B does not, so B recovers on
    // this sweep while A waits — one terminal's throttle must never gate another's.
    expect(renderService(managedA)._isPaused).toBe(true);
    expect(renderService(managedB)._isPaused).toBe(false);
    expect(managedA.lastReflowAt).toBe(2990);
    expect(managedB.lastReflowAt).toBeGreaterThan(0);
  });

  it("ATTACH_FLIPS_TO_DOM_WHEN_WANTS_EXCEEDS_UPPER_THRESHOLD", async () => {
    // The previous per-context LRU eviction model is gone. The manager now
    // tracks a count of wanters and flips wholesale to DOM mode when wants
    // exceed the upper threshold. Set upper=1, lower=0: the second attach
    // pushes wants to 2, crosses upper, and releases both contexts together.
    const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
    TerminalWebGLManager.setWebglThresholds(1, 0);

    const managedA = makeManaged({
      kind: "terminal",
      launchAgentId: "claude",
      isOpened: false,
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
    });
    const managedB = makeManaged({
      kind: "terminal",
      launchAgentId: "codex",
      isOpened: false,
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
    });
    service.instances.set("a", managedA);
    service.instances.set("b", managedB);
    vi.spyOn(service.resizeController, "fit").mockImplementation(() => undefined);

    service.attach("a", document.createElement("div"));
    // 'a' attached cleanly (1 wants, 1 upper).
    expect(service.webGLManager.isActive("a")).toBe(true);
    expect(testState.webglAddons).toHaveLength(1);

    service.attach("b", document.createElement("div"));
    // Crossing upper (1→2 wants) flips to DOM — both released, neither active.
    expect(service.webGLManager.getMode()).toBe("dom");
    expect(service.webGLManager.isActive("a")).toBe(false);
    expect(service.webGLManager.isActive("b")).toBe(false);
    // ensureContext for 'b' evaluates mode BEFORE queueing the attach (the
    // count from setting wants flips us straight to dom), so only 'a' ever
    // had an addon constructed. Pin the exact count to lock that ordering.
    expect(testState.webglAddons).toHaveLength(1);
    // 'a's addon was disposed by flipToDom.
    expect(testState.webglAddons[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("ATTACH_AFTER_DESTROY_RETURNS_NULL", () => {
    const managed = makeManaged({
      kind: "terminal",
      launchAgentId: "claude",
      isOpened: false,
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
    });
    const container = document.createElement("div");
    const ensureContextSpy = vi.spyOn(service.webGLManager, "ensureContext");
    service.instances.set("gone", managed);

    service.destroy("gone");
    const attached = service.attach("gone", container);

    expect(attached).toBeNull();
    expect(container.childElementCount).toBe(0);
    expect(ensureContextSpy).not.toHaveBeenCalled();
  });

  it("WRITE_CALLBACK_AFTER_DESTROY_IS_DROPPED", () => {
    let capturedCallback: (() => void) | undefined;
    const managed = makeManaged({
      terminal: {
        ...makeManaged().terminal,
        write: vi.fn((_data: string | Uint8Array, cb?: () => void) => {
          capturedCallback = cb;
        }),
        registerMarker: vi.fn(() => ({ dispose: vi.fn() })),
      } as unknown as ManagedTerminal["terminal"],
    });
    service.instances.set("t1", managed);
    const notifyWriteCompleteSpy = vi.spyOn(service.dataBuffer, "notifyWriteComplete");

    service.writeToTerminal("t1", "abc");
    service.destroy("t1");
    capturedCallback?.();

    expect(testState.clientMocks.acknowledgePortData).not.toHaveBeenCalled();
    expect(testState.clientMocks.acknowledgeData).not.toHaveBeenCalled();
    expect(notifyWriteCompleteSpy).not.toHaveBeenCalled();
    expect(managed.terminal.registerMarker).not.toHaveBeenCalled();
  });

  // Verifies the contract that @xterm/addon-image's async IIPHandler.end() relies on:
  // xterm 6.0's WriteBuffer pauses _bufferOffset on a Promise-returning parser handler,
  // so terminal.write(data, cb) only fires `cb` after the async decode settles. The
  // pty-host credit acks (acknowledgeData / acknowledgePortData) live inside that
  // callback — see TerminalInstanceService.ts:522-529 — so async image decoding must
  // not release flow-control credit prematurely.
  it("ASYNC_IMAGE_DECODE_HOLDS_WRITE_CALLBACK", async () => {
    let capturedCallback: (() => void) | undefined;
    const managed = makeManaged({
      terminal: {
        ...makeManaged().terminal,
        write: vi.fn((_data: string | Uint8Array, cb?: () => void) => {
          capturedCallback = cb;
          Promise.resolve().then(() => cb?.());
        }),
        registerMarker: vi.fn(() => ({ dispose: vi.fn() })),
      } as unknown as ManagedTerminal["terminal"],
    });
    service.instances.set("t1", managed);
    const notifyWriteCompleteSpy = vi.spyOn(service.dataBuffer, "notifyWriteComplete");

    service.writeToTerminal("t1", "abc");

    expect(capturedCallback).toBeTypeOf("function");
    expect(managed.pendingWrites).toBe(1);
    expect(testState.clientMocks.acknowledgePortData).not.toHaveBeenCalled();
    expect(testState.clientMocks.acknowledgeData).not.toHaveBeenCalled();
    expect(notifyWriteCompleteSpy).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(managed.pendingWrites).toBe(0);
    expect(testState.clientMocks.acknowledgePortData).toHaveBeenCalledTimes(1);
    expect(testState.clientMocks.acknowledgePortData).toHaveBeenCalledWith("t1", 3, 1);
    expect(testState.clientMocks.acknowledgeData).toHaveBeenCalledTimes(1);
    expect(testState.clientMocks.acknowledgeData).toHaveBeenCalledWith("t1", 3);
    expect(notifyWriteCompleteSpy).toHaveBeenCalledTimes(1);
    expect(notifyWriteCompleteSpy).toHaveBeenCalledWith("t1", 3);
  });
});
