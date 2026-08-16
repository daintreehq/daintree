// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFLOW_HEARTBEAT_MS,
  TerminalReflowController,
  forceXtermReflow,
  forceXtermRendererUnpause,
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

  const managed = {
    terminal: {
      element: termEl,
      rows: 24,
      // The observable effect of a repair: the pause flag clears and xterm is
      // told to repaint. Terminals start PAUSED because that is the only state
      // in which the controller has anything to do.
      refresh: vi.fn(),
      _core: { _renderService: { _isPaused: true } },
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

/** Repairs issued against this terminal — one refresh per unpause. */
function unpauseCount(managed: ManagedTerminal): number {
  return (managed.terminal as unknown as { refresh: { mock: { calls: unknown[] } } }).refresh.mock
    .calls.length;
}

function renderService(managed: ManagedTerminal): { _isPaused?: boolean } {
  return (managed.terminal as unknown as { _core: { _renderService: { _isPaused?: boolean } } })
    ._core._renderService;
}

/**
 * Re-arm the pause. A successful repair clears the flag, so without this a
 * follow-up call would skip because the renderer is already running — making
 * throttle assertions pass for the wrong reason.
 */
function repause(managed: ManagedTerminal): void {
  renderService(managed)._isPaused = true;
}

function setDocumentVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("forceXtermReflow", () => {
  // Retained only as coverage for the legacy layout primitive — the reveal and
  // wake paths still call it for its forced layout. It cannot unpause a
  // renderer (#11800); that is forceXtermRendererUnpause's job.
  it("toggles paddingTop to 0.01px and restores it", () => {
    const el = document.createElement("div");
    el.style.paddingTop = "5px";
    forceXtermReflow(el);
    // Restored to original after the read.
    expect(el.style.paddingTop).toBe("5px");
  });
});

describe("forceXtermRendererUnpause", () => {
  function makeTerminal(renderServiceValue: object | undefined, rows = 24) {
    return {
      rows,
      refresh: vi.fn(),
      ...(renderServiceValue === undefined
        ? {}
        : { _core: { _renderService: renderServiceValue } }),
    } as unknown as ManagedTerminal["terminal"];
  }

  it("clears the pause flag and repaints every row", () => {
    const svc = { _isPaused: true };
    const terminal = makeTerminal(svc, 40);

    expect(forceXtermRendererUnpause(terminal)).toBe(true);
    expect(svc._isPaused).toBe(false);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 39);
  });

  it("no-ops on an already-running renderer", () => {
    const svc = { _isPaused: false };
    const terminal = makeTerminal(svc);

    expect(forceXtermRendererUnpause(terminal)).toBe(false);
    expect(terminal.refresh).not.toHaveBeenCalled();
  });

  it("fails closed on API drift without synthesizing the flag", () => {
    // A future xterm that renames or drops _isPaused must not get a new
    // property written onto its render service.
    const svc: { _isPaused?: boolean } = {};
    const terminal = makeTerminal(svc);

    expect(forceXtermRendererUnpause(terminal)).toBe(false);
    expect("_isPaused" in svc).toBe(false);
    expect(terminal.refresh).not.toHaveBeenCalled();
  });

  it("fails closed when the private core is absent entirely", () => {
    const terminal = makeTerminal(undefined);
    expect(forceXtermRendererUnpause(terminal)).toBe(false);
    expect(terminal.refresh).not.toHaveBeenCalled();
  });

  it("restores the pause flag when the repaint throws", () => {
    // Reporting success on a half-applied repair would stop the watchdog
    // retrying a terminal that is still blank.
    const svc = { _isPaused: true };
    const terminal = makeTerminal(svc);
    (terminal.refresh as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("renderer gone");
    });

    expect(forceXtermRendererUnpause(terminal)).toBe(false);
    expect(svc._isPaused).toBe(true);
  });

  it("clamps the repaint range for a zero-row terminal", () => {
    const svc = { _isPaused: true };
    const terminal = makeTerminal(svc, 0);

    expect(forceXtermRendererUnpause(terminal)).toBe(true);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 0);
  });
});

describe("TerminalReflowController.maybeReflow", () => {
  let controller: TerminalReflowController;
  let instances: ManagedTerminal[];

  beforeEach(() => {
    instances = [];
    // Explicit, for the same reason the cached-view suite below stubs it: an
    // inherited stub from another test would make these order-dependent.
    setDocumentVisibility("visible");
    controller = new TerminalReflowController({
      getInstances: () => instances,
    });
  });

  afterEach(() => {
    controller.dispose();
    document.body.innerHTML = "";
  });

  it("unpauses a visible standard terminal and stamps lastReflowAt", () => {
    const managed = makeManaged();
    controller.maybeReflow(managed);

    expect(unpauseCount(managed)).toBe(1);
    expect(renderService(managed)._isPaused).toBe(false);
    expect(managed.lastReflowAt).toBeGreaterThan(0);
  });

  it("throttles a second repair inside the 250ms window", () => {
    const managed = makeManaged();
    controller.maybeReflow(managed);

    // Re-arm: otherwise the second call would skip because the renderer is
    // already running, not because of the throttle.
    repause(managed);
    controller.maybeReflow(managed);
    expect(unpauseCount(managed)).toBe(1);
  });

  it("allows a repair once the throttle window has passed", () => {
    const managed = makeManaged();
    controller.maybeReflow(managed);

    repause(managed);
    managed.lastReflowAt = (managed.lastReflowAt ?? 0) - 500;
    controller.maybeReflow(managed);
    expect(unpauseCount(managed)).toBe(2);
  });

  it("unpauses agent terminals — the xterm pause gate is renderer-agnostic", () => {
    const managed = makeManaged({ launchAgentId: "claude" });
    expect(managed.runtimeAgentId).toBe("claude");

    controller.maybeReflow(managed);

    expect(unpauseCount(managed)).toBe(1);
    expect(managed.lastReflowAt).toBeGreaterThan(0);
  });

  it("skips invisible terminals", () => {
    const managed = makeManaged({ isVisible: false });
    controller.maybeReflow(managed);
    expect(unpauseCount(managed)).toBe(0);
  });

  it("skips alt-buffer (TUI) terminals", () => {
    const managed = makeManaged({ isAltBuffer: true });
    controller.maybeReflow(managed);
    expect(unpauseCount(managed)).toBe(0);
  });

  it("skips terminals that are mid-attach", () => {
    const managed = makeManaged({ isAttaching: true });
    controller.maybeReflow(managed);
    expect(unpauseCount(managed)).toBe(0);
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
    expect(unpauseCount(managed)).toBe(0);
  });

  it("skips without stamping the throttle when the renderer is provably unpaused", () => {
    const managed = makeManaged();
    renderService(managed)._isPaused = false;

    controller.maybeReflow(managed);
    expect(managed.lastReflowAt).toBe(0);
    expect(unpauseCount(managed)).toBe(0);
  });

  it("skips without stamping the throttle when the pause flag is missing (API drift)", () => {
    // Inverted from the reflow era (#11800): the repair clears a flag, so with
    // no readable flag there is nothing to clear. Falling through would stamp
    // the throttle for a guaranteed no-op.
    const managed = makeManaged();
    delete renderService(managed)._isPaused;

    controller.maybeReflow(managed);
    expect(managed.lastReflowAt).toBe(0);
    expect(unpauseCount(managed)).toBe(0);
  });

  it("skips while the document is hidden", () => {
    // The per-write path reaches maybeReflow directly, so the heartbeat's own
    // document check cannot cover it.
    const managed = makeManaged();
    setDocumentVisibility("hidden");

    controller.maybeReflow(managed);
    expect(managed.lastReflowAt).toBe(0);
    expect(unpauseCount(managed)).toBe(0);
  });

  it("honours a latched watchdog give-up for the current generation", () => {
    // The watchdog owns the breaker because it is the layer that can observe
    // whether a repair took; this path must not restart a bounded retry loop.
    const managed = makeManaged();
    managed.rendererUnpauseGaveUp = true;
    managed.rendererUnpauseGeneration = managed.attachGeneration;

    controller.maybeReflow(managed);
    expect(unpauseCount(managed)).toBe(0);

    // A give-up from a previous incarnation does not apply.
    managed.rendererUnpauseGeneration = managed.attachGeneration - 1;
    controller.maybeReflow(managed);
    expect(unpauseCount(managed)).toBe(1);
  });

  it("does not stamp the throttle while synchronized output mode is active", () => {
    const managed = makeManaged();
    (
      managed.terminal as unknown as { modes: { synchronizedOutputMode: boolean } }
    ).modes.synchronizedOutputMode = true;

    controller.maybeReflow(managed);
    expect(managed.lastReflowAt).toBe(0);
    expect(unpauseCount(managed)).toBe(0);
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

  it("heartbeat fires every 3 s and unpauses visible standard terminals", () => {
    vi.useFakeTimers();
    setDocumentVisibility("visible");

    const managed = makeManaged();
    instances = [managed];
    controller = new TerminalReflowController({ getInstances: () => instances });

    // Heartbeat hasn't fired yet.
    expect(unpauseCount(managed)).toBe(0);

    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);
    expect(unpauseCount(managed)).toBe(1);

    controller.dispose();
    vi.useRealTimers();
  });

  it("heartbeat unpauses agent terminals too", () => {
    vi.useFakeTimers();
    setDocumentVisibility("visible");

    const managed = makeManaged({ launchAgentId: "claude" });
    instances = [managed];
    controller = new TerminalReflowController({ getInstances: () => instances });

    expect(unpauseCount(managed)).toBe(0);

    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);
    expect(unpauseCount(managed)).toBe(1);

    controller.dispose();
    vi.useRealTimers();
  });

  it("heartbeat stops firing after dispose", () => {
    vi.useFakeTimers();
    setDocumentVisibility("visible");

    const managed = makeManaged();
    instances = [managed];
    controller = new TerminalReflowController({ getInstances: () => instances });

    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);
    const afterFirstTick = unpauseCount(managed);
    expect(afterFirstTick).toBeGreaterThan(0);

    controller.dispose();

    // Re-arm the pause and reset the throttle so a second heartbeat would fire
    // if the interval were still active.
    repause(managed);
    managed.lastReflowAt = 0;
    vi.advanceTimersByTime(10_000);

    expect(unpauseCount(managed)).toBe(afterFirstTick);
    vi.useRealTimers();
  });

  it("heartbeat skips when the document is hidden", () => {
    vi.useFakeTimers();

    const managed = makeManaged();
    instances = [managed];
    controller = new TerminalReflowController({ getInstances: () => instances });

    setDocumentVisibility("hidden");
    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);
    expect(unpauseCount(managed)).toBe(0);

    setDocumentVisibility("visible");
    // Reset throttle in case the visibilitychange listener fired one already.
    managed.lastReflowAt = 0;
    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);
    expect(unpauseCount(managed)).toBeGreaterThan(0);

    controller.dispose();
    vi.useRealTimers();
  });

  it("focus listener unpauses every visible standard terminal", () => {
    setDocumentVisibility("visible");
    const a = makeManaged();
    const b = makeManaged();
    instances = [a, b];

    controller = new TerminalReflowController({ getInstances: () => instances });
    window.dispatchEvent(new FocusEvent("focus"));

    expect(unpauseCount(a)).toBe(1);
    expect(unpauseCount(b)).toBe(1);

    controller.dispose();
  });

  it("focus listener unpauses agent terminals too", () => {
    setDocumentVisibility("visible");
    const managed = makeManaged({ launchAgentId: "claude" });
    instances = [managed];

    controller = new TerminalReflowController({ getInstances: () => instances });
    window.dispatchEvent(new FocusEvent("focus"));

    expect(unpauseCount(managed)).toBe(1);

    controller.dispose();
  });

  it("visibilitychange listener no-ops while the document is hidden", () => {
    const managed = makeManaged();
    instances = [managed];

    controller = new TerminalReflowController({ getInstances: () => instances });

    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(unpauseCount(managed)).toBe(0);

    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(unpauseCount(managed)).toBe(1);

    controller.dispose();
  });

  it("visibilitychange listener unpauses agent terminals too", () => {
    const managed = makeManaged({ launchAgentId: "claude" });
    instances = [managed];

    controller = new TerminalReflowController({ getInstances: () => instances });

    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(unpauseCount(managed)).toBe(1);

    controller.dispose();
  });
});

describe("TerminalReflowController — cached project view (#11212)", () => {
  let emitCached: () => void;
  let emitWarmActivated: () => void;
  let emitRevealed: () => void;
  let controller: TerminalReflowController | undefined;
  let latchedCached = false;

  const reflowCount = unpauseCount;

  beforeEach(() => {
    latchedCached = false;
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
    vi.stubGlobal("electron", {
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
        // Preload's latch. Setting this before constructing reproduces the
        // switch-storm case where the view was already cached before this
        // module ever evaluated, so no "cached" phase is ever delivered.
        isViewCached: () => latchedCached,
      },
    });
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
    vi.stubGlobal("electron", undefined);
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

  it("does not arm the heartbeat when constructed during a cached window", () => {
    // No "cached" phase arrives here — the module seeds from preload's latch —
    // so the constructor's arm must consult the seeded state itself or the
    // interval ticks unopposed until the view returns.
    latchedCached = true;
    const managed = makeManaged();
    const getInstances = vi.fn(() => [managed]);
    controller = new TerminalReflowController({ getInstances });

    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS * 10);

    expect(getInstances).not.toHaveBeenCalled();
  });

  it("arms the heartbeat on activation after being constructed while cached", () => {
    latchedCached = true;
    const managed = makeManaged();
    const getInstances = vi.fn(() => [managed]);
    controller = new TerminalReflowController({ getInstances });

    emitWarmActivated();
    getInstances.mockClear();
    vi.advanceTimersByTime(REFLOW_HEARTBEAT_MS);

    expect(getInstances).toHaveBeenCalledTimes(1);
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
