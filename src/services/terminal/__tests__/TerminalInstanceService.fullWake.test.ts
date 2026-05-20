// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  wakeManager: { wakeAndRestore: (id: string) => Promise<boolean> };
  resizeController: {
    applyDeferredResize: (id: string) => void;
    lockResize: (id: string, locked: boolean, ms?: number) => void;
  };
  dataBuffer: { resumeFlush: (id: string) => void };
  handlePostWake: (id: string) => void;
  unhibernate: (id: string) => void;
  fullWakeForVisibilityRestore: (id: string) => Promise<void>;
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

  it("runs applyDeferredResize → forceXtermReflow → wakeAndRestore → refresh → handlePostWake → resumeFlush in order on success", async () => {
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
        return true;
      });
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {
      calls.push("handlePostWake");
    });
    const resumeFlush = vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {
      calls.push("resumeFlush");
    });
    (instance.terminal.refresh as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push("refresh");
    });

    await service.fullWakeForVisibilityRestore(id);

    expect(calls).toEqual([
      "applyDeferredResize",
      "forceXtermReflow",
      "wakeAndRestore",
      "refresh",
      "handlePostWake",
      "resumeFlush",
    ]);

    expect(applyDeferredResize).toHaveBeenCalledWith(id);
    expect(forceXtermReflowMock).toHaveBeenCalledWith(instance.terminal.element);
    expect(wakeAndRestore).toHaveBeenCalledWith(id);
    expect(handlePostWake).toHaveBeenCalledWith(id);
    expect(resumeFlush).toHaveBeenCalledWith(id);
  });

  it("still calls resumeFlush when wakeAndRestore returns false, but skips handlePostWake", async () => {
    const id = "fw-2";
    const instance = makeInstance();
    service.instances.set(id, instance);

    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue(false);
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
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue(true);
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

  it("does not touch the resize lock when isResizeSuppressed is false", async () => {
    const id = "fw-4";
    const instance = makeInstance({ isResizeSuppressed: false });
    service.instances.set(id, instance);

    const lockResize = vi
      .spyOn(service.resizeController, "lockResize")
      .mockImplementation(() => {});
    vi.spyOn(service.resizeController, "applyDeferredResize").mockImplementation(() => {});
    vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue(true);
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
    const wakeAndRestore = vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue(true);

    await service.fullWakeForVisibilityRestore(id);

    expect(applyDeferredResize).not.toHaveBeenCalled();
    expect(wakeAndRestore).not.toHaveBeenCalled();
  });

  it("bails when terminal is currently attaching", async () => {
    const id = "fw-6";
    const instance = makeInstance({ isAttaching: true });
    service.instances.set(id, instance);

    const applyDeferredResize = vi
      .spyOn(service.resizeController, "applyDeferredResize")
      .mockImplementation(() => {});
    const wakeAndRestore = vi.spyOn(service.wakeManager, "wakeAndRestore").mockResolvedValue(true);

    await service.fullWakeForVisibilityRestore(id);

    expect(applyDeferredResize).not.toHaveBeenCalled();
    expect(wakeAndRestore).not.toHaveBeenCalled();
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
      return true;
    });
    const handlePostWake = vi.spyOn(service, "handlePostWake").mockImplementation(() => {});
    const resumeFlush = vi.spyOn(service.dataBuffer, "resumeFlush").mockImplementation(() => {});

    await service.fullWakeForVisibilityRestore(id);

    expect(handlePostWake).not.toHaveBeenCalled();
    expect(resumeFlush).not.toHaveBeenCalled();
  });
});
