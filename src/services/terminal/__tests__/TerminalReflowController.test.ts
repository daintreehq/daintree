// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFLOW_HEARTBEAT_MS,
  TerminalReflowController,
  forceXtermReflow,
} from "../TerminalReflowController";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
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

  it("reflows agent terminals — the xterm pause gate is renderer-agnostic", () => {
    const managed = makeManaged({ launchAgentId: "claude" });
    expect(managed.runtimeAgentId).toBe("claude");

    controller.maybeReflow(managed);

    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBeGreaterThan(0);
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

  it("skips without stamping the throttle when the renderer is provably unpaused", () => {
    const managed = makeManaged();
    (managed.terminal as unknown as { _core: object })._core = {
      _renderService: { _isPaused: false },
    };

    controller.maybeReflow(managed);
    expect(managed.lastReflowAt).toBe(0);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("reflows when the renderer is paused", () => {
    const managed = makeManaged();
    (managed.terminal as unknown as { _core: object })._core = {
      _renderService: { _isPaused: true },
    };

    controller.maybeReflow(managed);
    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBeGreaterThan(0);
  });

  it("reflows when the pause flag is missing (API drift)", () => {
    const managed = makeManaged();
    (managed.terminal as unknown as { _core: object })._core = {
      _renderService: {},
    };

    controller.maybeReflow(managed);
    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBeGreaterThan(0);
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

  it("removes document and window listeners on dispose", () => {
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

  it("heartbeat fires every 3 s and reflows visible standard terminals", () => {
    vi.useFakeTimers();

    const managed = makeManaged();
    instances = [managed];
    controller = new TerminalReflowController({ getInstances: () => instances });

    // Heartbeat hasn't fired yet.
    expect(paddingHistory(managed).length).toBe(0);

    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);
    expect(paddingHistory(managed)).toContain("0.01px");

    controller.dispose();
    vi.useRealTimers();
  });

  it("heartbeat reflows agent terminals too", () => {
    vi.useFakeTimers();

    const managed = makeManaged({ launchAgentId: "claude" });
    instances = [managed];
    controller = new TerminalReflowController({ getInstances: () => instances });

    expect(paddingHistory(managed).length).toBe(0);

    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);
    expect(paddingHistory(managed)).toContain("0.01px");

    controller.dispose();
    vi.useRealTimers();
  });

  it("heartbeat stops firing after dispose", () => {
    vi.useFakeTimers();

    const managed = makeManaged();
    instances = [managed];
    controller = new TerminalReflowController({ getInstances: () => instances });

    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);
    const reflowsAfterFirstTick = paddingHistory(managed).length;
    expect(reflowsAfterFirstTick).toBeGreaterThan(0);

    controller.dispose();

    // Reset the throttle so a second heartbeat would fire if the interval
    // were still active.
    managed.lastReflowAt = 0;
    vi.advanceTimersByTime(10_000);

    expect(paddingHistory(managed).length).toBe(reflowsAfterFirstTick);
    vi.useRealTimers();
  });

  it("heartbeat skips when the document is hidden", () => {
    vi.useFakeTimers();

    const managed = makeManaged();
    instances = [managed];
    controller = new TerminalReflowController({ getInstances: () => instances });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);
    expect(paddingHistory(managed).length).toBe(0);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    // Reset throttle in case the visibilitychange listener fired one already.
    managed.lastReflowAt = 0;
    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);
    expect(paddingHistory(managed)).toContain("0.01px");

    controller.dispose();
    vi.useRealTimers();
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

  it("focus listener reflows agent terminals too", () => {
    const managed = makeManaged({ launchAgentId: "claude" });
    instances = [managed];

    controller = new TerminalReflowController({ getInstances: () => instances });
    window.dispatchEvent(new FocusEvent("focus"));

    expect(paddingHistory(managed)).toContain("0.01px");

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

  it("visibilitychange listener reflows agent terminals too", () => {
    const managed = makeManaged({ launchAgentId: "claude" });
    instances = [managed];

    controller = new TerminalReflowController({ getInstances: () => instances });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(paddingHistory(managed)).toContain("0.01px");

    controller.dispose();
  });
});

describe("TerminalReflowController — cached project view (#11212)", () => {
  let emitCached: () => void;
  let emitWarmActivated: () => void;
  let emitRevealed: () => void;
  let controller: TerminalReflowController | undefined;

  function reflowCount(managed: ManagedTerminal): number {
    // forceXtermReflow writes paddingTop twice per reflow (jitter + restore).
    return paddingHistory(managed).length;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Explicit: jsdom does not report "visible" by default, and inheriting it
    // from an earlier test's stub would make this suite order-dependent (it
    // would fail under .only or if the file were reordered).
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    const cachedHandlers: Array<() => void> = [];
    const warmHandlers: Array<() => void> = [];
    const revealedHandlers: Array<() => void> = [];
    (window as unknown as { electron: unknown }).electron = {
      app: {
        onViewCached: (cb: () => void) => {
          cachedHandlers.push(cb);
          return vi.fn();
        },
        onViewWarmActivated: (cb: () => void) => {
          warmHandlers.push(cb);
          return vi.fn();
        },
        onViewRevealed: (cb: () => void) => {
          revealedHandlers.push(cb);
          return vi.fn();
        },
      },
    };
    emitCached = () => cachedHandlers.forEach((h) => h());
    emitWarmActivated = () => warmHandlers.forEach((h) => h());
    emitRevealed = () => revealedHandlers.forEach((h) => h());
    // viewCacheState arms on first use and persists for the module's life.
    // Earlier describes in this file construct controllers before the stub
    // exists, arming it against no bridge — reset so this suite's
    // subscriptions bind to the emitters above.
    __resetProjectViewCacheStateForTests();
  });

  afterEach(() => {
    controller?.dispose();
    controller = undefined;
    __resetProjectViewCacheStateForTests();
    vi.useRealTimers();
    delete (window as unknown as { electron?: unknown }).electron;
    // makeManaged appends to the document on every call.
    document.body.innerHTML = "";
  });

  it("maybeReflow no-ops while cached even when called directly", () => {
    // The per-write path (onWriteParsedReflow → maybeReflowTerminal) calls this
    // directly, so gating only the heartbeat would leave a streaming agent in a
    // cached view forcing layout on every parsed write.
    const managed = makeManaged();
    controller = new TerminalReflowController({ getInstances: () => [managed] });

    emitCached();
    // Put the throttle window well in the past: under fake timers
    // performance.now() is 0, so the default lastReflowAt of 0 would suppress
    // the reflow on its own and this would pass for the wrong reason.
    managed.lastReflowAt = -10_000;
    controller.maybeReflow(managed);

    expect(reflowCount(managed)).toBe(0);
  });

  it("still reflows via the per-write path once the view is active again", () => {
    const managed = makeManaged();
    controller = new TerminalReflowController({ getInstances: () => [managed] });

    emitCached();
    managed.lastReflowAt = -10_000;
    controller.maybeReflow(managed);
    expect(reflowCount(managed)).toBe(0);

    emitWarmActivated();
    managed.lastReflowAt = -10_000;
    controller.maybeReflow(managed);

    expect(reflowCount(managed)).toBeGreaterThan(0);
  });

  it("stops the heartbeat while cached", () => {
    const managed = makeManaged();
    const getInstances = vi.fn(() => [managed]);
    controller = new TerminalReflowController({ getInstances });

    emitCached();
    getInstances.mockClear();
    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS * 10);

    // A cached view's visibilityState stays "visible", so the heartbeat's own
    // check can't stop it — only clearing the interval removes the wakeup.
    expect(getInstances).not.toHaveBeenCalled();
  });

  it("rearms exactly one heartbeat on warm activation", () => {
    const managed = makeManaged();
    const getInstances = vi.fn(() => [managed]);
    controller = new TerminalReflowController({ getInstances });

    emitCached();
    emitWarmActivated();
    getInstances.mockClear();
    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);

    // Exactly one sweep — a stacked second interval would double it.
    expect(getInstances).toHaveBeenCalledTimes(1);
  });

  it("does not stack a second heartbeat when warm activation repeats", () => {
    const managed = makeManaged();
    const getInstances = vi.fn(() => [managed]);
    controller = new TerminalReflowController({ getInstances });

    emitWarmActivated();
    emitWarmActivated();
    emitWarmActivated();
    getInstances.mockClear();
    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);

    expect(getInstances).toHaveBeenCalledTimes(1);
  });

  it("sweeps immediately on reveal rather than waiting out the heartbeat", () => {
    const managed = makeManaged();
    controller = new TerminalReflowController({ getInstances: () => [managed] });

    emitCached();
    emitWarmActivated();
    managed.lastReflowAt = -10_000;
    emitRevealed();

    // A renderer paused while cached must not stay blank for up to 3s at the
    // exact moment the user is looking at it.
    expect(reflowCount(managed)).toBeGreaterThan(0);
  });

  it("keeps document-hidden suppression independent of the cache signal", () => {
    const managed = makeManaged();
    const getInstances = vi.fn(() => [managed]);
    controller = new TerminalReflowController({ getInstances });

    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    emitWarmActivated();
    getInstances.mockClear();
    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);

    // Window minimize is a separate suppression signal — being un-cached must
    // not override it.
    expect(getInstances).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("dispose() stops responding to lifecycle events", () => {
    const managed = makeManaged();
    const getInstances = vi.fn(() => [managed]);
    controller = new TerminalReflowController({ getInstances });

    controller.dispose();
    controller = undefined;
    emitWarmActivated();
    getInstances.mockClear();
    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS * 10);

    expect(getInstances).not.toHaveBeenCalled();
  });
});
