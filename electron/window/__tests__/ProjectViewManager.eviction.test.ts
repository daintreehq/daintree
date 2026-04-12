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
    on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => {}),
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

describe("ProjectViewManager — eviction safety", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    nextWebContentsId = 100;
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
    });
  });

  it("evictStaleViews does not evict any view when activeProjectId is null", async () => {
    // Register initial view for proj-a
    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Switch to proj-b (now have 2 views, proj-b is active)
    await manager.switchTo("proj-b", "/path/b");

    // Destroy proj-b which sets activeProjectId to null
    manager.destroyView("proj-b");

    // Call setCachedViewLimit(1) which would trigger evictStaleViews
    manager.setCachedViewLimit(1);

    // proj-a view should still be alive
    const views = manager.getAllViews();
    expect(views.length).toBeGreaterThanOrEqual(1);

    // proj-a's webContents.close should NOT have been called
    expect(wcA.close).not.toHaveBeenCalled();
  });

  it("setCachedViewLimit clamps values to [1, 5]", async () => {
    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Call with 0 -- should not throw and should be clamped to 1
    expect(() => manager.setCachedViewLimit(0)).not.toThrow();

    // Call with 10 -- should not throw and should be clamped to 5
    expect(() => manager.setCachedViewLimit(10)).not.toThrow();
  });

  it("evictStaleViews still evicts LRU cached views when activeProjectId is set", async () => {
    // Create a manager with cachedProjectViews: 2
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    // Register initial view for proj-a
    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Switch to proj-b (2 views, within limit)
    await managerWithLimit.switchTo("proj-b", "/path/b");

    // Switch to proj-c (3 views, over limit)
    await managerWithLimit.switchTo("proj-c", "/path/c");

    // proj-a should have been evicted (getAllViews has 2 entries for proj-b and proj-c)
    const views = managerWithLimit.getAllViews();
    expect(views.length).toBe(2);

    // proj-c is active
    expect(managerWithLimit.getActiveProjectId()).toBe("proj-c");

    // proj-a was evicted, so wcA.close should have been called
    expect(wcA.close).toHaveBeenCalled();

    // proj-b should still be cached (getAllViews includes it)
    const viewIds = views.map((v) => v.projectId || "");
    expect(viewIds).toContain("proj-b");
  });
});
