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

type ReflowTestService = {
  instances: Map<string, ManagedTerminal>;
  maybeReflowTerminal: (managed: ManagedTerminal) => void;
  resetRenderer: (id: string) => void;
  resizeController: { fit: (id: string) => unknown };
};

function makeManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  const hostElement = document.createElement("div");
  const termEl = document.createElement("div");
  hostElement.appendChild(termEl);
  // maybeReflowTerminal short-circuits if element.isConnected is false, so
  // attach to the document by default. Individual tests can detach the host
  // to assert the disconnected-short-circuit path.
  document.body.appendChild(hostElement);
  // Force offsetHeight to be readable (jsdom returns 0, but the read still
  // forces layout — we observe the side-effect via paddingTop jitter).
  const paddingTopHistory: string[] = [];
  const style = termEl.style;
  const orig = Object.getOwnPropertyDescriptor(style, "paddingTop");
  Object.defineProperty(style, "paddingTop", {
    configurable: true,
    get(): string {
      return orig?.get?.call(style) ?? "";
    },
    set(value: string): void {
      paddingTopHistory.push(value);
      orig?.set?.call(style, value);
    },
  });
  (termEl as HTMLDivElement & { __paddingTopHistory: string[] }).__paddingTopHistory =
    paddingTopHistory;

  return {
    terminal: { element: termEl } as unknown as ManagedTerminal["terminal"],
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
    webLinksAddon: null,
    ...overrides,
  } as ManagedTerminal;
}

function paddingHistory(managed: ManagedTerminal): string[] {
  const el = managed.terminal.element as unknown as { __paddingTopHistory: string[] };
  return el.__paddingTopHistory;
}

describe("TerminalInstanceService maybeReflowTerminal", () => {
  let service: ReflowTestService;

  beforeEach(async () => {
    vi.resetModules();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: ReflowTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    service.instances.clear();
    document.body.innerHTML = "";
  });

  it("reflows a visible standard terminal and records lastReflowAt", () => {
    const managed = makeManaged();
    service.maybeReflowTerminal(managed);

    // paddingTop was set to "0.01px" then restored
    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBeGreaterThan(0);
  });

  it("throttles per-terminal reflows within 250ms", () => {
    const managed = makeManaged();
    service.maybeReflowTerminal(managed);
    const history1 = paddingHistory(managed).length;

    service.maybeReflowTerminal(managed);
    const history2 = paddingHistory(managed).length;

    // Second call short-circuited — no additional jitter writes
    expect(history2).toBe(history1);
  });

  it("allows reflow again after the throttle window", () => {
    const managed = makeManaged();
    service.maybeReflowTerminal(managed);
    const history1 = paddingHistory(managed).length;

    // Simulate throttle window passing
    managed.lastReflowAt = (managed.lastReflowAt ?? 0) - 500;
    service.maybeReflowTerminal(managed);
    const history2 = paddingHistory(managed).length;

    expect(history2).toBeGreaterThan(history1);
  });

  it("skips agent terminals (WebGL — immune)", () => {
    const managed = makeManaged({ kind: "agent" });
    service.maybeReflowTerminal(managed);
    expect(paddingHistory(managed).length).toBe(0);
    expect(managed.lastReflowAt).toBe(0);
  });

  it("skips hibernated terminals", () => {
    const managed = makeManaged({ isHibernated: true });
    service.maybeReflowTerminal(managed);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("skips invisible terminals", () => {
    const managed = makeManaged({ isVisible: false });
    service.maybeReflowTerminal(managed);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("skips alt-buffer (TUI) terminals", () => {
    const managed = makeManaged({ isAltBuffer: true });
    service.maybeReflowTerminal(managed);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("skips terminals that are mid-attach", () => {
    const managed = makeManaged({ isAttaching: true });
    service.maybeReflowTerminal(managed);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("skips when terminal has no rendered element yet", () => {
    const managed = makeManaged();
    (managed.terminal as unknown as { element: HTMLElement | undefined }).element = undefined;
    service.maybeReflowTerminal(managed);
    // lastReflowAt not set because we short-circuited on missing element
    expect(managed.lastReflowAt).toBe(0);
  });

  it("skips — and does not stamp throttle — when element is detached", () => {
    const managed = makeManaged();
    // Disconnect from document
    managed.hostElement.remove();
    expect((managed.terminal.element as HTMLElement).isConnected).toBe(false);

    service.maybeReflowTerminal(managed);
    // Throttle must NOT be stamped — otherwise the next legitimate reflow
    // after reattachment would be suppressed for 250ms.
    expect(managed.lastReflowAt).toBe(0);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("resetRenderer calls forceXtermReflow and clears the throttle", () => {
    const managed = makeManaged({ lastReflowAt: 99999 });
    Object.defineProperty(managed.hostElement, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(managed.hostElement, "clientHeight", { value: 200, configurable: true });
    const term = managed.terminal as unknown as {
      element: HTMLElement;
      rows: number;
      clearTextureAtlas: () => void;
      refresh: (a: number, b: number) => void;
    };
    term.rows = 24;
    term.clearTextureAtlas = vi.fn();
    term.refresh = vi.fn();
    service.instances.set("t1", managed);
    vi.spyOn(service.resizeController, "fit").mockImplementation(() => null);

    service.resetRenderer("t1");

    expect(term.clearTextureAtlas).toHaveBeenCalled();
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
    expect(paddingHistory(managed)).toContain("0.01px");
    // Throttle is cleared so the next onWriteParsed/heartbeat tick
    // reflows immediately.
    expect(managed.lastReflowAt).toBe(0);
  });

  it("resetRenderer still runs forceXtermReflow when fit() throws", () => {
    const managed = makeManaged();
    Object.defineProperty(managed.hostElement, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(managed.hostElement, "clientHeight", { value: 200, configurable: true });
    const term = managed.terminal as unknown as {
      element: HTMLElement;
      rows: number;
      clearTextureAtlas: () => void;
      refresh: (a: number, b: number) => void;
    };
    term.rows = 24;
    term.clearTextureAtlas = vi.fn();
    term.refresh = vi.fn();
    service.instances.set("t1", managed);
    vi.spyOn(service.resizeController, "fit").mockImplementation(() => {
      throw new Error("fit boom");
    });

    expect(() => service.resetRenderer("t1")).not.toThrow();
    // The escape hatch — forceXtermReflow — must still run even if fit throws.
    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBe(0);
  });
});
