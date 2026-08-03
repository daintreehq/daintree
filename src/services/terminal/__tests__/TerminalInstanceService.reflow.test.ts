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

type ReflowTestService = {
  instances: Map<string, ManagedTerminal>;
  maybeReflowTerminal: (managed: ManagedTerminal) => void;
  resetRenderer: (id: string, options?: { force?: boolean }) => boolean;
  handleBackendRecovery: () => void;
  resizeController: {
    fit: (id: string) => unknown;
    reconcileGeometryFresh: (id: string, options?: { force?: boolean }) => boolean;
  };
  getSynchronizedOutputMode: (id: string) => boolean | null;
  webGLManager: { repairAtlasForReactivation: (id: string) => boolean };
};

/**
 * Upgrades a {@link makeManaged} fixture into one the REAL
 * `resizeController.reconcileGeometryFresh` can drive end to end: a measurable
 * host box, a live grid, and a fit proposal that diverges from it. Used by the
 * #11638 regression, which has to observe an actual grid change rather than a
 * spy call.
 */
function makeDivergedPane(
  managed: ManagedTerminal,
  proposal: { cols: number; rows: number }
): { resize: ReturnType<typeof vi.fn>; scrollToBottom: ReturnType<typeof vi.fn> } {
  for (const [prop, value] of [
    ["clientWidth", 800],
    ["clientHeight", 600],
  ] as const) {
    Object.defineProperty(managed.hostElement, prop, { value, configurable: true });
  }
  managed.hostElement.checkVisibility = vi.fn(() => true);
  managed.hostElement.getBoundingClientRect = vi.fn(() => ({
    left: 0,
    width: 800,
    height: 600,
  })) as unknown as HTMLElement["getBoundingClientRect"];

  const resize = vi.fn((cols: number, rows: number) => {
    term.cols = cols;
    term.rows = rows;
  });
  const scrollToBottom = vi.fn();
  const term = managed.terminal as unknown as {
    cols: number;
    rows: number;
    resize: typeof resize;
    refresh: ReturnType<typeof vi.fn>;
    scrollToBottom: typeof scrollToBottom;
  };
  term.cols = 80;
  term.rows = 24;
  term.resize = resize;
  term.refresh = vi.fn();
  term.scrollToBottom = scrollToBottom;

  managed.fitAddon = {
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => proposal),
  } as unknown as ManagedTerminal["fitAddon"];

  return { resize, scrollToBottom };
}

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

  const managed = {
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
  managed.runtimeAgentId ??= managed.launchAgentId;
  return managed;
}

function paddingHistory(managed: ManagedTerminal): string[] {
  const el = managed.terminal.element as unknown as { __paddingTopHistory: string[] };
  return el.__paddingTopHistory;
}

// Test-fixture mutation helpers. The terminal mock isn't a full xterm Terminal,
// so these consolidate the partial-shape casts in one place.
type MutableModes = { modes?: { synchronizedOutputMode: boolean } | undefined };

function setSyncMode(managed: ManagedTerminal, value: boolean): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const term = managed.terminal as unknown as MutableModes;
  term.modes = { synchronizedOutputMode: value };
}

function clearSyncModes(managed: ManagedTerminal): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const term = managed.terminal as unknown as MutableModes;
  term.modes = undefined;
}

describe("TerminalInstanceService maybeReflowTerminal", () => {
  let service: ReflowTestService;
  let terminalClient: { resize: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: ReflowTestService;
      });
    // Read the client out of the SAME post-reset module registry the service
    // just bound to — a static top-level import would hold the pre-reset
    // instance and never observe these calls.
    ({ terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { resize: ReturnType<typeof vi.fn> };
    });
    terminalClient.resize.mockClear();
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

  it("reflows agent terminals — the xterm pause gate is renderer-agnostic", () => {
    const managed = makeManaged({ kind: "terminal", launchAgentId: "claude" });
    expect(managed.runtimeAgentId).toBe("claude");

    service.maybeReflowTerminal(managed);

    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBeGreaterThan(0);
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

  it("skips — and does not stamp throttle — when synchronized output mode is active", () => {
    const managed = makeManaged();
    setSyncMode(managed, true);

    service.maybeReflowTerminal(managed);
    // BSU is open — refreshing now would interleave with xterm's buffered
    // range. Throttle must not stamp so we reflow on the next tick after ESU.
    expect(managed.lastReflowAt).toBe(0);
    expect(paddingHistory(managed).length).toBe(0);
  });

  it("reflows when synchronized output mode is false", () => {
    const managed = makeManaged();
    setSyncMode(managed, false);

    service.maybeReflowTerminal(managed);
    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBeGreaterThan(0);
  });

  it("does not throttle the post-ESU reflow after a BSU skip", () => {
    const managed = makeManaged();
    setSyncMode(managed, true);
    service.maybeReflowTerminal(managed);
    expect(paddingHistory(managed).length).toBe(0);
    expect(managed.lastReflowAt).toBe(0);

    // ESU closes — the next reflow must fire immediately, not be eaten by
    // the 250ms throttle. This is the invariant that justifies the
    // no-stamp branch in the guard.
    setSyncMode(managed, false);
    service.maybeReflowTerminal(managed);
    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBeGreaterThan(0);
  });

  it("resetRenderer falls back to a local refresh for DOM-renderer terminals and never clears the shared atlas", () => {
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
    // DOM-renderer terminal (no WebGL pool entry) — repair declines and the
    // caller owns the repaint.
    const repair = vi
      .spyOn(service.webGLManager, "repairAtlasForReactivation")
      .mockReturnValue(false);

    service.resetRenderer("t1");

    // #9701: clearing the shared texture atlas blanks co-owner panes — it must
    // never be called on the per-pane Redraw path.
    expect(term.clearTextureAtlas).not.toHaveBeenCalled();
    expect(repair).toHaveBeenCalledWith("t1");
    // DOM-renderer fallback still repaints the targeted pane.
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
    expect(paddingHistory(managed)).toContain("0.01px");
    // Throttle is cleared so the next onWriteParsed/heartbeat tick
    // reflows immediately.
    expect(managed.lastReflowAt).toBe(0);
  });

  it("resetRenderer uses the local WebGL repair and skips the fallback refresh when a pool entry is repaired", () => {
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
    // WebGL terminal: repair handles its own local reset + refresh, so the
    // caller must not issue a redundant fallback refresh.
    const repair = vi
      .spyOn(service.webGLManager, "repairAtlasForReactivation")
      .mockReturnValue(true);

    service.resetRenderer("t1");

    expect(repair).toHaveBeenCalledWith("t1");
    expect(term.clearTextureAtlas).not.toHaveBeenCalled();
    expect(term.refresh).not.toHaveBeenCalled();
    // forceXtermReflow still fires and the throttle is still cleared.
    expect(paddingHistory(managed)).toContain("0.01px");
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
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(false);
    vi.spyOn(service.resizeController, "fit").mockImplementation(() => {
      throw new Error("fit boom");
    });

    expect(() => service.resetRenderer("t1")).not.toThrow();
    // The escape hatch — forceXtermReflow — must still run even if fit throws.
    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBe(0);
    // Even on the error path, Redraw never flushes the shared atlas.
    expect(term.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it("forced resetRenderer converges a streaming, diverged pane that the default path defers (#11638)", () => {
    const managed = makeManaged();
    const { resize } = makeDivergedPane(managed, { cols: 120, rows: 40 });
    // A working agent's steady state: a batch is always in flight, so the
    // 300ms write-quiescence window the guard waits for never opens.
    managed.pendingWrites = 2;
    service.instances.set("t1", managed);
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    const fit = vi.spyOn(service.resizeController, "fit");

    const term = managed.terminal as unknown as { cols: number; rows: number };
    const staleGrid = { cols: term.cols, rows: term.rows };
    const proposal = managed.fitAddon.proposeDimensions();

    // The bug: the default path defers its one grid-correcting step and hands
    // the repair to the watchdog, which tests the same predicate and so never
    // runs it either. Nothing about the pane changes.
    expect(service.resetRenderer("t1")).toBe(true);
    expect(term.cols).toBe(staleGrid.cols);
    expect(term.rows).toBe(staleGrid.rows);
    expect(managed.revealPendingRepair).toBe(true);

    // Same pane, same instant, no timer advance — only the explicit intent
    // differs. This is the assertion the issue asked for.
    expect(service.resetRenderer("t1", { force: true })).toBe(true);

    expect(term.cols).toBe(proposal?.cols);
    expect(term.rows).toBe(proposal?.rows);
    expect(resize).toHaveBeenCalledWith(proposal?.cols, proposal?.rows);
    // The PTY moved with xterm in the same step; a settled-strategy agent must
    // never see the two grids disagree across a 500ms debounce.
    expect(terminalClient.resize).toHaveBeenCalledWith("t1", proposal?.cols, proposal?.rows);
    // Routed through the lock-exempt atomic reconcile, NOT the lock-aware fit()
    // that the default branch uses.
    expect(fit).not.toHaveBeenCalled();
  });

  it("forced resetRenderer re-arms the geometry circuit breaker once the grid converges", () => {
    const managed = makeManaged();
    makeDivergedPane(managed, { cols: 120, rows: 40 });
    managed.pendingWrites = 2;
    // A pane the watchdog gave up on (#10909): its automatic geometry repairs
    // are latched off, and only genuine convergence or a re-attach re-arms it.
    // An explicit Redraw that DOES converge is exactly that kind of boundary —
    // leaving it barred would strand the pane's future automatic repairs.
    managed.geometryRepairAttempts = 5;
    managed.geometryRepairGaveUp = true;
    managed.attachGeneration = 7;
    service.instances.set("t1", managed);
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);

    service.resetRenderer("t1", { force: true });

    expect(managed.geometryRepairGaveUp).toBe(false);
    expect(managed.geometryRepairAttempts).toBe(0);
    // Re-armed under the CURRENT incarnation, so a later re-attach still
    // supersedes it rather than inheriting this counter.
    expect(managed.geometryRepairGeneration).toBe(managed.attachGeneration);
  });

  it("forced resetRenderer keeps the breaker latched when the grid could not converge", () => {
    const managed = makeManaged();
    makeDivergedPane(managed, { cols: 120, rows: 40 });
    managed.pendingWrites = 2;
    managed.geometryRepairAttempts = 5;
    managed.geometryRepairGaveUp = true;
    // A serialized restore parks the xterm resize (#11552) — reconcile reports
    // a successful measurement, but the live grid never moved. Trusting that
    // boolean would re-arm the breaker on no evidence at all.
    managed.isSerializedRestoreInProgress = true;
    service.instances.set("t1", managed);
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);

    service.resetRenderer("t1", { force: true });

    const term = managed.terminal as unknown as { cols: number; rows: number };
    expect(term.cols).toBe(80);
    expect(managed.geometryRepairGaveUp).toBe(true);
    expect(managed.geometryRepairAttempts).toBe(5);
  });

  it("forced resetRenderer arms the watchdog obligation when the box is unmeasurable", () => {
    const managed = makeManaged();
    makeDivergedPane(managed, { cols: 120, rows: 40 });
    managed.pendingWrites = 2;
    managed.attachGeneration = 4;
    // Passes resetRenderer's own clientWidth/Height floor, but the LIVE rect is
    // mid-transition — reconcileGeometryFresh can't measure it. The repair must
    // not be silently spent: hand it to the watchdog for a later frame.
    managed.hostElement.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      width: 10,
      height: 10,
    })) as unknown as HTMLElement["getBoundingClientRect"];
    service.instances.set("t1", managed);
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    const fit = vi.spyOn(service.resizeController, "fit");

    // Still true: the renderer repair itself ran. The #10632 suppression-clear
    // reads this boolean to decide whether its one-shot was spent, so a failed
    // geometry sub-step must not flip it.
    expect(service.resetRenderer("t1", { force: true })).toBe(true);

    expect(managed.revealPendingRepair).toBe(true);
    expect(managed.revealPendingGeneration).toBe(managed.attachGeneration);
    // No fit() fallback — every reason the fresh reconcile failed is a reason
    // fit() would fail too, and fit() would reintroduce the lock and the
    // settled-strategy split.
    expect(fit).not.toHaveBeenCalled();
    // The escape hatch still runs so a paused renderer resumes drawing.
    expect(paddingHistory(managed)).toContain("0.01px");
  });

  it("forced resetRenderer still runs forceXtermReflow when the reconcile throws", () => {
    const managed = makeManaged();
    makeDivergedPane(managed, { cols: 120, rows: 40 });
    managed.pendingWrites = 2;
    managed.attachGeneration = 9;
    service.instances.set("t1", managed);
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    vi.spyOn(service.resizeController, "reconcileGeometryFresh").mockImplementation(() => {
      throw new Error("reconcile boom");
    });

    expect(() => service.resetRenderer("t1", { force: true })).not.toThrow();

    // A throw is no more converged than a false — the obligation is armed
    // either way rather than dropped.
    expect(managed.revealPendingRepair).toBe(true);
    expect(managed.revealPendingGeneration).toBe(managed.attachGeneration);
    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBe(0);
  });

  it("forced resetRenderer never reflows a live alt-screen pane or re-arms its breaker", () => {
    const managed = makeManaged();
    const { resize } = makeDivergedPane(managed, { cols: 120, rows: 40 });
    managed.pendingWrites = 2;
    managed.isAltBuffer = true;
    managed.geometryRepairAttempts = 5;
    managed.geometryRepairGaveUp = true;
    service.instances.set("t1", managed);
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    const fit = vi.spyOn(service.resizeController, "fit");

    service.resetRenderer("t1", { force: true });

    // End-to-end through the action's entry point: a full-screen TUI's frame is
    // never mangled out from under its own SIGWINCH redraw (#10805), and the
    // alt-buffer "success" (measurable, but no geometry touched) is not
    // evidence of convergence, so the breaker stays latched.
    expect(resize).not.toHaveBeenCalled();
    expect(fit).not.toHaveBeenCalled();
    expect(managed.geometryRepairGaveUp).toBe(true);
    expect(managed.geometryRepairAttempts).toBe(5);
  });

  it("forced resetRenderer preserves a reveal obligation it did not discharge", () => {
    const managed = makeManaged();
    makeDivergedPane(managed, { cols: 120, rows: 40 });
    managed.pendingWrites = 2;
    // Armed by the reveal controller because an open synchronized-output block
    // blocked its atlas repair / unpause — NOT a geometry deferral. A geometry
    // step cannot discharge it, so clearing it here would strand the pane.
    managed.revealPendingRepair = true;
    managed.revealPendingGeneration = 3;
    service.instances.set("t1", managed);
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);

    service.resetRenderer("t1", { force: true });

    const term = managed.terminal as unknown as { cols: number };
    expect(term.cols).toBe(120);
    expect(managed.revealPendingRepair).toBe(true);
    expect(managed.revealPendingGeneration).toBe(3);
  });

  it("resetRenderer leaves sibling panes untouched (#9701 isolation)", () => {
    const target = makeManaged({ lastReflowAt: 99999 });
    Object.defineProperty(target.hostElement, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(target.hostElement, "clientHeight", { value: 200, configurable: true });
    const targetTerm = target.terminal as unknown as {
      rows: number;
      clearTextureAtlas: () => void;
      refresh: (a: number, b: number) => void;
    };
    targetTerm.rows = 24;
    targetTerm.clearTextureAtlas = vi.fn();
    targetTerm.refresh = vi.fn();

    // A co-owner pane that shares the WebGL texture atlas. Redraw on the target
    // must not call anything on this terminal — the old clearTextureAtlas() path
    // corrupted it until it got its own resize/click.
    const sibling = makeManaged();
    const siblingTerm = sibling.terminal as unknown as {
      clearTextureAtlas: () => void;
      refresh: (a: number, b: number) => void;
    };
    siblingTerm.clearTextureAtlas = vi.fn();
    siblingTerm.refresh = vi.fn();

    service.instances.set("t1", target);
    service.instances.set("t2", sibling);
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(false);
    vi.spyOn(service.resizeController, "fit").mockImplementation(() => null);

    service.resetRenderer("t1");

    expect(siblingTerm.clearTextureAtlas).not.toHaveBeenCalled();
    expect(siblingTerm.refresh).not.toHaveBeenCalled();
    expect(paddingHistory(sibling).length).toBe(0);
    expect(sibling.lastReflowAt).toBe(0);
  });

  it("routes backend recovery redraws through the resize controller", () => {
    const write = vi.fn();
    const managed = makeManaged({
      terminal: {
        element: document.createElement("div"),
        modes: { synchronizedOutputMode: false },
        write,
      } as unknown as ManagedTerminal["terminal"],
    });
    service.instances.set("t1", managed);
    const resetRenderer = vi.spyOn(service, "resetRenderer").mockImplementation(() => true);

    service.handleBackendRecovery();

    // Automatic recovery must stay UNforced — a single-arg call is the assertion
    // that #10863's deferral still shields this sweep (#11638).
    expect(resetRenderer).toHaveBeenCalledWith("t1");
    expect(managed.fitAddon.fit).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(2);
  });
});

describe("TerminalInstanceService getSynchronizedOutputMode", () => {
  let service: ReflowTestService;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../TerminalInstanceService");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    service = (mod as unknown as { terminalInstanceService: ReflowTestService })
      .terminalInstanceService;
    service.instances.clear();
  });

  afterEach(() => {
    service.instances.clear();
    document.body.innerHTML = "";
  });

  it("returns true when xterm reports an open synchronized output block", () => {
    const managed = makeManaged();
    setSyncMode(managed, true);
    service.instances.set("t1", managed);

    expect(service.getSynchronizedOutputMode("t1")).toBe(true);
  });

  it("returns false when xterm reports no synchronized output block", () => {
    const managed = makeManaged();
    service.instances.set("t1", managed);

    expect(service.getSynchronizedOutputMode("t1")).toBe(false);
  });

  it("returns null for an unknown terminal id", () => {
    expect(service.getSynchronizedOutputMode("missing")).toBeNull();
  });

  it("returns null when xterm did not surface modes (defensive)", () => {
    const managed = makeManaged();
    clearSyncModes(managed);
    service.instances.set("t1", managed);

    expect(service.getSynchronizedOutputMode("t1")).toBeNull();
  });
});

describe("TerminalInstanceService reflowHeartbeatTimer visibility gate", () => {
  let service: ReflowTestService;
  let visibilityState: DocumentVisibilityState;

  beforeEach(async () => {
    vi.useFakeTimers();
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      get: () => visibilityState,
      configurable: true,
    });

    vi.resetModules();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: ReflowTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    service.instances.clear();
    document.body.innerHTML = "";
    // Replace the live getter with a plain "visible" value so the document is
    // back to a clean state for any subsequent tests.
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
      writable: true,
    });
  });

  it("skips reflows while document is hidden", () => {
    visibilityState = "hidden";
    const managed = makeManaged();
    service.instances.set("t1", managed);

    vi.advanceTimersByTime(3000);
    expect(paddingHistory(managed).length).toBe(0);
    expect(managed.lastReflowAt).toBe(0);
  });

  it("performs reflows on heartbeat when visible", () => {
    const managed = makeManaged();
    service.instances.set("t1", managed);

    vi.advanceTimersByTime(3000);
    expect(paddingHistory(managed)).toContain("0.01px");
    expect(managed.lastReflowAt).toBeGreaterThan(0);
  });

  it("heartbeat does not reflow or stamp throttle while sync block is open", () => {
    const managed = makeManaged();
    setSyncMode(managed, true);
    service.instances.set("t1", managed);

    vi.advanceTimersByTime(3000);
    // Heartbeat tick fired but the sync-mode guard skipped without
    // stamping — so the next post-ESU heartbeat will reflow immediately.
    expect(paddingHistory(managed).length).toBe(0);
    expect(managed.lastReflowAt).toBe(0);
  });

  it("resumes reflows when visibility transitions hidden → visible", () => {
    visibilityState = "hidden";
    const managed = makeManaged();
    service.instances.set("t1", managed);

    vi.advanceTimersByTime(3000);
    expect(paddingHistory(managed).length).toBe(0);

    visibilityState = "visible";
    vi.advanceTimersByTime(3000);
    expect(paddingHistory(managed)).toContain("0.01px");
  });
});
