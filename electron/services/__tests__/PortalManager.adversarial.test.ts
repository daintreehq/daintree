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

  describe("navigation gating", () => {
    type WebContentsMock = ReturnType<typeof createMockWebContents>;
    type EventName = "will-navigate" | "will-redirect" | "will-frame-navigate";
    type PositionalHandler = (event: { preventDefault: () => void }, url: string) => void;
    type DetailsHandler = (details: {
      url: string;
      isMainFrame: boolean;
      preventDefault: () => void;
    }) => void;
    type EventCall = [EventName, PositionalHandler | DetailsHandler];

    const findHandler = <T extends PositionalHandler | DetailsHandler>(
      wc: WebContentsMock,
      eventName: EventName
    ): T => {
      const call = (wc.on.mock.calls as EventCall[]).find(([name]) => name === eventName);
      if (!call) throw new Error(`No ${eventName} handler registered`);
      return call[1] as T;
    };

    const blockedUrls = [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://example.com/abc-123",
      "about:blank",
      "vbscript:msgbox(1)",
      "ftp://example.com/file",
      "",
      "   ",
      "not a url",
    ];

    const allowedUrls = [
      "http://example.com/",
      "https://example.com/path?q=1",
      "http://localhost:3001/",
    ];

    it("registers will-navigate, will-redirect, and will-frame-navigate handlers on createTab", () => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-1", "http://localhost:3001");

      const wc = createdWebContents[0];
      const eventNames = (wc.on.mock.calls as EventCall[]).map(([name]) => name);
      expect(eventNames).toContain("will-navigate");
      expect(eventNames).toContain("will-redirect");
      expect(eventNames).toContain("will-frame-navigate");
    });

    it.each(blockedUrls)("blocks will-navigate to unsafe URL: %s", (url) => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-1", "http://localhost:3001");

      const handler = findHandler<PositionalHandler>(createdWebContents[0], "will-navigate");
      const event = { preventDefault: vi.fn() };
      handler(event, url);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it.each(blockedUrls)("blocks will-redirect to unsafe URL: %s", (url) => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-1", "http://localhost:3001");

      const handler = findHandler<PositionalHandler>(createdWebContents[0], "will-redirect");
      const event = { preventDefault: vi.fn() };
      handler(event, url);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it.each(allowedUrls)("allows will-navigate to safe http(s) URL: %s", (url) => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-1", "http://localhost:3001");

      const handler = findHandler<PositionalHandler>(createdWebContents[0], "will-navigate");
      const event = { preventDefault: vi.fn() };
      handler(event, url);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it.each(allowedUrls)("allows will-redirect to safe http(s) URL: %s", (url) => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-1", "http://localhost:3001");

      const handler = findHandler<PositionalHandler>(createdWebContents[0], "will-redirect");
      const event = { preventDefault: vi.fn() };
      handler(event, url);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it.each(blockedUrls)("blocks will-frame-navigate (subframe) to unsafe URL: %s", (url) => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-1", "http://localhost:3001");

      const handler = findHandler<DetailsHandler>(createdWebContents[0], "will-frame-navigate");
      const details = { url, isMainFrame: false, preventDefault: vi.fn() };
      handler(details);

      expect(details.preventDefault).toHaveBeenCalledTimes(1);
    });

    it.each(allowedUrls)("allows will-frame-navigate (subframe) to safe http(s) URL: %s", (url) => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-1", "http://localhost:3001");

      const handler = findHandler<DetailsHandler>(createdWebContents[0], "will-frame-navigate");
      const details = { url, isMainFrame: false, preventDefault: vi.fn() };
      handler(details);

      expect(details.preventDefault).not.toHaveBeenCalled();
    });

    it("allows will-frame-navigate for safe main-frame navigation", () => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-1", "http://localhost:3001");

      const handler = findHandler<DetailsHandler>(createdWebContents[0], "will-frame-navigate");
      const details = {
        url: "https://example.com/path",
        isMainFrame: true,
        preventDefault: vi.fn(),
      };
      handler(details);

      expect(details.preventDefault).not.toHaveBeenCalled();
    });

    it("blocks will-frame-navigate for unsafe main-frame navigation", () => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-1", "http://localhost:3001");

      const handler = findHandler<DetailsHandler>(createdWebContents[0], "will-frame-navigate");
      const details = { url: "file:///etc/passwd", isMainFrame: true, preventDefault: vi.fn() };
      handler(details);

      expect(details.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("evaluates will-redirect independently across multiple invocations", () => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-1", "http://localhost:3001");

      const handler = findHandler<PositionalHandler>(createdWebContents[0], "will-redirect");

      const safeEvent = { preventDefault: vi.fn() };
      handler(safeEvent, "https://example.com/safe");
      expect(safeEvent.preventDefault).not.toHaveBeenCalled();

      const unsafeEvent = { preventDefault: vi.fn() };
      handler(unsafeEvent, "data:text/html,evil");
      expect(unsafeEvent.preventDefault).toHaveBeenCalledTimes(1);
    });
  });
});
