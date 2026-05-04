// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalReflowController, forceXtermReflow } from "../TerminalReflowController";
import type { ManagedTerminal } from "../types";

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

function makeManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  const hostElement = document.createElement("div");
  const termEl = document.createElement("div");
  hostElement.appendChild(termEl);
  document.body.appendChild(hostElement);

  // Track padding writes — the only observable effect of forceXtermReflow.
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

  const managed = {
    terminal: {
      element: termEl,
      modes: { synchronizedOutputMode: false },
    } as unknown as ManagedTerminal["terminal"],
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
    hoveredLink: null,
    ...overrides,
  } as ManagedTerminal;
  managed.runtimeAgentId ??= managed.launchAgentId;
  return managed;
}

function paddingHistory(managed: ManagedTerminal): string[] {
  const el = managed.terminal.element as unknown as { __paddingTopHistory: string[] };
  return el.__paddingTopHistory;
}

describe("forceXtermReflow", () => {
  it("toggles paddingTop to 0.01px and restores it", () => {
    const el = document.createElement("div");
    el.style.paddingTop = "5px";
    forceXtermReflow(el);
    // Restored to original after the read.
    expect(el.style.paddingTop).toBe("5px");
  });
});

describe("TerminalReflowController.maybeReflow", () => {
  let controller: TerminalReflowController;
  let instances: ManagedTerminal[];

  beforeEach(() => {
    instances = [];
    controller = new TerminalReflowController({
      getInstances: () => instances,
    });
  });

  afterEach(() => {
    controller.dispose();
    document.body.innerHTML = "";
  });

  it("reflows a visible standard terminal and stamps lastReflowAt", () => {
    const managed = makeManaged();
    controller.maybeReflow(managed);

    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBeGreaterThan(0);
  });

  it("throttles a second reflow inside the 250ms window", () => {
    const managed = makeManaged();
    controller.maybeReflow(managed);
    const before = paddingHistory(managed).length;

    controller.maybeReflow(managed);
    expect(paddingHistory(managed).length).toBe(before);
  });

  it("allows a reflow once the throttle window has passed", () => {
    const managed = makeManaged();
    controller.maybeReflow(managed);
    const before = paddingHistory(managed).length;

    managed.lastReflowAt = (managed.lastReflowAt ?? 0) - 500;
    controller.maybeReflow(managed);
    expect(paddingHistory(managed).length).toBeGreaterThan(before);
  });

  it("skips agent terminals (WebGL — immune)", () => {
    const managed = makeManaged({ launchAgentId: "claude" });
    controller.maybeReflow(managed);
    expect(paddingHistory(managed).length).toBe(0);
    expect(managed.lastReflowAt).toBe(0);
  });

  it("skips hibernated terminals", () => {
    const managed = makeManaged({ isHibernated: true });
    controller.maybeReflow(managed);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("skips invisible terminals", () => {
    const managed = makeManaged({ isVisible: false });
    controller.maybeReflow(managed);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("skips alt-buffer (TUI) terminals", () => {
    const managed = makeManaged({ isAltBuffer: true });
    controller.maybeReflow(managed);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("skips terminals that are mid-attach", () => {
    const managed = makeManaged({ isAttaching: true });
    controller.maybeReflow(managed);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("skips when terminal element is missing", () => {
    const managed = makeManaged();
    (managed.terminal as unknown as { element: HTMLElement | undefined }).element = undefined;
    controller.maybeReflow(managed);
    expect(managed.lastReflowAt).toBe(0);
  });

  it("does not stamp the throttle when the element is detached", () => {
    const managed = makeManaged();
    managed.hostElement.remove();
    expect((managed.terminal.element as HTMLElement).isConnected).toBe(false);

    controller.maybeReflow(managed);
    expect(managed.lastReflowAt).toBe(0);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("does not stamp the throttle while synchronized output mode is active", () => {
    const managed = makeManaged();
    (
      managed.terminal as unknown as { modes: { synchronizedOutputMode: boolean } }
    ).modes.synchronizedOutputMode = true;

    controller.maybeReflow(managed);
    expect(managed.lastReflowAt).toBe(0);
    expect(paddingHistory(managed).length).toBe(0);
  });
});

describe("TerminalReflowController dispose / listener cleanup", () => {
  let controller: TerminalReflowController;
  let instances: ManagedTerminal[];

  beforeEach(() => {
    instances = [];
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("removes document and window listeners and clears the heartbeat timer", () => {
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");

    controller = new TerminalReflowController({ getInstances: () => instances });

    expect(docAdd).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(winAdd).toHaveBeenCalledWith("focus", expect.any(Function));

    controller.dispose();

    expect(docRemove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(winRemove).toHaveBeenCalledWith("focus", expect.any(Function));

    docAdd.mockRestore();
    docRemove.mockRestore();
    winAdd.mockRestore();
    winRemove.mockRestore();
  });

  it("focus listener reflows every visible standard terminal", () => {
    const a = makeManaged();
    const b = makeManaged();
    instances = [a, b];

    controller = new TerminalReflowController({ getInstances: () => instances });
    window.dispatchEvent(new FocusEvent("focus"));

    expect(paddingHistory(a)).toContain("0.01px");
    expect(paddingHistory(b)).toContain("0.01px");

    controller.dispose();
  });

  it("visibilitychange listener no-ops while the document is hidden", () => {
    const managed = makeManaged();
    instances = [managed];

    controller = new TerminalReflowController({ getInstances: () => instances });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(paddingHistory(managed).length).toBe(0);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(paddingHistory(managed)).toContain("0.01px");

    controller.dispose();
  });
});
