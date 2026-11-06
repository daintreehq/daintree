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
  noteRendererUnresponsive: vi.fn(),
  noteRendererResponsive: vi.fn(),
  forgetRendererDocumentState: vi.fn(),
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
import type { WindowGlobalAssistantPanel } from "../../../shared/types/ipc/help.js";

const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

function createMockWindow() {
  return {
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    // The background-resize debounce can fire while a test is still running;
    // without this it throws outside any test and fails the whole run.
    isMinimized: vi.fn(() => false),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
      on: vi.fn(),
      removeListener: vi.fn(),
      children: [] as unknown[],
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    webContents: createMockWebContents(),
  };
}

const shownGlobal: WindowGlobalAssistantPanel = {
  showing: true,
  target: { hostId: "local", scope: { kind: "global" }, terminalId: "global-1", incarnation: 2 },
};
const closed: WindowGlobalAssistantPanel = { showing: false, target: null };

describe("ProjectViewManager — the window's global assistant panel (#16099)", () => {
  let manager: ProjectViewManager;

  const wcIdOf = (projectId: string) => manager.views.get(projectId)!.view.webContents.id;

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

  it("holds nothing until the view on screen says, then carries it across switches", async () => {
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();
    expect(manager.getGlobalAssistantPanel()).toBeNull();

    expect(manager.recordGlobalAssistantPanel(wcIdOf("proj-a"), shownGlobal)).toBe(true);
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    // Still there for the view the switch brought in to read.
    expect(manager.getGlobalAssistantPanel()).toEqual(shownGlobal);

    expect(manager.recordGlobalAssistantPanel(wcIdOf("proj-b"), closed)).toBe(true);
    expect(manager.getGlobalAssistantPanel()).toEqual(closed);
  });

  it("takes it only from the view on screen, never one switched away from", async () => {
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();
    const a = wcIdOf("proj-a");
    manager.recordGlobalAssistantPanel(a, shownGlobal);
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // proj-a is cached now: a late report from it would undo what proj-b says.
    expect(manager.recordGlobalAssistantPanel(a, closed)).toBe(false);
    expect(manager.getGlobalAssistantPanel()).toEqual(shownGlobal);
    expect(manager.recordGlobalAssistantPanel(9999, closed)).toBe(false);
    expect(manager.getGlobalAssistantPanel()).toEqual(shownGlobal);

    // Back on screen, it speaks for the window again.
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();
    expect(manager.recordGlobalAssistantPanel(a, closed)).toBe(true);
    expect(manager.getGlobalAssistantPanel()).toEqual(closed);
  });

  it("takes it from the welcome view until the window's first project opens", async () => {
    const win = createMockWindow();
    const welcome = { webContents: createMockWebContents() };
    const welcomeId = welcome.webContents.id;
    win.contentView.children.push(welcome);
    const fresh = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 5,
    });
    expect(fresh.ownsView(welcomeId)).toBe(true);
    expect(fresh.recordGlobalAssistantPanel(welcomeId, shownGlobal)).toBe(true);

    await fresh.switchTo("proj-a", "/path/a");
    await flushImmediates();
    // The mock's removeChildView doesn't take it out of the tree; the real one does.
    win.contentView.children.splice(0, win.contentView.children.length);

    expect(fresh.getGlobalAssistantPanel()).toEqual(shownGlobal);
    expect(fresh.ownsView(welcomeId)).toBe(false);
    expect(fresh.recordGlobalAssistantPanel(welcomeId, closed)).toBe(false);
    fresh.dispose();
  });

  it("stops taking it from the outgoing view as soon as a cold switch starts", async () => {
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();
    const a = wcIdOf("proj-a");
    manager.recordGlobalAssistantPanel(a, shownGlobal);
    let release!: (outcome: "signal") => void;
    vi.mocked(manager.waitForPaint).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    );

    const switching = manager.switchTo("proj-b", "/path/b");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    // proj-a is still on screen as the bridge, but proj-b speaks for the window now.
    expect(manager.getActiveProjectId()).toBe("proj-b");
    expect(manager.recordGlobalAssistantPanel(a, closed)).toBe(false);
    expect(manager.getGlobalAssistantPanel()).toEqual(shownGlobal);
    expect(manager.recordGlobalAssistantPanel(wcIdOf("proj-b"), closed)).toBe(true);

    release("signal");
    await switching;
    expect(manager.getGlobalAssistantPanel()).toEqual(closed);
  });

  it("takes nothing from a view of another host's project", async () => {
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();
    manager.recordGlobalAssistantPanel(wcIdOf("proj-a"), shownGlobal);
    const remote = await manager.switchToHostProject("studio-01", "proj-a", "/srv/a");
    await flushImmediates();

    expect(manager.recordGlobalAssistantPanel(remote.view.webContents.id, closed)).toBe(false);
    expect(manager.getGlobalAssistantPanel()).toEqual(shownGlobal);
  });

  it("keeps each window's own record", async () => {
    const other = new ProjectViewManager(createMockWindow() as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 5,
    });
    await manager.switchTo("proj-a", "/path/a");
    await other.switchTo("proj-b", "/path/b");
    await flushImmediates();

    manager.recordGlobalAssistantPanel(wcIdOf("proj-a"), shownGlobal);
    // A view of this window can't write the other window's record.
    expect(other.recordGlobalAssistantPanel(wcIdOf("proj-a"), closed)).toBe(false);
    expect(other.getGlobalAssistantPanel()).toBeNull();
    other.dispose();
  });

  it("forgets it when the window's manager is disposed", async () => {
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();
    const a = wcIdOf("proj-a");
    manager.recordGlobalAssistantPanel(a, shownGlobal);

    manager.dispose();

    expect(manager.getGlobalAssistantPanel()).toBeNull();
    expect(manager.recordGlobalAssistantPanel(a, shownGlobal)).toBe(false);
  });
});
