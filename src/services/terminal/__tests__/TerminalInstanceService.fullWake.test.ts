// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  };
  hostElement: HTMLElement;
};

type FullWakeTestService = {
  instances: Map<string, ManagedTerminalMock>;
  wakeManager: {
    wakeAndRestore: (id: string) => Promise<{ ok: boolean; replayedMainBuffer: boolean }>;
  };
  resizeController: {
    applyDeferredResize: (id: string) => void;
    lockResize: (id: string, locked: boolean, ms?: number) => void;
  };
  dataBuffer: { resumeFlush: (id: string) => void; resetForTerminal: (id: string) => void };
  webGLManager: { repairAtlasForReactivation: (id: string) => boolean };
  handlePostWake: (id: string) => void;
  unhibernate: (id: string) => void;
  ensureOpened: (id: string, managed: ManagedTerminalMock) => void;
  fullWakeForVisibilityRestore: (id: string) => Promise<void>;
  repaintForReveal: (id: string) => void;
  revealTerminal: (id: string) => Promise<void>;
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

  it("does not open an unopened terminal whose host has no renderable box (still occluded)", async () => {
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
    const repaint = vi.spyOn(service, "repaintForReveal").mockImplementation(() => {});

    await service.revealTerminal(id);

    expect(repaint).toHaveBeenCalledWith(id);
    expect(fullWake).not.toHaveBeenCalled();
  });

  it("takes the full rehydration path for a hibernated terminal", async () => {
    const id = "rev-2";
    service.instances.set(id, makeInstance({ isOpened: false, isHibernated: true }));

    const fullWake = vi.spyOn(service, "fullWakeForVisibilityRestore").mockResolvedValue(undefined);
    const repaint = vi.spyOn(service, "repaintForReveal").mockImplementation(() => {});

    await service.revealTerminal(id);

    expect(fullWake).toHaveBeenCalledWith(id);
    expect(repaint).not.toHaveBeenCalled();
  });

  it("takes the full rehydration path for an un-opened terminal", async () => {
    const id = "rev-3";
    service.instances.set(id, makeInstance({ isOpened: false, isHibernated: false }));

    const fullWake = vi.spyOn(service, "fullWakeForVisibilityRestore").mockResolvedValue(undefined);
    const repaint = vi.spyOn(service, "repaintForReveal").mockImplementation(() => {});

    await service.revealTerminal(id);

    expect(fullWake).toHaveBeenCalledWith(id);
    expect(repaint).not.toHaveBeenCalled();
  });

  it("no-ops when the terminal does not exist", async () => {
    const fullWake = vi.spyOn(service, "fullWakeForVisibilityRestore").mockResolvedValue(undefined);
    const repaint = vi.spyOn(service, "repaintForReveal").mockImplementation(() => {});

    await expect(service.revealTerminal("missing")).resolves.toBeUndefined();

    expect(fullWake).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
  });
});
