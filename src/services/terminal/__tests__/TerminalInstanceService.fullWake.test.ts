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
  isHibernated: boolean;
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
  wakeManager: {
    wakeAndRestore: (id: string) => Promise<{ ok: boolean; replayedMainBuffer: boolean }>;
  };
  resizeController: {
    applyDeferredResize: (id: string) => void;
    lockResize: (id: string, locked: boolean, ms?: number) => void;
    reconcileGeometryFresh: (id: string) => boolean;
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
  unhibernate: (id: string) => void;
  ensureOpened: (id: string, managed: ManagedTerminalMock) => void;
  ensureDeferredAddons: (id: string, managed: ManagedTerminalMock) => void;
  wantsWebGLAtTier: (managed: ManagedTerminalMock, tier: number | undefined) => boolean;
  fullWakeForVisibilityRestore: (id: string) => Promise<void>;
  repaintForReveal: (id: string, opts?: { trustDomVisibility?: boolean }) => boolean;
  revealTerminal: (id: string) => Promise<boolean>;
  notifyAttachSettledWaiters: (id: string) => void;
};

function makeInstance(overrides: Partial<ManagedTerminalMock> = {}): ManagedTerminalMock {
  return {
    isOpened: true,
    isAttaching: false,
    isHibernated: false,
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

  it("runs applyDeferredResize → forceXtermReflow → wakeAndRestore → refresh → handlePostWake → discard in order on replay success", async () => {
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
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockImplementation(async () => {
        calls.push("wakeAndRestore");
        return { ok: true, replayedMainBuffer: true };
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
    const { terminalClient } = await import("@/clients");
    vi.mocked(terminalClient.discardPortAcks).mockImplementation(() => {
      calls.push("discardPortAcks");
    });

    await service.fullWakeForVisibilityRestore(id);

    // The replayed snapshot already contains the held bytes, so the sequence
    // ends with the discard (ack the FIFO, then wipe the queue), not a flush
    // (#9910).
    expect(calls).toEqual([
      "applyDeferredResize",
      "forceXtermReflow",
      "wakeAndRestore",
      "refresh",
      "handlePostWake",
      "discardPortAcks",
      "resetForTerminal",
    ]);

    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    expect(forceXtermReflowMock).toHaveBeenCalledWith(instance.terminal.element);
    expect(wakeAndRestore).toHaveBeenCalledWith(id);
    expect(handlePostWake).toHaveBeenCalledWith(id);
    expect(resetForTerminal).toHaveBeenCalledWith(id);
    expect(resumeFlush).not.toHaveBeenCalled();
    expect(terminalClient.discardPortAcks).toHaveBeenCalledWith(id);
  });

  it("defers paint-interleave ops while a DEC 2026 synchronized-output block is open, but still runs the data restore (#10632)", async () => {
    // Third unguarded interleave path: the switch-back WAKE path. The paint ops
    // (forceXtermReflow / repairAtlasForReactivation / refresh) must not fire
    // mid-block; the data path (applyDeferredResize + wakeAndRestore) must. The
    // obligation is handed to the watchdog (revealPendingRepair) since this
    // method has no retry-return. Fails on the pre-fix code, where all three
    // paint ops ran unconditionally.
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
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: false });
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    // Data path still runs.
    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    expect(wakeAndRestore).toHaveBeenCalledWith(id);
    // Paint-interleave ops are deferred.
    expect(forceXtermReflowMock).not.toHaveBeenCalled();
    expect(repairAtlas).not.toHaveBeenCalled();
    expect(instance.terminal.refresh).not.toHaveBeenCalled();
    // Paint obligation handed to the watchdog, owned by the attach generation.
    expect(instance.revealPendingRepair).toBe(true);
    expect(instance.revealPendingGeneration).toBe(3);
  });

  it("flushes (no discard) when the wake succeeds without a main-buffer replay (alt-buffer)", async () => {
    const id = "fw-1b";
    const instance = makeInstance();
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue({
      ok: true,
      replayedMainBuffer: false,
    });
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    const resumeFlush = vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});
    const resetForTerminal = vi
      .spyOn(service.dataBuffer, "resetForTerminal")
      .mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(handlePostWake).toHaveBeenCalledWith(id);
    expect(resumeFlush).toHaveBeenCalledWith(id);
    expect(resetForTerminal).not.toHaveBeenCalled();
  });

  it("repairs the WebGL atlas before the async wakeAndRestore IPC (#9679)", async () => {
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
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockImplementation(async () => {
      calls.push("wakeAndRestore");
      return { ok: true, replayedMainBuffer: true };
    });
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resetForTerminal").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(repair).toHaveBeenCalledWith(id);
    // The stale-atlas repair must land synchronously before the wake IPC so the
    // first composited frame after reactivation samples the repaired model.
    expect(calls).toEqual(["repairAtlasForReactivation", "wakeAndRestore"]);
  });

  it("still wakes when atlas repair reports no WebGL context (DOM renderer)", async () => {
    const id = "fw-dom";
    const instance = makeInstance();
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockReturnValue(false);
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: true });
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    // A false repair (no pooled context) must not short-circuit the wake.
    expect(wakeAndRestore).toHaveBeenCalledWith(id);
  });

  it("still calls resumeFlush when wakeAndRestore returns false, but skips handlePostWake", async () => {
    const id = "fw-2";
    const instance = makeInstance();
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue({
      ok: false,
      replayedMainBuffer: false,
    });
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    const resumeFlush = vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(handlePostWake).not.toHaveBeenCalled();
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
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue({
      ok: true,
      replayedMainBuffer: true,
    });
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    // Unlock before applyDeferredResize, relock after with remaining TTL
    expect(lockResize).toHaveBeenNthCalledWith(1, id, false);
    expect(lockResize).toHaveBeenNthCalledWith(2, id, true, expect.any(Number));
    // Second call's TTL is the remaining suppression window — positive and ≤ 1500ms
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
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue({
      ok: true,
      replayedMainBuffer: true,
    });
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    // Unlock must precede the resize so geometry resyncs, then relock after —
    // even with no end time (TTL falls back to 0).
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
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue({
      ok: true,
      replayedMainBuffer: true,
    });
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(lockResize).not.toHaveBeenCalled();
  });

  it("bails when terminal is not opened", async () => {
    const id = "fw-5";
    const instance = makeInstance({ isOpened: false });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: true });

    await service.fullWakeForVisibilityRestore(id);

    expect(applyDeferredResize).not.toHaveBeenCalled();
    expect(wakeAndRestore).not.toHaveBeenCalled();
  });

  it("syncs geometry but defers the async wake when terminal is attaching (#9702, #10070)", async () => {
    const id = "fw-6";
    const instance = makeInstance({ isAttaching: true });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: true });

    await service.fullWakeForVisibilityRestore(id);

    // Geometry sync is safe mid-attach and must run so the grid is corrected
    // before the warm paint gate drops the bridge (#10070).
    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    // The async wake (which calls terminal.reset()) must still defer to avoid
    // racing the attach's own post-rAF reconciliation (#9702).
    expect(wakeAndRestore).not.toHaveBeenCalled();
    // The skipped wake must leave a flag so it re-runs once attach settles.
    expect(instance.pendingVisibilityWake).toBe(true);
  });

  it("keeps pendingVisibilityWake set when the geometry sync throws while attaching (#10070)", async () => {
    const id = "fw-6c";
    const instance = makeInstance({ isAttaching: true });
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {
      throw new Error("terminal disposed mid-wake");
    });
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: true });

    // The throw propagates, but the deferred-wake flag must already be set so
    // notifyAttachSettledWaiters re-runs the wake once attach settles.
    await expect(service.fullWakeForVisibilityRestore(id)).rejects.toThrow(
      "terminal disposed mid-wake"
    );

    expect(instance.pendingVisibilityWake).toBe(true);
    expect(wakeAndRestore).not.toHaveBeenCalled();
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
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: true });

    await service.fullWakeForVisibilityRestore(id);

    // The lock-bypass dance still wraps the geometry sync even on the attach
    // defer path, so a suppressed-resize terminal isn't left at stale geometry.
    expect(calls).toEqual(["unlock", "applyDeferredResize", "lock"]);
    expect(lockResize).toHaveBeenNthCalledWith(1, id, false);
    expect(lockResize).toHaveBeenNthCalledWith(2, id, true, expect.any(Number));
    expect(wakeAndRestore).not.toHaveBeenCalled();
    expect(instance.pendingVisibilityWake).toBe(true);
  });

  it("clears a stale pendingVisibilityWake flag when proceeding with an immediate wake (#9702)", async () => {
    const id = "fw-clear";
    const instance = makeInstance({ pendingVisibilityWake: true });
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue({
      ok: true,
      replayedMainBuffer: true,
    });
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(instance.pendingVisibilityWake).toBe(false);
  });

  it("re-runs the deferred wake via notifyAttachSettledWaiters once attach settles (#9702)", async () => {
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
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: true });
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    service.notifyAttachSettledWaiters(id);
    // The deferred wake is dispatched as a floating promise; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(instance.pendingVisibilityWake).toBe(false);
    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    expect(wakeAndRestore).toHaveBeenCalledWith(id);

    document.body.removeChild(hostElement);
  });

  it("does not fire a deferred wake when pendingVisibilityWake is unset (#9702)", async () => {
    const id = "fw-nodefer";
    const hostElement = document.createElement("div");
    document.body.appendChild(hostElement);
    const instance = makeInstance({ isAttaching: false, hostElement });
    service.instances.set(id, instance);

    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: true });

    service.notifyAttachSettledWaiters(id);
    await Promise.resolve();
    await Promise.resolve();

    expect(wakeAndRestore).not.toHaveBeenCalled();

    document.body.removeChild(hostElement);
  });

  it("no-ops cleanly when terminal does not exist", async () => {
    await expect(service.fullWakeForVisibilityRestore("missing")).resolves.toBeUndefined();
  });

  it("skips post-wake work when instance was replaced during wakeAndRestore", async () => {
    const id = "fw-7";
    const instance = makeInstance();
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockImplementation(async () => {
      // Replace the managed terminal mid-flight
      service.instances.set(id, makeInstance());
      return { ok: true, replayedMainBuffer: true };
    });
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    const resumeFlush = vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});
    const resetForTerminal = vi
      .spyOn(service.dataBuffer, "resetForTerminal")
      .mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(handlePostWake).not.toHaveBeenCalled();
    expect(resumeFlush).not.toHaveBeenCalled();
    expect(resetForTerminal).not.toHaveBeenCalled();
  });

  // Long-dwell rehydration: a terminal hibernated while its project view was
  // backgrounded gets torn down, and unhibernate() can't re-open it behind the
  // anti-flash bridge (zero host box). The foreground reveal pass re-runs this
  // method once the view is presented; it must finish the open the occluded
  // wake skipped, then proceed with the wake.
  it("opens an unopened terminal when the host is foreground-measurable, then proceeds to wake", async () => {
    const id = "fw-open-fg";
    const host = renderableHost();
    const instance = makeInstance({ isOpened: false, hostElement: host });
    service.instances.set(id, instance);

    const ensureOpened = vi.spyOn(service, "ensureOpened").mockImplementation(() => {
      instance.isOpened = true;
    });
    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: true });
    vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resetForTerminal").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(ensureOpened).toHaveBeenCalledWith(id, instance);
    expect(wakeAndRestore).toHaveBeenCalledWith(id);

    document.body.removeChild(host);
  });

  it("does not open an unopened terminal whose host is detached (still occluded)", async () => {
    const id = "fw-open-occluded";
    // Detached host → not connected → not renderable (mirrors a cached view
    // still behind the bridge during the visibilitychange/resume wake).
    const instance = makeInstance({ isOpened: false });
    service.instances.set(id, instance);

    const ensureOpened = vi.spyOn(service, "ensureOpened").mockImplementation(() => {});
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: true });

    await service.fullWakeForVisibilityRestore(id);

    expect(ensureOpened).not.toHaveBeenCalled();
    expect(wakeAndRestore).not.toHaveBeenCalled();
  });

  it("does not open an unopened terminal whose connected host has a zero layout box (occluded behind bridge)", async () => {
    const id = "fw-open-zerobox";
    // The production occluded case: the cached view IS attached (host connected)
    // but reports a zero box while behind the anti-flash bridge. jsdom does no
    // layout, so an appended-but-unstyled host reports clientWidth/Height = 0,
    // which is exactly this state.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const instance = makeInstance({ isOpened: false, hostElement: host });
    service.instances.set(id, instance);

    const ensureOpened = vi.spyOn(service, "ensureOpened").mockImplementation(() => {});
    const wakeAndRestore = vi
      .spyOn(service.wakeManager, "wakeAndRestore")
      .mockResolvedValue({ ok: true, replayedMainBuffer: true });

    await service.fullWakeForVisibilityRestore(id);

    expect(ensureOpened).not.toHaveBeenCalled();
    expect(wakeAndRestore).not.toHaveBeenCalled();

    document.body.removeChild(host);
  });

  // Exercises the real ensureOpened() primitive (not a spy) so a regression that
  // stops calling terminal.open() or stops flipping isOpened is caught — the
  // seam test above only proves the gate decides to call it.
  it("ensureOpened opens xterm against the host and flips isOpened without a remount", () => {
    // An earlier test spied ensureOpened; the suite's beforeEach clears call
    // history but keeps the implementation (clearAllMocks, not restoreAllMocks),
    // so restore the real method to exercise the actual primitive here.
    vi.spyOn(service, "ensureOpened").mockRestore();

    const id = "eo-1";
    const host = renderableHost();
    const open = vi.fn();
    const instance = makeInstance({ isOpened: false, hostElement: host });
    instance.terminal.open = open;
    instance.terminal.resize = vi.fn();
    service.instances.set(id, instance);

    // Isolate the open primitive from addon/WebGL wiring (covered elsewhere).
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
    service.instances.set(id, makeInstance({ isOpened: true, isHibernated: false }));

    const fullWake = vi.spyOn(service, "fullWakeForVisibilityRestore").mockResolvedValue(undefined);
    const repaint = vi.spyOn(service, "repaintForReveal").mockImplementation(() => true);

    await expect(service.revealTerminal(id)).resolves.toBe(true);

    expect(repaint).toHaveBeenCalledWith(id, { trustDomVisibility: true });
    expect(fullWake).not.toHaveBeenCalled();
  });

  it("takes the full rehydration path for a hibernated terminal", async () => {
    const id = "rev-2";
    // Hibernated panes route through the full open+wake, but only once the host
    // is measurable — give it a renderable box so the reveal gate proceeds.
    service.instances.set(
      id,
      makeInstance({ isOpened: false, isHibernated: true, hostElement: renderableHost() })
    );

    const fullWake = vi.spyOn(service, "fullWakeForVisibilityRestore").mockResolvedValue(undefined);
    const repaint = vi.spyOn(service, "repaintForReveal").mockImplementation(() => true);

    await service.revealTerminal(id);

    expect(fullWake).toHaveBeenCalledWith(id);
    expect(repaint).not.toHaveBeenCalled();
  });

  it("takes the full rehydration path for an un-opened terminal", async () => {
    const id = "rev-3";
    service.instances.set(
      id,
      makeInstance({ isOpened: false, isHibernated: false, hostElement: renderableHost() })
    );

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
      isHibernated: false,
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
    service.instances.set(id, makeInstance({ isOpened: false, isHibernated: false }));

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
      isHibernated: false,
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
      isHibernated: false,
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
