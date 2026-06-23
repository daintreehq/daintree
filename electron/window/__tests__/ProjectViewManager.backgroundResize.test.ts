import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let nextWebContentsId = 100;

function createMockWebContents() {
  const id = nextWebContentsId++;
  return {
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
    on: vi.fn(() => {}),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "did-finish-load") {
        Promise.resolve().then(() => handler());
      }
    }),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
  };
}

vi.mock("electron", () => {
  function MockWebContentsView() {
    const wc = createMockWebContents();
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
  isCachedViewWebContents: vi.fn(),
  getWindowForWebContents: vi.fn(),
  getAppWebContents: vi.fn(),
  getAppView: vi.fn(),
  getAllAppWebContents: vi.fn(() => []),
  getProjectForWebContents: vi.fn(),
  getWebContentsForProject: vi.fn(),
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
  resolveE2EPreloadArgs: vi.fn(() => []),
  resolveInstanceRole: vi.fn(() => "attended"),
  resolveInitialColorSchemeId: vi.fn(() => "daintree"),
  resolveInitialCanvasBackgroundColor: vi.fn(() => "#1f1b16"),
}));

vi.mock("../../setup/environment.js", () => ({
  isDemoMode: false,
  isSmokeTest: false,
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: vi.fn(() => null) },
}));

vi.mock("../../utils/webContentsLifecycle.js", () => ({
  freezeWebContents: vi.fn().mockResolvedValue(undefined),
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
  throttleCpuWebContents: vi.fn().mockResolvedValue(undefined),
  unthrottleCpuWebContents: vi.fn().mockResolvedValue(undefined),
}));

import { ProjectViewManager } from "../ProjectViewManager.js";
import { CHANNELS } from "../../ipc/channels.js";

function createMockWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
      children: [] as unknown[],
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    webContents: createMockWebContents(),
  };
}

function backgroundResizeSends(wc: ReturnType<typeof createMockWebContents>) {
  return wc.send.mock.calls.filter(([channel]) => channel === CHANNELS.PROJECT_BACKGROUND_RESIZE);
}

describe("ProjectViewManager — background resize forwarding", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: ReturnType<typeof createMockWebContents>;
  let fireResize: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    nextWebContentsId = 100;
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
    });
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");
    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");

    const resizeCall = win.on.mock.calls.find(([event]) => event === "resize");
    if (!resizeCall) throw new Error("resize handler not registered");
    const handler = resizeCall[1] as () => void;
    fireResize = () => handler();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends settled content bounds to cached views after the debounce", async () => {
    await manager.switchTo("proj-b", "/path/b");
    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 });

    fireResize();
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);

    vi.advanceTimersByTime(300);
    const sends = backgroundResizeSends(initialWc);
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toEqual({ width: 1440, height: 900 });
  });

  it("never sends to the active view", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const activeWc = manager.getActiveView()!.webContents as unknown as ReturnType<
      typeof createMockWebContents
    >;

    fireResize();
    vi.advanceTimersByTime(300);

    expect(backgroundResizeSends(activeWc)).toHaveLength(0);
    expect(backgroundResizeSends(initialWc)).toHaveLength(1);
  });

  it("coalesces a resize burst into a single send", async () => {
    await manager.switchTo("proj-b", "/path/b");

    fireResize();
    vi.advanceTimersByTime(100);
    fireResize();
    vi.advanceTimersByTime(100);
    fireResize();
    vi.advanceTimersByTime(300);

    expect(backgroundResizeSends(initialWc)).toHaveLength(1);
  });

  it("re-arms the debounce window on each resize event", async () => {
    await manager.switchTo("proj-b", "/path/b");

    fireResize();
    vi.advanceTimersByTime(200);
    fireResize();
    vi.advanceTimersByTime(200);
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);

    vi.advanceTimersByTime(100);
    expect(backgroundResizeSends(initialWc)).toHaveLength(1);
  });

  it("sends the bounds read at fire time, not at schedule time", async () => {
    await manager.switchTo("proj-b", "/path/b");

    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 1000, height: 700 });
    fireResize();
    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 });
    vi.advanceTimersByTime(300);

    const sends = backgroundResizeSends(initialWc);
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toEqual({ width: 1280, height: 800 });
  });

  it("skips destroyed webContents without throwing", async () => {
    await manager.switchTo("proj-b", "/path/b");
    initialWc.isDestroyed.mockReturnValue(true);

    fireResize();
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);
  });

  it("does not send when there are no cached views", () => {
    fireResize();
    vi.advanceTimersByTime(300);
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);
  });

  it("sends to every cached view, not just the most recent", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const projBWc = manager.getActiveView()!.webContents as unknown as ReturnType<
      typeof createMockWebContents
    >;
    await manager.switchTo("proj-c", "/path/c");
    const projCWc = manager.getActiveView()!.webContents as unknown as ReturnType<
      typeof createMockWebContents
    >;

    fireResize();
    vi.advanceTimersByTime(300);

    expect(backgroundResizeSends(initialWc)).toHaveLength(1);
    expect(backgroundResizeSends(projBWc)).toHaveLength(1);
    expect(backgroundResizeSends(projCWc)).toHaveLength(0);
  });

  it("a view cached mid-debounce receives the send; the newly active view does not", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const projBWc = manager.getActiveView()!.webContents as unknown as ReturnType<
      typeof createMockWebContents
    >;

    fireResize();
    // proj-b backgrounds inside the debounce window; proj-a reactivates.
    await manager.switchTo("proj-a", "/path/a");
    vi.advanceTimersByTime(300);

    expect(backgroundResizeSends(projBWc)).toHaveLength(1);
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);
  });

  it("dispose() cancels a pending notification", async () => {
    await manager.switchTo("proj-b", "/path/b");

    fireResize();
    manager.dispose();
    vi.advanceTimersByTime(300);

    expect(backgroundResizeSends(initialWc)).toHaveLength(0);
  });
});
