import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMockWebContents = () => ({
  loadURL: vi.fn().mockResolvedValue(undefined),
  getURL: vi.fn().mockReturnValue("https://example.com"),
  getTitle: vi.fn().mockReturnValue("Test Page"),
  canGoBack: vi.fn().mockReturnValue(false),
  canGoForward: vi.fn().mockReturnValue(false),
  goBack: vi.fn(),
  goForward: vi.fn(),
  reload: vi.fn(),
  close: vi.fn(),
  send: vi.fn(),
  on: vi.fn().mockReturnThis(),
  once: vi.fn().mockReturnThis(),
  setWindowOpenHandler: vi.fn(),
  inspectElement: vi.fn(),
  paste: vi.fn(),
  isDestroyed: vi.fn().mockReturnValue(false),
  session: {
    flushStorageData: vi.fn().mockResolvedValue(undefined),
  },
});

const createdWebContents: ReturnType<typeof createMockWebContents>[] = [];

vi.mock("electron", () => {
  class MockWebContentsView {
    webContents = createMockWebContents();
    setBounds = vi.fn();

    constructor() {
      createdWebContents.push(this.webContents);
    }
  }

  const mockContentView = {
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  };

  class MockBrowserWindow {
    webContents = {
      send: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
    };
    contentView = mockContentView;
    isDestroyed = vi.fn().mockReturnValue(false);
  }

  return {
    BrowserWindow: MockBrowserWindow,
    WebContentsView: MockWebContentsView,
    Menu: {
      buildFromTemplate: vi.fn().mockReturnValue({
        popup: vi.fn(),
      }),
    },
    app: {
      isPackaged: false,
    },
    clipboard: {
      writeText: vi.fn(),
    },
  };
});

vi.mock("../utils/openExternal.js", () => ({
  canOpenExternalUrl: vi.fn().mockReturnValue(true),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

describe("PortalManager adversarial", () => {
  let PortalManagerClass: typeof import("../PortalManager.js").PortalManager;
  let mockWindow: InstanceType<typeof import("electron").BrowserWindow>;

  beforeEach(async () => {
    createdWebContents.length = 0;
    vi.resetModules();

    const electron = await import("electron");
    mockWindow = new electron.BrowserWindow() as InstanceType<typeof electron.BrowserWindow>;

    const module = await import("../PortalManager.js");
    PortalManagerClass = module.PortalManager;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("evicts the true LRU background tab after rapid active-tab switches", () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:3001");
    manager.createTab("tab-2", "http://localhost:3002");
    manager.createTab("tab-3", "http://localhost:3003");

    manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });
    manager.showTab("tab-2", { x: 0, y: 0, width: 800, height: 600 });
    manager.createTab("tab-4", "http://localhost:3004");

    expect(manager.getActiveTabId()).toBe("tab-2");
    expect(manager.hasTab("tab-1")).toBe(true);
    expect(manager.hasTab("tab-2")).toBe(true);
    expect(manager.hasTab("tab-3")).toBe(false);
    expect(manager.hasTab("tab-4")).toBe(true);
  });

  it("still closes an evicted tab when flushStorageData rejects during LRU eviction", async () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:3001");
    manager.createTab("tab-2", "http://localhost:3002");
    manager.createTab("tab-3", "http://localhost:3003");

    const evictedWebContents = createdWebContents[0];
    evictedWebContents.session.flushStorageData.mockRejectedValueOnce(new Error("flush failed"));

    manager.createTab("tab-4", "http://localhost:3004");
    await Promise.resolve();

    expect(manager.hasTab("tab-1")).toBe(false);
    expect(evictedWebContents.close).toHaveBeenCalledTimes(1);
  });

  it("keeps eviction idempotent when closeTab races an in-flight eviction of the same tab", async () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:3001");
    manager.createTab("tab-2", "http://localhost:3002");
    manager.createTab("tab-3", "http://localhost:3003");

    const evictedWebContents = createdWebContents[0];
    let resolveFlush!: () => void;
    evictedWebContents.session.flushStorageData.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveFlush = resolve;
      })
    );

    manager.createTab("tab-4", "http://localhost:3004");
    await manager.closeTab("tab-1");
    resolveFlush();
    await Promise.resolve();

    expect(manager.hasTab("tab-1")).toBe(false);
    expect(evictedWebContents.close).toHaveBeenCalledTimes(1);
  });
});
