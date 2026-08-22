import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let nextWebContentsId = 300;

type Handler = (...args: unknown[]) => void;

interface MockWebContents {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  session: { flushStorageData: ReturnType<typeof vi.fn> };
  navigationHistory: { clear: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  setIgnoreMenuShortcuts: ReturnType<typeof vi.fn>;
  fireOnce: (event: string, ...args: unknown[]) => void;
}

const wcQueue = vi.hoisted(() => [] as MockWebContents[]);

function createMockWebContents(options?: { autoFinishLoad?: boolean }): MockWebContents {
  const handlers = new Map<string, Handler[]>();
  const autoFinishLoad = options?.autoFinishLoad ?? true;
  const id = nextWebContentsId++;

  const webContents: MockWebContents = {
    id,
    isDestroyed: vi.fn(() => false),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
    invalidate: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    send: vi.fn(),
    session: { flushStorageData: vi.fn() },
    navigationHistory: { clear: vi.fn() },
    on: vi.fn((_event: string, _handler: Handler) => undefined),
    once: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      if (event === "did-finish-load" && autoFinishLoad) {
        Promise.resolve().then(() => webContents.fireOnce("did-finish-load"));
      }
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
    }),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    fireOnce(event: string, ...args: unknown[]) {
      const list = handlers.get(event);
      if (!list || list.length === 0) return;
      const handler = list.shift();
      handler?.(...args);
    },
  };

  return webContents;
}

vi.mock("electron", () => {
  function MockWebContentsView() {
    const wc = wcQueue.shift();
    return {
      webContents: wc,
      setBounds: vi.fn(),
      setBackgroundColor: vi.fn(),
      setVisible: vi.fn(),
    };
  }

  return {
    app: {
      isPackaged: false,
      commandLine: { appendSwitch: vi.fn() },
      getPath: vi.fn(() => "/tmp/daintree-test-appdata"),
      setPath: vi.fn(),
    },
    BrowserWindow: vi.fn(),
    WebContentsView: MockWebContentsView,
    session: { fromPartition: vi.fn(() => ({ protocol: { handle: vi.fn() } })) },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    nativeTheme: { shouldUseDarkColors: true },
  };
});

vi.mock("../webContentsRegistry.js", () => ({
  registerWebContents: vi.fn(),
  registerAppView: vi.fn(),
  unregisterWebContents: vi.fn(),
  registerProjectView: vi.fn(),
  unregisterProjectView: vi.fn(),
  registerCachedViewWebContents: vi.fn(),
  unregisterCachedViewWebContents: vi.fn(),
}));

vi.mock("../../setup/protocols.js", () => ({
  registerProtocolsForSession: vi.fn(),
  getDistPath: vi.fn(() => "/dist"),
}));

vi.mock("../../../shared/config/devServer.js", () => ({
  getDevServerUrl: vi.fn(() => "http://localhost:5173"),
}));

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: vi.fn().mockReturnValue(true),
}));

vi.mock("../../../shared/utils/urlUtils.js", () => ({
  isLocalhostUrl: vi.fn().mockReturnValue(true),
}));

vi.mock("../../utils/openExternal.js", () => ({
  canOpenExternalUrl: vi.fn(),
  openExternalUrl: vi.fn(),
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: vi.fn(() => ({ recordCrash: vi.fn() })),
}));

vi.mock("../../ipc/errorHandlers.js", () => ({
  notifyError: vi.fn(),
}));

vi.mock("../skeletonCss.js", () => ({
  injectSkeletonCss: vi.fn(),
  injectSkeletonProjectIdentity: vi.fn(),
  INITIAL_COLOR_SCHEME_ARG: "--daintree-initial-color-scheme-id",
  INITIAL_PROJECT_ID_ARG: "--daintree-initial-project-id",
  INSTANCE_ROLE_ARG: "--daintree-instance-role",
  resolveInstanceRole: vi.fn(() => "attended"),
  resolveE2EPreloadArgs: vi.fn(() => []),
  resolveInitialColorSchemeId: vi.fn(() => "daintree"),
  resolveInitialCanvasBackgroundColor: vi.fn(() => "#1f1b16"),
}));

// module-level side effects (deepLinkUrlQueue app.on, userData setPath) need
// the real electron app API the partial mock above does not provide.
vi.mock("../../setup/environment.js", () => ({
  isSmokeTest: false,
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: vi.fn(() => null) },
}));

vi.mock("../../utils/webContentsLifecycle.js", () => ({
  purgeMemoryWebContents: vi.fn().mockResolvedValue(undefined),
  freezeWebContents: vi.fn().mockResolvedValue(undefined),
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
  throttleCpuWebContents: vi.fn().mockResolvedValue(undefined),
  unthrottleCpuWebContents: vi.fn().mockResolvedValue(undefined),
}));

import { ProjectViewManager } from "../ProjectViewManager.js";

const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

function createMockWindow() {
  // Track children so contentView.children reflects real attach/detach order —
  // required to assert orphaned-view pruning (#10806). The old no-op mock left
  // children empty regardless of addChildView/removeChildView, hiding the
  // double-attach the orphan bug produces.
  const children: unknown[] = [];
  return {
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    destroy: vi.fn(),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
      children,
      addChildView: vi.fn((view: unknown, index?: number) => {
        if (typeof index === "number") {
          children.splice(index, 0, view);
        } else {
          children.push(view);
        }
      }),
      removeChildView: vi.fn((view: unknown) => {
        const idx = children.indexOf(view);
        if (idx >= 0) children.splice(idx, 1);
      }),
    },
    webContents: createMockWebContents(),
  };
}

function getResizeHandler(win: ReturnType<typeof createMockWindow>): (() => void) | undefined {
  const call = (win.on as ReturnType<typeof vi.fn>).mock.calls.find(
    ([event]) => event === "resize"
  );
  return call?.[1] as (() => void) | undefined;
}

describe("ProjectViewManager adversarial", () => {
  beforeEach(() => {
    nextWebContentsId = 300;
    wcQueue.length = 0;
    // Switch-ordering suite, not paint-gate policy: release every gate with a
    // signal so the zero-length gate can't read as the hard timeout that now
    // abandons a cold switch (#11635).
    vi.spyOn(ProjectViewManager.prototype, "waitForPaint").mockResolvedValue("signal");
  });

  afterEach(() => {
    wcQueue.length = 0;
  });

  it("serializes rapid A→B→A→B switches within one tick without duplicating views", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const initialWc = createMockWebContents();
    manager.registerInitialView(
      { webContents: initialWc, setBounds: vi.fn() } as never,
      "proj-a",
      "/a"
    );

    wcQueue.push(createMockWebContents(), createMockWebContents());

    const first = manager.switchTo("proj-b", "/b");
    const second = manager.switchTo("proj-a", "/a");
    const third = manager.switchTo("proj-b", "/b");

    await Promise.all([first, second, third]);

    expect(manager.getActiveProjectId()).toBe("proj-b");
    expect(
      manager
        .getAllViews()
        .map((view) => view.projectId)
        .sort()
    ).toEqual(["proj-a", "proj-b"]);
  });

  it("requests GC immediately on deactivation, even when the view is evicted by a later switch", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const initialWc = createMockWebContents();
    manager.registerInitialView(
      { webContents: initialWc, setBounds: vi.fn() } as never,
      "proj-a",
      "/a"
    );

    wcQueue.push(createMockWebContents(), createMockWebContents());

    // Switch to B — deactivates A, GC requested immediately
    await manager.switchTo("proj-b", "/b");
    expect(initialWc.executeJavaScript).toHaveBeenCalledOnce();
    expect(initialWc.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("requestIdleCallback")
    );

    // Switch to C — evicts A (LRU, cache limit 2)
    await manager.switchTo("proj-c", "/c");
    await flushImmediates();

    expect(initialWc.close).toHaveBeenCalledTimes(1);
    // executeJavaScript was already called during deactivation — not called again on eviction
    expect(initialWc.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(manager.getActiveProjectId()).toBe("proj-c");
  });

  it("creates a fresh view when switching to a project whose cached renderer was already destroyed", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const initialWc = createMockWebContents();
    manager.registerInitialView(
      { webContents: initialWc, setBounds: vi.fn() } as never,
      "proj-a",
      "/a"
    );

    const projBWc = createMockWebContents();
    wcQueue.push(projBWc);
    await manager.switchTo("proj-b", "/b");
    await manager.switchTo("proj-a", "/a");

    projBWc.isDestroyed.mockReturnValue(true);

    const replacementWc = createMockWebContents();
    wcQueue.push(replacementWc);
    const result = await manager.switchTo("proj-b", "/b");

    expect(result.isNew).toBe(true);
    expect(result.view.webContents).toBe(replacementWc);
    expect(manager.getActiveProjectId()).toBe("proj-b");
  });

  it("sets background color on cold-start view before loadURL to prevent white flash (#9573)", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const initialWc = createMockWebContents({ autoFinishLoad: false });
    const mockView = { webContents: initialWc, setBounds: vi.fn(), setBackgroundColor: vi.fn() };
    manager.registerInitialView(mockView as never, "proj-a", "/a");

    const projBWc = createMockWebContents();
    wcQueue.push(projBWc);
    await manager.switchTo("proj-b", "/b");

    // The newly-created WebContentsView for proj-b must have had setBackgroundColor
    // called with the resolved canvas color before loadURL fired.
    const projBView = manager.getAllViews().find((v) => v.projectId === "proj-b")?.view as
      | {
          setBackgroundColor: ReturnType<typeof vi.fn>;
          webContents: { loadURL: ReturnType<typeof vi.fn> };
        }
      | undefined;

    expect(projBView?.setBackgroundColor).toHaveBeenCalledWith("#1f1b16");
    const setColorOrder = projBView?.setBackgroundColor.mock.invocationCallOrder[0] ?? 0;
    const loadUrlOrder = projBView?.webContents.loadURL.mock.invocationCallOrder[0] ?? Infinity;
    const addChildOrder =
      (win.contentView.addChildView as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
      Infinity;
    expect(setColorOrder).toBeLessThan(loadUrlOrder);
    expect(setColorOrder).toBeLessThan(addChildOrder);
  });

  it("LRU-evicted cold-start replacement view gets background color set (#9573)", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const initialWc = createMockWebContents();
    manager.registerInitialView(
      { webContents: initialWc, setBounds: vi.fn(), setBackgroundColor: vi.fn() } as never,
      "proj-a",
      "/a"
    );

    const projBWc = createMockWebContents();
    wcQueue.push(projBWc);
    await manager.switchTo("proj-b", "/b");
    await manager.switchTo("proj-a", "/a");

    projBWc.isDestroyed.mockReturnValue(true);

    const replacementWc = createMockWebContents();
    wcQueue.push(replacementWc);
    const result = await manager.switchTo("proj-b", "/b");

    expect(result.isNew).toBe(true);
    const replacementView = result.view as unknown as {
      setBackgroundColor: ReturnType<typeof vi.fn>;
    };
    expect(replacementView.setBackgroundColor).toHaveBeenCalledWith("#1f1b16");
  });

  // #10806 — Under rapid switching + backgrounding, a cancelled paint gate or a
  // destroyView race (HibernationService runs outside switchChain) can skip
  // deactivateEntry(previousEntry), leaving an outgoing view attached behind the
  // active one. Two renderers composite at once → the forge toolbar renders
  // twice. pruneOrphanedChildren on each switch's success path sweeps the leak.

  it("detaches an orphaned outgoing view left attached behind the active view (#10806)", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const aWc = createMockWebContents();
    const aView = { webContents: aWc, setBounds: vi.fn(), setVisible: vi.fn() };
    win.contentView.addChildView(aView);
    manager.registerInitialView(aView as never, "proj-a", "/a");

    // A→B deactivates A (cached) and detaches it from contentView.
    wcQueue.push(createMockWebContents());
    await manager.switchTo("proj-b", "/b");
    expect(win.contentView.children).not.toContain(aView);

    // Reproduce the leaked state: the cached A view is attached behind the
    // active B view, as a cancelled gate / destroyView race would leave it.
    win.contentView.addChildView(aView);
    expect(win.contentView.children).toContain(aView);

    // The next switch must sweep the orphan so only the active view remains.
    wcQueue.push(createMockWebContents());
    const result = await manager.switchTo("proj-c", "/c");

    expect(win.contentView.children).not.toContain(aView);
    expect(win.contentView.children).toEqual([result.view]);
    expect(manager.getActiveProjectId()).toBe("proj-c");
  });

  it("parks a still-active orphaned view as cached rather than evicting it (#10806)", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const aWc = createMockWebContents();
    const aView = { webContents: aWc, setBounds: vi.fn(), setVisible: vi.fn() };
    win.contentView.addChildView(aView);
    manager.registerInitialView(aView as never, "proj-a", "/a");

    wcQueue.push(createMockWebContents());
    await manager.switchTo("proj-b", "/b");

    // Reproduce the precise race: deactivateEntry(A) was skipped, so A is still
    // marked active and still attached behind the active B view.
    const aEntry = manager.getAllViews().find((entry) => entry.projectId === "proj-a");
    expect(aEntry).toBeDefined();
    aEntry!.state = "active";
    win.contentView.addChildView(aView);

    wcQueue.push(createMockWebContents());
    await manager.switchTo("proj-c", "/c");

    // Orphan detached and parked as cached (setVisible(false)) — never evicted,
    // so its reusable cached renderer and cleanup handlers survive (#6085).
    expect(win.contentView.children).not.toContain(aView);
    expect(aView.setVisible).toHaveBeenCalledWith(false);
    expect(
      manager
        .getAllViews()
        .map((entry) => entry.projectId)
        .sort()
    ).toEqual(["proj-a", "proj-b", "proj-c"]);
  });

  it("resizes orphaned attached views so a stray duplicate overlaps the active view (#10806)", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const aWc = createMockWebContents();
    const aView = { webContents: aWc, setBounds: vi.fn(), setVisible: vi.fn() };
    win.contentView.addChildView(aView);
    manager.registerInitialView(aView as never, "proj-a", "/a");

    wcQueue.push(createMockWebContents());
    await manager.switchTo("proj-b", "/b");

    // Orphan A attached behind active B with no in-flight paint gate.
    win.contentView.addChildView(aView);

    const resize = getResizeHandler(win);
    expect(resize).toBeTypeOf("function");
    aView.setBounds.mockClear();
    resize!();

    // The orphan gets the full window bounds, so it overlaps the active view
    // exactly instead of drifting to a stale x-offset (side-by-side toolbars).
    expect(aView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("does not resize non-project children such as parked portal views (#10806)", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const aView = { webContents: createMockWebContents(), setBounds: vi.fn(), setVisible: vi.fn() };
    win.contentView.addChildView(aView);
    manager.registerInitialView(aView as never, "proj-a", "/a");

    // A hidden portal tab: attached to contentView but never registered as a
    // project view, parked far offscreen by PortalManager.
    const portalView = { webContents: createMockWebContents(), setBounds: vi.fn() };
    win.contentView.addChildView(portalView);

    const resize = getResizeHandler(win);
    expect(resize).toBeTypeOf("function");
    portalView.setBounds.mockClear();
    resize!();

    // The portal view must keep its own (offscreen) bounds — yanking it to the
    // full window would surface a hidden tab over the active project view.
    expect(portalView.setBounds).not.toHaveBeenCalled();
  });
});
