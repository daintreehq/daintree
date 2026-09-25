import { describe, it, expect, beforeEach, vi } from "vitest";

let nextWebContentsId = 100;
let nextOsProcessId = 1000;

type Handler = (...args: unknown[]) => void;

function createMockWebContents(initialProjectId: string | null = null) {
  const id = nextWebContentsId++;
  const osPid = nextOsProcessId++;
  const handlers = new Map<string, Handler[]>();
  const wc = {
    id,
    osPid,
    isDestroyed: vi.fn(() => false),
    executeJavaScript: vi.fn(() =>
      Promise.resolve(
        initialProjectId === null ? undefined : { projectId: initialProjectId, hasAppRoot: true }
      )
    ),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
    invalidate: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    send: vi.fn(),
    session: { flushStorageData: vi.fn() },
    navigationHistory: { clear: vi.fn() },
    getOSProcessId: vi.fn(() => osPid),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    once: vi.fn((event: string, handler: Handler) => {
      if (event === "did-finish-load") {
        Promise.resolve().then(() => handler());
      }
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    listenerCount: (event: string) => handlers.get(event)?.length ?? 0,
  };
  return wc;
}

const viewArguments: string[][] = [];
const { registerProjectViewMock, pluginsOpenedMock, clearEvictionMock } = vi.hoisted(() => ({
  registerProjectViewMock: vi.fn(),
  pluginsOpenedMock: vi.fn(),
  clearEvictionMock: vi.fn(),
}));

vi.mock("../projectPluginLifecycle.js", () => ({
  notifyProjectPluginsOpened: pluginsOpenedMock,
  notifyProjectPluginsClosed: vi.fn(),
}));

vi.mock("../../services/workspaceResidency.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clearWorkspaceEviction: clearEvictionMock,
}));

const mockGetAppMetrics = vi.fn<() => Electron.ProcessMetric[]>(() => []);

vi.mock("electron", () => {
  function MockWebContentsView(options: { webPreferences: { additionalArguments: string[] } }) {
    const args = options.webPreferences.additionalArguments;
    viewArguments.push(args);
    const initial = args.find((a) => a.startsWith("--daintree-initial-project-id="));
    const wc = createMockWebContents(initial ? initial.split("=")[1]! : null);
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
      getAppMetrics: () => mockGetAppMetrics(),
    },
    BrowserWindow: vi.fn(),
    WebContentsView: MockWebContentsView,
    session: { fromPartition: vi.fn(() => ({ protocol: { handle: vi.fn() } })) },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    nativeTheme: { shouldUseDarkColors: true },
  };
});

vi.mock("../../services/ProcessMemoryMonitor.js", () => ({
  forgetBlinkSample: vi.fn(),
  forgetEluSample: vi.fn(),
}));

vi.mock("../webContentsRegistry.js", () => ({
  registerWebContents: vi.fn(),
  registerAppView: vi.fn(),
  unregisterWebContents: vi.fn(),
  registerProjectView: registerProjectViewMock,
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

// ProjectViewManager imports isDemoMode from setup/environment.js, whose
// module-level side effects (deepLinkUrlQueue app.on, userData setPath) need
// the real electron app API the partial mock above does not provide.
vi.mock("../../setup/environment.js", () => ({
  isDemoMode: false,
  isSmokeTest: false,
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: vi.fn(() => null) },
}));

vi.mock("../rendererConsoleCapture.js", () => ({
  attachRendererConsoleCapture: vi.fn(),
  detachRendererConsoleCapture: vi.fn(),
}));

vi.mock("../../utils/webContentsLifecycle.js", () => ({
  purgeMemoryWebContents: vi.fn().mockResolvedValue(undefined),
  freezeWebContents: vi.fn().mockResolvedValue(undefined),
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
  unthrottleCpuWebContents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    name: "test-logger",
  })),
}));

import { ProjectViewManager } from "../ProjectViewManager.js";
import { HOST_ID_ARG } from "../ProjectViewFactory.js";
import { toHostScopedKey } from "../../../shared/types/remoteHosts.js";

const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

function createMockWindow() {
  return {
    id: 1,
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

function identityArgs(args: string[]): string[] {
  return args.filter(
    (a) => a.startsWith("--daintree-initial-project-id=") || a.startsWith(`${HOST_ID_ARG}=`)
  );
}

describe("ProjectViewManager — views keyed per host", () => {
  let manager: ProjectViewManager;

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    viewArguments.length = 0;
    vi.clearAllMocks();
    mockGetAppMetrics.mockReturnValue([]);
    vi.spyOn(ProjectViewManager.prototype, "waitForPaint").mockResolvedValue("signal");
    manager = new ProjectViewManager(createMockWindow() as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 5,
    });
  });

  it("keeps a local project's key, arguments and hooks exactly as before", async () => {
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();

    expect([...manager.views.keys()]).toEqual(["proj-a"]);
    expect(identityArgs(viewArguments[0]!)).toEqual(["--daintree-initial-project-id=proj-a"]);
    const wcId = manager.views.get("proj-a")!.view.webContents.id;
    expect(manager.getProjectIdForWebContents(wcId)).toBe("proj-a");
    expect(registerProjectViewMock).toHaveBeenCalledWith("proj-a", expect.anything());
    expect(pluginsOpenedMock).toHaveBeenCalledWith("proj-a", "/path/a");
    expect(clearEvictionMock).toHaveBeenCalledWith("proj-a");
  });

  it("keys a remote project by host and tells its renderer the bare id plus the host", async () => {
    const view = await manager.switchToHostProject("studio-01", "proj-a", "/srv/a");
    await flushImmediates();

    const key = toHostScopedKey("studio-01", "proj-a");
    expect(key).toBe("studio-01:proj-a");
    expect([...manager.views.keys()]).toEqual([key]);
    expect(manager.views.get(key)!.projectPath).toBe("/srv/a");
    expect(manager.getActiveProjectId()).toBe(key);
    expect(manager.getProjectIdForWebContents(view.view.webContents.id)).toBe(key);
    expect(identityArgs(viewArguments[0]!)).toEqual([
      "--daintree-initial-project-id=proj-a",
      `${HOST_ID_ARG}=studio-01`,
    ]);
    expect(registerProjectViewMock).toHaveBeenCalledWith(key, expect.anything());
    // Plugins and residency of a remote project are its host's business.
    expect(pluginsOpenedMock).not.toHaveBeenCalled();
    expect(clearEvictionMock).not.toHaveBeenCalled();
  });

  it("holds the same project id on two hosts and locally as three separate views", async () => {
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();
    await manager.switchToHostProject("studio-01", "proj-a", "/srv/a");
    await flushImmediates();
    await manager.switchToHostProject("build-linux", "proj-a", "/home/a");
    await flushImmediates();

    expect(new Set(manager.views.keys())).toEqual(
      new Set(["proj-a", "studio-01:proj-a", "build-linux:proj-a"])
    );
    const wcIds = [...manager.views.values()].map((entry) => entry.view.webContents.id);
    expect(new Set(wcIds).size).toBe(3);
    expect(new Set(manager.webContentsToProject.values())).toEqual(
      new Set(["proj-a", "studio-01:proj-a", "build-linux:proj-a"])
    );

    // Switching back to the local project reuses its cached view.
    const back = await manager.switchTo("proj-a", "/path/a");
    expect(back.isNew).toBe(false);
    expect(manager.getActiveProjectId()).toBe("proj-a");
  });

  it("rejects an invalid host id instead of minting a colliding key", () => {
    expect(() => manager.switchToHostProject("bad host", "proj-a", "/x")).toThrow(
      /Invalid host id/
    );
  });
});
