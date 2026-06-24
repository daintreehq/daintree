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

type ResizePassService = {
  instances: Map<string, ManagedTerminal>;
  runResizePass: (ids: string[]) => void;
  resizeController: {
    resize: (id: string, width: number, height: number) => { cols: number; rows: number } | null;
  };
};

type PanelStoreModule = {
  usePanelStore: {
    getState: () => { focusedId: string | null };
    setState: (partial: { focusedId: string | null }) => void;
  };
};

function makeManaged(visible = true, id = "term"): ManagedTerminal {
  const hostElement = document.createElement("div");
  const termEl = document.createElement("div");
  hostElement.appendChild(termEl);

  hostElement.getBoundingClientRect = vi.fn(() => ({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })) as unknown as HTMLElement["getBoundingClientRect"];
  hostElement.checkVisibility = vi.fn(() => visible);
  document.body.appendChild(hostElement);

  return {
    id,
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
    isHibernated: false,
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

describe("TerminalInstanceService runResizePass", () => {
  let service: ResizePassService;
  let panelStore: PanelStoreModule["usePanelStore"];

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    // Force the macrotask fallback in yieldToScheduler so the inter-chunk
    // yield is deterministically driven by fake timers.
    vi.stubGlobal("scheduler", undefined);

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: ResizePassService;
      });
    ({ usePanelStore: panelStore } =
      (await import("@/store/panelStore")) as unknown as PanelStoreModule);

    service.instances.clear();
    panelStore.setState({ focusedId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    service.instances.clear();
    panelStore.setState({ focusedId: null });
    document.body.innerHTML = "";
  });

  /** Ids passed to resizeController.resize, in call order. */
  function resizedIds(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call: unknown[]) => call[0] as string);
  }

  it("no-ops on an empty id list", () => {
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);
    service.runResizePass([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("defers all but the first terminal past a scheduler yield", async () => {
    service.instances.set("a", makeManaged());
    service.instances.set("b", makeManaged());
    service.instances.set("c", makeManaged());
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.runResizePass(["a", "b", "c"]);

    // Only the first terminal resizes synchronously — the rest are deferred
    // past a scheduler yield so the renderer can paint between them, instead
    // of one synchronous loop freezing the renderer for the whole batch.
    expect(resizedIds(spy)).toEqual(["a"]);

    await vi.advanceTimersByTimeAsync(50);
    expect(resizedIds(spy)).toEqual(["a", "b", "c"]);
  });

  it("resizes the focused panel first", async () => {
    service.instances.set("a", makeManaged());
    service.instances.set("b", makeManaged());
    service.instances.set("c", makeManaged());
    panelStore.setState({ focusedId: "c" });
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.runResizePass(["a", "b", "c"]);

    // Focused panel settles in the first frame — before any yield.
    expect(resizedIds(spy)).toEqual(["c"]);

    await vi.advanceTimersByTimeAsync(50);
    expect(resizedIds(spy)).toEqual(["c", "a", "b"]);
  });

  it("aborts an in-flight pass when a newer pass supersedes it", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) {
      service.instances.set(id, makeManaged());
    }
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    // Pass 1 starts and resizes "a" synchronously, then yields.
    service.runResizePass(["a", "b", "c"]);
    expect(resizedIds(spy)).toEqual(["a"]);

    // A new close arrives mid-pass: pass 2 supersedes pass 1.
    service.runResizePass(["d", "e"]);
    expect(resizedIds(spy)).toEqual(["a", "d"]);

    await vi.advanceTimersByTimeAsync(50);

    // Pass 1's remaining survivors ("b", "c") are cancelled; only pass 2
    // finishes ("e"). The stale reflows never run.
    expect(resizedIds(spy)).toEqual(["a", "d", "e"]);
  });

  it("skips ineligible panels (delegates to batchResize guards)", async () => {
    service.instances.set("a", makeManaged());
    service.instances.set("hidden", makeManaged(false));
    // "missing" has no managed instance.
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.runResizePass(["a", "hidden", "missing"]);
    await vi.advanceTimersByTimeAsync(10);

    expect(resizedIds(spy)).toEqual(["a"]);
  });

  it("deduplicates repeated ids across the pass", async () => {
    service.instances.set("a", makeManaged());
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.runResizePass(["a", "a", "a"]);
    await vi.advanceTimersByTimeAsync(10);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("skips a terminal destroyed mid-pass (eligibility re-checked per chunk)", async () => {
    service.instances.set("a", makeManaged());
    service.instances.set("b", makeManaged());
    service.instances.set("c", makeManaged());
    const spy = vi.spyOn(service.resizeController, "resize").mockReturnValue(null);

    service.runResizePass(["a", "b", "c"]);
    expect(resizedIds(spy)).toEqual(["a"]);

    // "b" is destroyed after the pass started but before it reaches "b".
    service.instances.delete("b");
    await vi.advanceTimersByTimeAsync(50);

    // The pass re-resolves each terminal per chunk, so the gone "b" is skipped
    // while "c" still resizes — a stale id never throws or resizes a ghost.
    expect(resizedIds(spy)).toEqual(["a", "c"]);
  });
});
