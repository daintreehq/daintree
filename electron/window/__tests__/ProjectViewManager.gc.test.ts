import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let nextWebContentsId = 100;

function createMockWebContents() {
  const id = nextWebContentsId++;
  return {
    id,
    isDestroyed: vi.fn(() => false),
    setBackgroundThrottling: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    send: vi.fn(),
    on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => {}),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "did-finish-load") {
        // Fire synchronously so loadView's promise resolves immediately
        Promise.resolve().then(() => handler());
      }
    }),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
  };
}

vi.mock("electron", () => {
  function MockWebContentsView() {
    const wc = createMockWebContents();
    return { webContents: wc, setBounds: vi.fn() };
  }
  return {
    app: { isPackaged: false, commandLine: { appendSwitch: vi.fn() } },
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
}));

import { ProjectViewManager } from "../ProjectViewManager.js";

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

describe("ProjectViewManager — GC on deactivate", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: ReturnType<typeof createMockWebContents>;

  beforeEach(() => {
    vi.useFakeTimers();
    nextWebContentsId = 100;
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, { dirname: "/test" });

    // Create the initial view with a known webContents mock
    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not trigger GC before 100ms, triggers exactly at 100ms", async () => {
    await manager.switchTo("proj-b", "/path/b");

    vi.advanceTimersByTime(99);
    expect(initialWc.executeJavaScript).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(initialWc.executeJavaScript).toHaveBeenCalledOnce();
    expect(initialWc.executeJavaScript).toHaveBeenCalledWith("window.gc && window.gc()");
  });

  it("skips GC if webContents is destroyed when timer fires", async () => {
    await manager.switchTo("proj-b", "/path/b");

    initialWc.isDestroyed.mockReturnValue(true);
    vi.advanceTimersByTime(100);

    expect(initialWc.executeJavaScript).not.toHaveBeenCalled();
  });

  it("skips GC if view was reactivated (state no longer cached)", async () => {
    // Deactivate proj-a by switching to proj-b
    await manager.switchTo("proj-b", "/path/b");

    // Reactivate proj-a before the 100ms GC delay
    await manager.switchTo("proj-a", "/path/a");

    vi.advanceTimersByTime(100);

    // GC should NOT have fired — view was reactivated (state is "active", not "cached")
    expect(initialWc.executeJavaScript).not.toHaveBeenCalled();
  });

  it("skips GC if view entry was evicted from the map", async () => {
    await manager.switchTo("proj-b", "/path/b");

    manager.destroyView("proj-a");

    vi.advanceTimersByTime(100);

    expect(initialWc.executeJavaScript).not.toHaveBeenCalled();
  });

  it("suppresses executeJavaScript rejection without unhandled promise", async () => {
    initialWc.executeJavaScript.mockRejectedValue(new Error("renderer gone"));

    await manager.switchTo("proj-b", "/path/b");

    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    // Should have been called (and rejected silently)
    expect(initialWc.executeJavaScript).toHaveBeenCalledOnce();
  });
});
