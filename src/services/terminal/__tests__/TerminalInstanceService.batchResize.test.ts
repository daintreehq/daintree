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

type BatchTestService = {
  instances: Map<string, ManagedTerminal>;
  resizePassScheduler: { batchResize: (ids: string[]) => void };
  suppressResizesDuringLayoutTransition: (ids: string[], durationMs: number) => void;
  resizeController: {
    resize: (id: string, width: number, height: number) => { cols: number; rows: number } | null;
    fit: (id: string) => unknown;
    lockResize: (id: string, locked: boolean, customTtlMs?: number) => void;
    isResizeLocked: (id: string) => boolean;
  };
};

interface ManagedFixture {
  id: string;
  visible?: boolean;
  connected?: boolean;
  rect?: { width: number; height: number };
}

function makeManaged(fixture: ManagedFixture): ManagedTerminal {
  const hostElement = document.createElement("div");
  const termEl = document.createElement("div");
  hostElement.appendChild(termEl);

  const width = fixture.rect?.width ?? 800;
  const height = fixture.rect?.height ?? 600;
  hostElement.getBoundingClientRect = vi.fn(() => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })) as unknown as HTMLElement["getBoundingClientRect"];

  const visible = fixture.visible ?? true;
  hostElement.checkVisibility = vi.fn(() => visible);

  if (fixture.connected !== false) {
    document.body.appendChild(hostElement);
  }

  return {
    id: fixture.id,
    terminal: {
      element: termEl,
      modes: { synchronizedOutputMode: false },
    } as unknown as ManagedTerminal["terminal"],
    type: "terminal",
    kind: "terminal",
    hostElement,
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isAttaching: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    lastActiveTime: Date.now(),
    lastWidth: 0,
    lastHeight: 0,
    lastAttachAt: 0,
    lastDetachAt: 0,
    lastReflowAt: 0,
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    listeners: [],
    exitSubscribers: new Set(),
    agentStateSubscribers: new Set(),
    altBufferListeners: new Set(),
    writeChain: Promise.resolve(),
    restoreGeneration: 0,
    isSerializedRestoreInProgress: false,
    restoreWindowToken: 0,
    deferredOutput: [],
    scrollbackRestoreState: "none",
    attachGeneration: 0,
    attachRevealToken: 0,
    keyHandlerInstalled: false,
    ipcListenerCount: 0,
    getRefreshTier: () => 0 as unknown as ManagedTerminal["lastAppliedTier"] as never,
    fitAddon: { fit: vi.fn() } as unknown as ManagedTerminal["fitAddon"],
    serializeAddon: { serialize: vi.fn() } as unknown as ManagedTerminal["serializeAddon"],
    imageAddon: null,
    searchAddon: {} as ManagedTerminal["searchAddon"],
    fileLinksDisposable: null,
    imageLinksDisposable: null,
    webLinksAddon: null,
    hoveredLink: null,
  } as ManagedTerminal;
}

describe("TerminalInstanceService batchResize", () => {
  let service: BatchTestService;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: BatchTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    service.instances.clear();
    document.body.innerHTML = "";
  });

  it("no-ops on an empty id list", () => {
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);
    service.resizePassScheduler.batchResize([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("calls resize for each eligible panel with its rect dimensions", () => {
    const a = makeManaged({ id: "a", rect: { width: 800, height: 600 } });
    const b = makeManaged({ id: "b", rect: { width: 400, height: 300 } });
    service.instances.set("a", a);
    service.instances.set("b", b);

    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.resizePassScheduler.batchResize(["a", "b"]);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, "a", 800, 600);
    expect(spy).toHaveBeenNthCalledWith(2, "b", 400, 300);
  });

  it("deduplicates repeated ids in the input list", () => {
    const a = makeManaged({ id: "a" });
    service.instances.set("a", a);
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.resizePassScheduler.batchResize(["a", "a", "a"]);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("skips panels with no managed instance", () => {
    const a = makeManaged({ id: "a" });
    service.instances.set("a", a);
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.resizePassScheduler.batchResize(["a", "missing"]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("a", expect.any(Number), expect.any(Number));
  });

  it("skips disconnected panels", () => {
    const a = makeManaged({ id: "a", connected: false });
    service.instances.set("a", a);
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.resizePassScheduler.batchResize(["a"]);

    expect(spy).not.toHaveBeenCalled();
  });

  it("skips invisible panels (checkVisibility returns false)", () => {
    const a = makeManaged({ id: "a", visible: false });
    service.instances.set("a", a);
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.resizePassScheduler.batchResize(["a"]);

    expect(spy).not.toHaveBeenCalled();
  });

  it("skips resize-locked panels", () => {
    const a = makeManaged({ id: "a" });
    service.instances.set("a", a);
    service.resizeController.lockResize("a", true);
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.resizePassScheduler.batchResize(["a"]);

    expect(spy).not.toHaveBeenCalled();
  });

  it("skips panels whose rect is below the 50px floor (0x0 init, hidden tabs)", () => {
    const a = makeManaged({ id: "a", rect: { width: 0, height: 0 } });
    const b = makeManaged({ id: "b", rect: { width: 30, height: 30 } });
    service.instances.set("a", a);
    service.instances.set("b", b);
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.resizePassScheduler.batchResize(["a", "b"]);

    expect(spy).not.toHaveBeenCalled();
  });

  it("reads all geometry before issuing any resize (read-all / write-all phasing)", () => {
    const a = makeManaged({ id: "a" });
    const b = makeManaged({ id: "b" });
    service.instances.set("a", a);
    service.instances.set("b", b);

    const sequence: string[] = [];
    const aRect = a.hostElement.getBoundingClientRect.bind(a.hostElement);
    a.hostElement.getBoundingClientRect = vi.fn(() => {
      sequence.push("read:a");
      return aRect();
    }) as unknown as HTMLElement["getBoundingClientRect"];
    const bRect = b.hostElement.getBoundingClientRect.bind(b.hostElement);
    b.hostElement.getBoundingClientRect = vi.fn(() => {
      sequence.push("read:b");
      return bRect();
    }) as unknown as HTMLElement["getBoundingClientRect"];

    vi.spyOn(service.resizeController, "resize").mockImplementation((id: string) => {
      sequence.push(`write:${id}`);
      return null;
    });

    service.resizePassScheduler.batchResize(["a", "b"]);

    expect(sequence).toEqual(["read:a", "read:b", "write:a", "write:b"]);
  });

  it("does NOT call resizeController.fit() — fit() forces layout reads we want to avoid", () => {
    const a = makeManaged({ id: "a" });
    service.instances.set("a", a);
    const fitSpy = vi.spyOn(service.resizeController, "fit").mockReturnValue(null);
    vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.resizePassScheduler.batchResize(["a"]);

    expect(fitSpy).not.toHaveBeenCalled();
  });
});

describe("TerminalInstanceService suppressResizesDuringLayoutTransition", () => {
  let service: BatchTestService;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: BatchTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    service.instances.clear();
    document.body.innerHTML = "";
  });

  it("does not call fit() on unlock — the resize pass replaces it (#8597)", () => {
    const a = makeManaged({ id: "a" });
    service.instances.set("a", a);
    const fitSpy = vi.spyOn(service.resizeController, "fit").mockReturnValue(null);
    vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.suppressResizesDuringLayoutTransition(["a"], 200);

    // Fire the 200ms transition timer. The unlock runs runResizePass; with a
    // single panel its first (and only) chunk resizes before any yield, so the
    // resize is observable synchronously here.
    vi.advanceTimersByTime(200);

    expect(fitSpy).not.toHaveBeenCalled();
  });

  it("releases the resize lock and runs a resize pass after the transition", () => {
    const a = makeManaged({ id: "a", rect: { width: 800, height: 600 } });
    service.instances.set("a", a);
    const resizeSpy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.suppressResizesDuringLayoutTransition(["a"], 200);

    // During the lock window, the panel is locked and the batch hasn't fired.
    expect(service.resizeController.isResizeLocked("a")).toBe(true);
    expect(resizeSpy).not.toHaveBeenCalled();

    // Fire the 200ms transition timer. The unlock runs runResizePass; with a
    // single panel the resize lands synchronously (first chunk, no yield).
    vi.advanceTimersByTime(200);

    expect(service.resizeController.isResizeLocked("a")).toBe(false);
    expect(resizeSpy).toHaveBeenCalledTimes(1);
    expect(resizeSpy).toHaveBeenCalledWith("a", 800, 600);
  });
});
