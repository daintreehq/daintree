import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let nextWebContentsId = 300;

type Handler = (...args: unknown[]) => void;

interface MockWebContents {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  setBackgroundThrottling: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
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
    setBackgroundThrottling: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
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
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    destroy: vi.fn(),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
      children: [] as unknown[],
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    webContents: createMockWebContents(),
  };
}

describe("ProjectViewManager adversarial", () => {
  beforeEach(() => {
    nextWebContentsId = 300;
    wcQueue.length = 0;
  });

  afterEach(() => {
    wcQueue.length = 0;
  });

  it("serializes rapid A→B→A→B switches within one tick without duplicating views", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
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

    expect(initialWc.close).toHaveBeenCalledTimes(1);
    // executeJavaScript was already called during deactivation — not called again on eviction
    expect(initialWc.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(manager.getActiveProjectId()).toBe("proj-c");
  });

  it("creates a fresh view when switching to a project whose cached renderer was already destroyed", async () => {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
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
});
