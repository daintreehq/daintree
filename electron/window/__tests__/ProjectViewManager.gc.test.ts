import { describe, it, expect, beforeEach, vi } from "vitest";

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
    session: { flushStorageData: vi.fn() },
    navigationHistory: { clear: vi.fn() },
    on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => {}),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "did-finish-load") {
        // Fire synchronously so loadView's promise resolves immediately
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
    nextWebContentsId = 100;
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, { dirname: "/test", cachedProjectViews: 2 });

    // Create the initial view with a known webContents mock
    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  it("triggers GC via requestIdleCallback immediately on deactivation", async () => {
    await manager.switchTo("proj-b", "/path/b");

    expect(initialWc.executeJavaScript).toHaveBeenCalledOnce();
    expect(initialWc.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("requestIdleCallback")
    );
    expect(initialWc.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("window.gc"));
    expect(initialWc.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("timeout: 1000")
    );
  });

  it("skips GC when webContents is destroyed at the outer guard", async () => {
    initialWc.isDestroyed.mockReturnValue(true);
    await manager.switchTo("proj-b", "/path/b");

    expect(initialWc.executeJavaScript).not.toHaveBeenCalled();
  });

  it("requests GC, flushStorageData, and navigationHistory.clear in order on deactivation", async () => {
    await manager.switchTo("proj-b", "/path/b");

    expect(initialWc.executeJavaScript).toHaveBeenCalledOnce();
    expect(initialWc.session.flushStorageData).toHaveBeenCalledOnce();
    expect(initialWc.navigationHistory.clear).toHaveBeenCalledOnce();

    const flushOrder = initialWc.session.flushStorageData.mock.invocationCallOrder[0];
    const clearOrder = initialWc.navigationHistory.clear.mock.invocationCallOrder[0];
    const gcOrder = initialWc.executeJavaScript.mock.invocationCallOrder[0];

    expect(flushOrder).toBeLessThan(gcOrder);
    expect(clearOrder).toBeLessThan(gcOrder);
  });

  it("suppresses executeJavaScript rejection without unhandled promise", async () => {
    initialWc.executeJavaScript.mockRejectedValue(new Error("renderer gone"));

    await manager.switchTo("proj-b", "/path/b");

    // Should have been called (and rejected silently)
    expect(initialWc.executeJavaScript).toHaveBeenCalledOnce();
  });

  it("calls session.flushStorageData on deactivation", async () => {
    await manager.switchTo("proj-b", "/path/b");

    expect(initialWc.session.flushStorageData).toHaveBeenCalledOnce();
  });

  it("does not throw when flushStorageData throws", async () => {
    initialWc.session.flushStorageData.mockImplementation(() => {
      throw new Error("session gone");
    });

    await expect(manager.switchTo("proj-b", "/path/b")).resolves.toBeDefined();
    expect(initialWc.session.flushStorageData).toHaveBeenCalledOnce();
    // navigationHistory.clear should still fire despite flushStorageData throwing
    expect(initialWc.navigationHistory.clear).toHaveBeenCalledOnce();
  });

  it("calls navigationHistory.clear on deactivation", async () => {
    await manager.switchTo("proj-b", "/path/b");

    expect(initialWc.navigationHistory.clear).toHaveBeenCalledOnce();
  });

  it("does not throw when navigationHistory.clear throws (TOCTOU renderer crash)", async () => {
    initialWc.navigationHistory.clear.mockImplementation(() => {
      throw new Error("renderer gone");
    });

    await expect(manager.switchTo("proj-b", "/path/b")).resolves.toBeDefined();
    expect(initialWc.navigationHistory.clear).toHaveBeenCalledOnce();
    // executeJavaScript should still fire despite clear() throwing
    expect(initialWc.executeJavaScript).toHaveBeenCalledOnce();
  });

  it("skips flushStorageData, clearHistory, and GC when webContents is destroyed at outer guard", async () => {
    initialWc.isDestroyed.mockReturnValue(true);
    await manager.switchTo("proj-b", "/path/b");

    expect(initialWc.session.flushStorageData).not.toHaveBeenCalled();
    expect(initialWc.navigationHistory.clear).not.toHaveBeenCalled();
    expect(initialWc.executeJavaScript).not.toHaveBeenCalled();
  });
});
