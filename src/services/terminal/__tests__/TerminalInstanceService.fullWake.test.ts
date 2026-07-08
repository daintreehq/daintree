// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

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

const { forceXtermReflowMock } = vi.hoisted(() => ({
  forceXtermReflowMock: vi.fn(),
}));

vi.mock("../TerminalReflowController", async () => {
  const actual = await vi.importActual<typeof import("../TerminalReflowController")>(
    "../TerminalReflowController"
  );
  return {
    ...actual,
    forceXtermReflow: forceXtermReflowMock,
  };
});

type ManagedTerminalMock = {
  isOpened: boolean;
  isAttaching: boolean;
  isFocused: boolean;
  isVisible: boolean;
  isResizeSuppressed: boolean;
  resizeSuppressionEndTime: number | undefined;
  pendingVisibilityWake?: boolean;
  latestCols: number;
  latestRows: number;
  terminal: {
    cols: number;
    rows: number;
    element: HTMLElement;
    refresh: ReturnType<typeof vi.fn>;
    open?: ReturnType<typeof vi.fn>;
    resize?: ReturnType<typeof vi.fn>;
    modes?: { synchronizedOutputMode?: boolean };
  };
  hostElement: HTMLElement;
  targetCols?: number;
  targetRows?: number;
  lastAppliedTier?: number;
  attachGeneration?: number;
  revealPendingRepair?: boolean;
  revealPendingGeneration?: number;
};

type FullWakeTestService = {
  instances: Map<string, ManagedTerminalMock>;
  resizeController: {
    applyDeferredResize: (id: string) => void;
    lockResize: (id: string, locked: boolean, ms?: number) => void;
    reconcileGeometryFresh: (id: string) => boolean;
    fit: (id: string) => { cols: number; rows: number } | null;
    forceImmediateResize: (id: string) => void;
  };
  dataBuffer: { resumeFlush: (id: string) => void; resetForTerminal: (id: string) => void };
  webGLManager: {
    repairAtlasForReactivation: (id: string) => boolean;
    isActive: (id: string) => boolean;
    getMode: () => "webgl" | "dom";
    ensureContext: (id: string, managed: ManagedTerminalMock) => void;
  };
  handlePostWake: (id: string) => void;
  setVisible: (id: string, isVisible: boolean, expectedGeneration?: number) => void;
  rendererPolicy: { applyRendererPolicy: (id: string, tier: number) => void };
  ensureOpened: (id: string, managed: ManagedTerminalMock) => void;
  ensureDeferredAddons: (id: string, managed: ManagedTerminalMock) => void;
  wantsWebGLAtTier: (managed: ManagedTerminalMock, tier: number | undefined) => boolean;
  fullWakeForVisibilityRestore: (id: string) => Promise<void>;
  repaintForReveal: (id: string, opts?: { trustDomVisibility?: boolean }) => boolean;
  revealTerminal: (id: string) => Promise<boolean>;
  settleWaiters: { notifyAttachSettledWaiters: (id: string) => void };
};

function makeInstance(overrides: Partial<ManagedTerminalMock> = {}): ManagedTerminalMock {
  return {
    isOpened: true,
    isAttaching: false,
    isFocused: false,
    isVisible: true,
    isResizeSuppressed: false,
    resizeSuppressionEndTime: undefined,
    latestCols: 80,
    latestRows: 24,
    terminal: {
      cols: 80,
      rows: 24,
      element: document.createElement("div"),
      refresh: vi.fn(),
    },
    hostElement: document.createElement("div"),
    ...overrides,
  };
}

// jsdom does no layout, so connect + stub a non-zero box to model a host that
// hostHasRenderableDims() will accept (a foreground-presented project view).
function renderableHost(): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
  document.body.appendChild(el);
  return el;
}

describe("TerminalInstanceService.fullWakeForVisibilityRestore (#8562)", () => {
  let service: FullWakeTestService;

  beforeEach(async () => {
    vi.clearAllMocks();
    forceXtermReflowMock.mockReset();
    const imported = await import("../TerminalInstanceService");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    service = imported.terminalInstanceService as unknown as FullWakeTestService;
    service.instances.clear();
  });

  afterEach(() => {
    if (service) service.instances.clear();
  });

  // Hibernation removed: this path is now a SYNCHRONOUS plain repaint — there is
  // no wakeManager.wakeAndRestore (reset+replay), no async wake, and no discard.
  it("runs applyDeferredResize → forceXtermReflow → repairAtlas → refresh → handlePostWake → resumeFlush in order", async () => {
    const id = "fw-1";
    const instance = makeInstance();
    service.instances.set(id, instance);

    const calls: string[] = [];
    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {
        calls.push("applyDeferredResize");
      });
    forceXtermReflowMock.mockImplementation(() => {
      calls.push("forceXtermReflow");
    });
    const repairAtlas = vi
      .spyOn(service.webGLManager, "repairAtlasForReactivation")
      .mockImplementation(() => {
        calls.push("repairAtlasForReactivation");
        return true;
      });
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {
      calls.push("handlePostWake");
    });
    const resumeFlush = vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {
      calls.push("resumeFlush");
    });
    const resetForTerminal = vi
      .spyOn(service.dataBuffer, "resetForTerminal")
      .mockImplementation(() => {
        calls.push("resetForTerminal");
      });
    (instance.terminal.refresh as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push("refresh");
    });

    await service.fullWakeForVisibilityRestore(id);

    // The buffer is already current (nothing was suspended), so the reveal is a
    // plain repaint that ends in a flush — never a snapshot replay + discard.
    expect(calls).toEqual([
      "applyDeferredResize",
      "forceXtermReflow",
      "repairAtlasForReactivation",
      "refresh",
      "handlePostWake",
      "resumeFlush",
    ]);

    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    expect(forceXtermReflowMock).toHaveBeenCalledWith(instance.terminal.element);
    expect(repairAtlas).toHaveBeenCalledWith(id);
    expect(handlePostWake).toHaveBeenCalledWith(id);
    expect(resumeFlush).toHaveBeenCalledWith(id);
    // No reset+replay path means no FIFO discard.
    expect(resetForTerminal).not.toHaveBeenCalled();
  });

  it("defers paint-interleave ops while a DEC 2026 synchronized-output block is open, but still runs the data path (#10632)", async () => {
    // The paint ops (forceXtermReflow / repairAtlasForReactivation / refresh)
    // must not fire mid-block; the data path (applyDeferredResize + handlePostWake
    // + resumeFlush) must. The obligation is handed to the watchdog
    // (revealPendingRepair) since this method has no retry-return.
    const id = "fw-sync";
    const instance = makeInstance({
      hostElement: renderableHost(),
      attachGeneration: 3,
      terminal: {
        cols: 80,
        rows: 24,
        element: document.createElement("div"),
        refresh: vi.fn(),
        modes: { synchronizedOutputMode: true },
      },
    });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});
    const repairAtlas = vi
      .spyOn(service.webGLManager, "repairAtlasForReactivation")
      .mockReturnValue(true);
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    const resumeFlush = vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    // Data path still runs.
    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    expect(handlePostWake).toHaveBeenCalledWith(id);
    expect(resumeFlush).toHaveBeenCalledWith(id);
    // Paint-interleave ops are deferred.
    expect(forceXtermReflowMock).not.toHaveBeenCalled();
    expect(repairAtlas).not.toHaveBeenCalled();
    expect(instance.terminal.refresh).not.toHaveBeenCalled();
    // Paint obligation handed to the watchdog, owned by the attach generation.
    expect(instance.revealPendingRepair).toBe(true);
    expect(instance.revealPendingGeneration).toBe(3);
  });

  it("handlePostWake skips geometry re-fit for an alt-screen pane on reveal (#10807)", async () => {
    const id = "fw-alt-postwake";
    const instance = makeInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (instance as any).isAltBuffer = true;
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    // Earlier tests mock service.handlePostWake; beforeEach only clears call
    // history (clearAllMocks), not implementations — restore the REAL one, then
    // spy call-through, so the alt early-return is actually exercised.
    vi.spyOn(service, "handlePostWake").mockRestore();
    const handlePostWake = vi.spyOn(service, "handlePostWake");

    // For an alt pane the real handlePostWake must early-return after
    // checkStaleDirecting and skip every geometry op.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resize = service.resizeController as any;
    const fit = vi.spyOn(resize, "fit").mockReturnValue(null);
    const sendPtyResize = vi.spyOn(resize, "sendPtyResize").mockImplementation(() => {});
    const forceImmediateResize = vi
      .spyOn(resize, "forceImmediateResize")
      .mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(handlePostWake).toHaveBeenCalledWith(id);
    expect(fit).not.toHaveBeenCalled();
    expect(sendPtyResize).not.toHaveBeenCalled();
    expect(forceImmediateResize).not.toHaveBeenCalled();
  });

  it("repairs the WebGL atlas before the refresh (#9679)", async () => {
    const id = "fw-webgl";
    const instance = makeInstance();
    service.instances.set(id, instance);

    const calls: string[] = [];
    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    const repair = vi
      .spyOn(service.webGLManager, "repairAtlasForReactivation")
      .mockImplementation(() => {
        calls.push("repairAtlasForReactivation");
        return true;
      });
    (instance.terminal.refresh as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push("refresh");
    });
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(repair).toHaveBeenCalledWith(id);
    // The stale-atlas repair must land before the repaint so the first composited
    // frame after reactivation samples the repaired model.
    expect(calls).toEqual(["repairAtlasForReactivation", "refresh"]);
  });

  it("completes the repaint even when atlas repair reports no WebGL context (DOM renderer)", async () => {
    const id = "fw-dom";
    const instance = makeInstance();
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(false);
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    const resumeFlush = vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    // A false repair (no pooled context) must not short-circuit the repaint.
    expect(handlePostWake).toHaveBeenCalledWith(id);
    expect(resumeFlush).toHaveBeenCalledWith(id);
  });

  it("always runs handlePostWake and resumeFlush on the synchronous repaint", async () => {
    const id = "fw-2";
    const instance = makeInstance();
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    const resumeFlush = vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    // No wake ok/fail branch anymore: the repaint always reflows + flushes.
    expect(handlePostWake).toHaveBeenCalledWith(id);
    expect(resumeFlush).toHaveBeenCalledWith(id);
  });

  it("bypasses the resize lock when isResizeSuppressed is true", async () => {
    const id = "fw-3";
    const futureMs = Date.now() + 1500;
    const instance = makeInstance({
      isResizeSuppressed: true,
      resizeSuppressionEndTime: futureMs,
    });
    service.instances.set(id, instance);

    const lockResize = vi
      .spyOn(service.resizeController, "lockResize")
      .mockImplementation(() => {});
    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    // Unlock before applyDeferredResize, relock after with remaining TTL
    expect(lockResize).toHaveBeenNthCalledWith(1, id, false);
    expect(lockResize).toHaveBeenNthCalledWith(2, id, true, expect.any(Number));
    const relockTtl = lockResize.mock.calls[1]?.[2] as number | undefined;
    expect(relockTtl).toBeDefined();
    expect(relockTtl).toBeGreaterThan(0);
    expect(relockTtl).toBeLessThanOrEqual(1500);
  });

  it("still bypasses the resize lock when isResizeSuppressed is true but the end time is missing", async () => {
    const id = "fw-3b";
    const instance = makeInstance({
      isResizeSuppressed: true,
      resizeSuppressionEndTime: undefined,
    });
    service.instances.set(id, instance);

    const calls: string[] = [];
    const lockResize = vi
      .spyOn(service.resizeController, "lockResize")
      .mockImplementation((_id, locked) => {
        calls.push(locked ? "lock" : "unlock");
      });
    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {
      calls.push("applyDeferredResize");
    });
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(calls).toEqual(["unlock", "applyDeferredResize", "lock"]);
    expect(lockResize).toHaveBeenNthCalledWith(1, id, false);
    expect(lockResize).toHaveBeenNthCalledWith(2, id, true, 0);
  });

  it("does not touch the resize lock when isResizeSuppressed is false", async () => {
    const id = "fw-4";
    const instance = makeInstance({ isResizeSuppressed: false });
    service.instances.set(id, instance);

    const lockResize = vi
      .spyOn(service.resizeController, "lockResize")
      .mockImplementation(() => {});
    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(lockResize).not.toHaveBeenCalled();
  });

  it("bails when terminal is not opened and the host is not measurable", async () => {
    const id = "fw-5";
    const instance = makeInstance({ isOpened: false });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(applyDeferredResize).not.toHaveBeenCalled();
  });

  it("syncs geometry but defers the repaint when terminal is attaching (#9702, #10070)", async () => {
    const id = "fw-6";
    const instance = makeInstance({ isAttaching: true });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    // Geometry sync is safe mid-attach and must run so the grid is corrected
    // before the warm paint gate drops the bridge (#10070).
    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    // The repaint must defer to avoid racing the attach's own post-rAF
    // reconciliation (#9702).
    expect(handlePostWake).not.toHaveBeenCalled();
    // The skipped repaint must leave a flag so it re-runs once attach settles.
    expect(instance.pendingVisibilityWake).toBe(true);
  });

  it("keeps pendingVisibilityWake set when the geometry sync throws while attaching (#10070)", async () => {
    const id = "fw-6c";
    const instance = makeInstance({ isAttaching: true });
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {
      throw new Error("terminal disposed mid-wake");
    });
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});

    await expect(service.fullWakeForVisibilityRestore(id)).rejects.toThrow(
      "terminal disposed mid-wake"
    );

    expect(instance.pendingVisibilityWake).toBe(true);
    expect(handlePostWake).not.toHaveBeenCalled();
  });

  it("bypasses the resize lock for the geometry sync even while attaching (#10070)", async () => {
    const id = "fw-6b";
    const instance = makeInstance({
      isAttaching: true,
      isResizeSuppressed: true,
      resizeSuppressionEndTime: Date.now() + 1500,
    });
    service.instances.set(id, instance);

    const calls: string[] = [];
    const lockResize = vi
      .spyOn(service.resizeController, "lockResize")
      .mockImplementation((_id, locked) => {
        calls.push(locked ? "lock" : "unlock");
      });
    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {
      calls.push("applyDeferredResize");
    });
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(calls).toEqual(["unlock", "applyDeferredResize", "lock"]);
    expect(lockResize).toHaveBeenNthCalledWith(1, id, false);
    expect(lockResize).toHaveBeenNthCalledWith(2, id, true, expect.any(Number));
    expect(handlePostWake).not.toHaveBeenCalled();
    expect(instance.pendingVisibilityWake).toBe(true);
  });

  it("clears a stale pendingVisibilityWake flag when proceeding with an immediate repaint (#9702)", async () => {
    const id = "fw-clear";
    const instance = makeInstance({ pendingVisibilityWake: true });
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(instance.pendingVisibilityWake).toBe(false);
  });

  it("re-runs the deferred repaint via notifyAttachSettledWaiters once attach settles (#9702)", async () => {
    const id = "fw-deferred";
    // hostElement must be connected for isAttachSettled() to return true.
    const hostElement = document.createElement("div");
    document.body.appendChild(hostElement);
    const instance = makeInstance({
      isAttaching: false,
      pendingVisibilityWake: true,
      hostElement,
    });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    service.settleWaiters.notifyAttachSettledWaiters(id);
    // The deferred repaint is dispatched as a floating promise; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(instance.pendingVisibilityWake).toBe(false);
    expect(applyDeferredResize).toHaveBeenCalledWith(id);

    document.body.removeChild(hostElement);
  });

  it("does not fire a deferred repaint when pendingVisibilityWake is unset (#9702)", async () => {
    const id = "fw-nodefer";
    const hostElement = document.createElement("div");
    document.body.appendChild(hostElement);
    const instance = makeInstance({ isAttaching: false, hostElement });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});

    service.settleWaiters.notifyAttachSettledWaiters(id);
    await Promise.resolve();
    await Promise.resolve();

    expect(applyDeferredResize).not.toHaveBeenCalled();

    document.body.removeChild(hostElement);
  });

  it("no-ops cleanly when terminal does not exist", async () => {
    await expect(service.fullWakeForVisibilityRestore("missing")).resolves.toBeUndefined();
  });

  // Long-dwell rehydration: an unopened terminal (its xterm torn down while the
  // project view was backgrounded/evicted) can't be re-opened behind the
  // anti-flash bridge (zero host box). The foreground reveal pass re-runs this
  // method once the view is presented; it must finish the open then repaint.
  it("opens an unopened terminal when the host is foreground-measurable, then repaints", async () => {
    const id = "fw-open-fg";
    const host = renderableHost();
    const instance = makeInstance({ isOpened: false, hostElement: host });
    service.instances.set(id, instance);

    const ensureOpened = vi.spyOn(service, "ensureOpened").mockImplementation(() => {
      instance.isOpened = true;
    });
    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(ensureOpened).toHaveBeenCalledWith(id, instance);
    expect(handlePostWake).toHaveBeenCalledWith(id);

    document.body.removeChild(host);
  });

  it("does not open an unopened terminal whose host is detached (still occluded)", async () => {
    const id = "fw-open-occluded";
    const instance = makeInstance({ isOpened: false });
    service.instances.set(id, instance);

    const ensureOpened = vi.spyOn(service, "ensureOpened").mockImplementation(() => {});
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(ensureOpened).not.toHaveBeenCalled();
    expect(handlePostWake).not.toHaveBeenCalled();
  });

  it("does not open an unopened terminal whose connected host has a zero layout box (occluded behind bridge)", async () => {
    const id = "fw-open-zerobox";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const instance = makeInstance({ isOpened: false, hostElement: host });
    service.instances.set(id, instance);

    const ensureOpened = vi.spyOn(service, "ensureOpened").mockImplementation(() => {});
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(ensureOpened).not.toHaveBeenCalled();
    expect(handlePostWake).not.toHaveBeenCalled();

    document.body.removeChild(host);
  });

  // Exercises the real ensureOpened() primitive (not a spy) so a regression that
  // stops calling terminal.open() or stops flipping isOpened is caught.
  it("ensureOpened opens xterm against the host and flips isOpened without a remount", () => {
    vi.spyOn(service, "ensureOpened").mockRestore();

    const id = "eo-1";
    const host = renderableHost();
    const open = vi.fn();
    const instance = makeInstance({ isOpened: false, hostElement: host });
    instance.terminal.open = open;
    instance.terminal.resize = vi.fn();
    service.instances.set(id, instance);

    vi.spyOn(service, "ensureDeferredAddons").mockImplementation(() => {});
    vi.spyOn(service, "wantsWebGLAtTier").mockReturnValue(false);

    service.ensureOpened(id, instance);

    expect(open).toHaveBeenCalledWith(host);
    expect(instance.isOpened).toBe(true);

    document.body.removeChild(host);
  });
});

describe("TerminalInstanceService.revealTerminal (foreground reveal routing)", () => {
  let service: FullWakeTestService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const imported = await import("../TerminalInstanceService");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    service = imported.terminalInstanceService as unknown as FullWakeTestService;
    service.instances.clear();
  });

  afterEach(() => {
    if (service) service.instances.clear();
  });

  it("takes the cheap repaint path for an opened, live terminal", async () => {
    const id = "rev-1";
    service.instances.set(id, makeInstance({ isOpened: true }));

    const fullWake = vi.spyOn(service, "fullWakeForVisibilityRestore").mockResolvedValue(undefined);
    const repaint = vi.spyOn(service, "repaintForReveal").mockImplementation(() => true);

    await expect(service.revealTerminal(id)).resolves.toBe(true);

    expect(repaint).toHaveBeenCalledWith(id, { trustDomVisibility: true });
    expect(fullWake).not.toHaveBeenCalled();
  });

  it("takes the full rehydration path for an un-opened terminal", async () => {
    const id = "rev-3";
    service.instances.set(id, makeInstance({ isOpened: false, hostElement: renderableHost() }));

    const fullWake = vi.spyOn(service, "fullWakeForVisibilityRestore").mockResolvedValue(undefined);
    const repaint = vi.spyOn(service, "repaintForReveal").mockImplementation(() => true);

    await service.revealTerminal(id);

    expect(fullWake).toHaveBeenCalledWith(id);
    expect(repaint).not.toHaveBeenCalled();
  });

  it("reports not-settled when the full wake only deferred behind an in-flight attach", async () => {
    const id = "rev-attach";
    const inst = makeInstance({
      isOpened: false,
      hostElement: renderableHost(),
    });
    service.instances.set(id, inst);

    // Simulate fullWakeForVisibilityRestore opening the pane but DEFERRING the
    // actual wake/repaint because an attach is in flight — it sets
    // pendingVisibilityWake and leaves isAttaching true. The reveal must report
    // "retry" so the sweep doesn't spend its confirm paints before the deferred
    // wake re-runs on attach-settle.
    vi.spyOn(service, "fullWakeForVisibilityRestore").mockImplementation(async () => {
      inst.isOpened = true;
      inst.isAttaching = true;
      inst.pendingVisibilityWake = true;
    });

    await expect(service.revealTerminal(id)).resolves.toBe(false);
  });

  it("defers the rehydration (reports not-paintable) when the host has no layout box", async () => {
    const id = "rev-4";
    // Bare, unconnected host → zero box → not paintable yet. The sweep should
    // retry on a later frame instead of opening against an unmeasurable host.
    service.instances.set(id, makeInstance({ isOpened: false }));

    const fullWake = vi.spyOn(service, "fullWakeForVisibilityRestore").mockResolvedValue(undefined);

    await expect(service.revealTerminal(id)).resolves.toBe(false);

    expect(fullWake).not.toHaveBeenCalled();
  });

  it("reports settled (true) when the terminal does not exist", async () => {
    const fullWake = vi.spyOn(service, "fullWakeForVisibilityRestore").mockResolvedValue(undefined);
    const repaint = vi.spyOn(service, "repaintForReveal").mockImplementation(() => true);

    // Gone → nothing to repaint and nothing to retry.
    await expect(service.revealTerminal("missing")).resolves.toBe(true);

    expect(fullWake).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
  });
});

describe("TerminalInstanceService.repaintForReveal grid reconcile", () => {
  let service: FullWakeTestService;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Sibling describes spy repaintForReveal with mockImplementation on the
    // shared singleton; clearAllMocks keeps that impl, so restore the real
    // method before exercising it here.
    vi.restoreAllMocks();
    forceXtermReflowMock.mockReset();
    const imported = await import("../TerminalInstanceService");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    service = imported.terminalInstanceService as unknown as FullWakeTestService;
    service.instances.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (service) service.instances.clear();
  });

  function openedLiveInstance(): ManagedTerminalMock {
    const element = document.createElement("div");
    document.body.appendChild(element);
    return makeInstance({
      isOpened: true,
      isVisible: true,
      hostElement: renderableHost(),
      terminal: { cols: 80, rows: 24, element, refresh: vi.fn() },
    });
  }

  it("reconciles the grid through resizeController.reconcileGeometryFresh", () => {
    const id = "repaint-1";
    service.instances.set(id, openedLiveInstance());

    vi.spyOn(service.webGLManager, "isActive").mockReturnValue(true);
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    const reconcile = vi
      .spyOn(service.resizeController, "reconcileGeometryFresh")
      .mockReturnValue(true);

    expect(service.repaintForReveal(id)).toBe(true);
    // The reveal repaint must drive a fresh-measure grid reflow — the one step
    // that fixes garbled wrapping and that the old handlePostWake path could not
    // perform under the project-switch resize lock.
    expect(reconcile).toHaveBeenCalledWith(id);
  });

  function staleVisibleAgentInstance(): ManagedTerminalMock {
    const element = document.createElement("div");
    document.body.appendChild(element);
    return makeInstance({
      isOpened: true,
      isVisible: false, // stale on a warm WebContentsView resume (#10632 item 4)
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
      hostElement: renderableHost(), // DOM truth: the pane IS on-screen
      terminal: { cols: 80, rows: 24, element, refresh: vi.fn() },
    });
  }

  it("reattaches a dropped WebGL context on a warm reveal even when isVisible is stale-false (W1)", () => {
    const id = "repaint-w1";
    service.instances.set(id, staleVisibleAgentInstance());

    vi.spyOn(service.webGLManager, "isActive").mockReturnValue(false); // context dropped on freeze
    vi.spyOn(service.webGLManager, "getMode").mockReturnValue("webgl");
    const ensure = vi.spyOn(service.webGLManager, "ensureContext").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    vi.spyOn(service.resizeController, "reconcileGeometryFresh").mockReturnValue(true);

    // The warm reveal path trusts DOM truth → reattaches despite the stale flag,
    // instead of stranding the pane on the DOM renderer until the watchdog.
    expect(service.repaintForReveal(id, { trustDomVisibility: true })).toBe(true);
    expect(ensure).toHaveBeenCalledWith(id, service.instances.get(id));
  });

  it("does NOT reattach WebGL on a non-reveal repaint with a stale isVisible=false (assistant transition)", () => {
    const id = "repaint-noassist";
    service.instances.set(id, staleVisibleAgentInstance());

    vi.spyOn(service.webGLManager, "isActive").mockReturnValue(false);
    vi.spyOn(service.webGLManager, "getMode").mockReturnValue("webgl");
    const ensure = vi.spyOn(service.webGLManager, "ensureContext").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    vi.spyOn(service.resizeController, "reconcileGeometryFresh").mockReturnValue(true);

    // No trust (the assistant show/hide-transition callers): the isVisible gate
    // holds, so a transform-hidden pane can't accumulate a fleet-wide WebGL want
    // and trip the count-based DOM flip (#10671 / Codex review of W1).
    expect(service.repaintForReveal(id)).toBe(true);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("reports not-paintable (retry) when the fresh reconcile finds no measurable box", () => {
    const id = "repaint-2";
    service.instances.set(id, openedLiveInstance());

    vi.spyOn(service.webGLManager, "isActive").mockReturnValue(true);
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(true);
    vi.spyOn(service.resizeController, "reconcileGeometryFresh").mockReturnValue(false);

    // A false reconcile must propagate so revealUntilStable retries on a later
    // frame rather than spending a confirm paint against an unmeasurable pane.
    expect(service.repaintForReveal(id)).toBe(false);
  });

  it("setVisible(true) defers its unpause reflow while a synchronized block is open, hands obligation to watchdog (#10632)", () => {
    // The visibility path (grid IntersectionObserver → setVisible(id, true) on
    // switch-back) reflows unconditionally; that forceXtermReflow bypasses
    // xterm's atomic-at-ESU buffering. It must defer mid-block. Geometry sync
    // (applyDeferredResize) must still run.
    const id = "sv-sync";
    const instance = makeInstance({
      isVisible: false,
      attachGeneration: 5,
      hostElement: renderableHost(),
      terminal: {
        cols: 80,
        rows: 24,
        element: document.createElement("div"),
        refresh: vi.fn(),
        modes: { synchronizedOutputMode: true },
      },
    });
    service.instances.set(id, instance);
    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});
    vi.spyOn(service.rendererPolicy, "applyRendererPolicy").mockImplementation(() => {});

    service.setVisible(id, true);

    expect(applyDeferredResize).toHaveBeenCalledWith(id); // geometry still synced
    expect(forceXtermReflowMock).not.toHaveBeenCalled(); // reflow deferred mid-block
    expect(instance.revealPendingRepair).toBe(true);
    expect(instance.revealPendingGeneration).toBe(5);
  });

  it("setVisible(true) reflows immediately on reveal when no synchronized block is open", () => {
    const id = "sv-nosync";
    const instance = makeInstance({
      isVisible: false,
      attachGeneration: 5,
      hostElement: renderableHost(),
      terminal: {
        cols: 80,
        rows: 24,
        element: document.createElement("div"),
        refresh: vi.fn(),
        modes: { synchronizedOutputMode: false },
      },
    });
    service.instances.set(id, instance);
    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.rendererPolicy, "applyRendererPolicy").mockImplementation(() => {});

    service.setVisible(id, true);

    expect(forceXtermReflowMock).toHaveBeenCalledWith(instance.terminal.element);
    expect(instance.revealPendingRepair).toBeUndefined();
  });

  it("defers (returns false) while a DEC 2026 synchronized-output block is open (#10632)", () => {
    const id = "repaint-sync";
    const instance = openedLiveInstance();
    // Live agent mid-frame: repainting now would interleave a paint with the
    // buffered range. The reveal path must defer just like the watchdog does.
    instance.terminal.modes = { synchronizedOutputMode: true };
    service.instances.set(id, instance);

    vi.spyOn(service.webGLManager, "isActive").mockReturnValue(true);
    const repairAtlas = vi
      .spyOn(service.webGLManager, "repairAtlasForReactivation")
      .mockReturnValue(true);
    const reconcile = vi
      .spyOn(service.resizeController, "reconcileGeometryFresh")
      .mockReturnValue(true);

    expect(service.repaintForReveal(id)).toBe(false);
    // None of the interleaving operations may run mid-block.
    expect(reconcile).not.toHaveBeenCalled();
    expect(repairAtlas).not.toHaveBeenCalled();
    expect(forceXtermReflowMock).not.toHaveBeenCalled();
  });
});

describe("fullWakeForVisibilityRestore streaming-quiescence gate (#10863 wake-path half)", () => {
  let service: FullWakeTestService;

  beforeEach(async () => {
    // The service is a module singleton — spies installed by a previous test
    // (stubPostWake) survive clearAllMocks (it clears history, not
    // implementations). Restore first so each test starts from the real
    // methods and installs only its own stubs.
    vi.restoreAllMocks();
    vi.clearAllMocks();
    forceXtermReflowMock.mockReset();
    const imported = await import("../TerminalInstanceService");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    service = imported.terminalInstanceService as unknown as FullWakeTestService;
    service.instances.clear();
  });

  afterEach(() => {
    if (service) service.instances.clear();
  });

  // The applyDeferredResize-gate tests stub the post-wake tail so jsdom's
  // missing layout APIs (checkVisibility in fit()) can't fail them; the
  // handlePostWake gate has its own un-stubbed test below.
  function stubPostWake() {
    vi.spyOn(
      service as unknown as { handlePostWake: (id: string) => void },
      "handlePostWake"
    ).mockImplementation(() => {});
  }

  type StreamingFields = {
    pendingWrites?: number;
    lastWriteAt?: number;
    isAltBuffer?: boolean;
    fitAddon?: { fit: () => void; proposeDimensions?: () => { cols: number; rows: number } };
    lastReflowAt?: number;
  };

  function streamingInstance(overrides: Partial<ManagedTerminalMock> & StreamingFields = {}) {
    return makeInstance({
      attachGeneration: 3,
      ...overrides,
    }) as ManagedTerminalMock & StreamingFields;
  }

  it("defers the geometry sync to the watchdog for a streaming main-buffer pane whose grid would change", async () => {
    stubPostWake();
    const id = "wake-streaming-delta";
    const instance = streamingInstance({
      // Grid delta: cached target disagrees with the live xterm grid.
      latestCols: 92,
      latestRows: 30,
      pendingWrites: 2, // a queued batch is still parsing — mid-stream
    });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(applyDeferredResize).not.toHaveBeenCalled();
    expect(instance.revealPendingRepair).toBe(true);
    expect(instance.revealPendingGeneration).toBe(instance.attachGeneration);
  });

  it("still applies the geometry sync for a streaming pane with NO grid delta (free no-op keeps #10070 correction)", async () => {
    stubPostWake();
    const id = "wake-streaming-nodelta";
    const instance = streamingInstance({ pendingWrites: 2 }); // latest == terminal grid
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    expect(instance.revealPendingRepair).toBeUndefined();
  });

  it("does not defer an alt-screen pane — the alt buffer is exempt from the re-wrap hazard", async () => {
    stubPostWake();
    const id = "wake-streaming-alt";
    const instance = streamingInstance({
      latestCols: 92,
      latestRows: 30,
      pendingWrites: 2,
      isAltBuffer: true,
    });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    expect(instance.revealPendingRepair).toBeUndefined();
  });

  it("applies the geometry sync once the stream quiesces (stale lastWriteAt, no pending writes)", async () => {
    stubPostWake();
    const id = "wake-quiescent-delta";
    const instance = streamingInstance({
      latestCols: 92,
      latestRows: 30,
      lastWriteAt: Date.now() - 10_000, // long past REVEAL_REWRAP_QUIESCENT_MS
    });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    expect(instance.revealPendingRepair).toBeUndefined();
  });

  it("handlePostWake itself never re-fits a streaming pane whose grid would change (the full no-geometry contract)", async () => {
    // NO handlePostWake stub — this pins the production tail: fit() and
    // forceImmediateResize() must not run for a streaming main-buffer pane
    // with a real grid delta; the obligation goes to the watchdog instead.
    const id = "wake-postwake-streaming";
    const instance = streamingInstance({
      pendingWrites: 2, // streaming — but latest == grid, so the fullWake gate passes through
      fitAddon: {
        fit: vi.fn(),
        // The container proposes a grid different from the live one: the fit
        // WOULD re-wrap. This is the divergence handlePostWake must defer on.
        proposeDimensions: () => ({ cols: 92, rows: 30 }),
      },
    });
    service.instances.set(id, instance);

    const fit = vi.spyOn(service.resizeController, "fit").mockReturnValue(null);
    const forceImmediateResize = vi
      .spyOn(service.resizeController, "forceImmediateResize")
      .mockImplementation(() => {});
    // Paint-only tail — not part of the geometry contract under test, and its
    // internals need real xterm/DOM plumbing jsdom mocks don't have.
    vi.spyOn(
      service as unknown as { maybeReflowTerminal: (managed: unknown) => void },
      "maybeReflowTerminal"
    ).mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(fit).not.toHaveBeenCalled();
    expect(forceImmediateResize).not.toHaveBeenCalled();
    expect(instance.revealPendingRepair).toBe(true);
    expect(instance.revealPendingGeneration).toBe(instance.attachGeneration);
  });
});
