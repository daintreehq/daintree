import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

describe("PortalManager", () => {
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

  describe("createTab()", () => {
    it("creates a new tab with valid http URL", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-1", "http://localhost:3000");

      expect(manager.hasTab("tab-1")).toBe(true);
    });

    it("creates a new tab with valid https URL", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-2", "https://example.com");

      expect(manager.hasTab("tab-2")).toBe(true);
    });

    it("rejects invalid URL protocol (file:)", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-3", "file:///etc/passwd");

      expect(manager.hasTab("tab-3")).toBe(false);
    });

    it("rejects invalid URL protocol (javascript:)", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-4", "javascript:alert(1)");

      expect(manager.hasTab("tab-4")).toBe(false);
    });

    it("rejects invalid URL protocol (ftp:)", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-5", "ftp://example.com");

      expect(manager.hasTab("tab-5")).toBe(false);
    });

    it("rejects malformed URLs", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-6", "not-a-valid-url");

      expect(manager.hasTab("tab-6")).toBe(false);
    });

    it("does not create duplicate tabs with same ID", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-dup", "http://localhost:3000");
      manager.createTab("tab-dup", "http://localhost:4000");

      expect(manager.hasTab("tab-dup")).toBe(true);
    });

    it("rejects data: URLs", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-data", "data:text/html,<h1>Test</h1>");

      expect(manager.hasTab("tab-data")).toBe(false);
    });
  });

  describe("showTab()", () => {
    it("shows an existing tab with valid bounds", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-show", "http://localhost:3000");
      manager.showTab("tab-show", { x: 100, y: 100, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-show");
      expect(mockWindow.contentView.addChildView).toHaveBeenCalled();
    });

    it("does nothing for non-existent tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.showTab("non-existent", { x: 0, y: 0, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBeNull();
    });

    it("switches from one tab to another", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-a", "http://localhost:3000");
      manager.createTab("tab-b", "http://localhost:4000");

      manager.showTab("tab-a", { x: 0, y: 0, width: 800, height: 600 });
      expect(manager.getActiveTabId()).toBe("tab-a");

      manager.showTab("tab-b", { x: 0, y: 0, width: 800, height: 600 });
      expect(manager.getActiveTabId()).toBe("tab-b");
      expect(mockWindow.contentView.removeChildView).toHaveBeenCalled();
    });
  });

  describe("bounds validation", () => {
    it("validates and normalizes negative bounds", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-bounds-neg", "http://localhost:3000");
      manager.showTab("tab-bounds-neg", { x: -100, y: -50, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-bounds-neg");
    });

    it("validates and normalizes invalid width/height", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-bounds-small", "http://localhost:3000");
      manager.showTab("tab-bounds-small", { x: 0, y: 0, width: 10, height: 10 });

      expect(manager.getActiveTabId()).toBe("tab-bounds-small");
    });

    it("handles NaN values in bounds", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-bounds-nan", "http://localhost:3000");
      manager.showTab("tab-bounds-nan", { x: NaN, y: NaN, width: NaN, height: NaN });

      expect(manager.getActiveTabId()).toBe("tab-bounds-nan");
    });

    it("handles Infinity values in bounds", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-bounds-inf", "http://localhost:3000");
      manager.showTab("tab-bounds-inf", {
        x: Infinity,
        y: -Infinity,
        width: Infinity,
        height: 600,
      });

      expect(manager.getActiveTabId()).toBe("tab-bounds-inf");
    });
  });

  describe("hideAll()", () => {
    it("hides all tabs and clears active tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-hide", "http://localhost:3000");
      manager.showTab("tab-hide", { x: 0, y: 0, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-hide");

      manager.hideAll();

      expect(manager.getActiveTabId()).toBeNull();
      expect(mockWindow.contentView.removeChildView).toHaveBeenCalled();
    });

    it("is safe to call when no tab is active", () => {
      const manager = new PortalManagerClass(mockWindow);

      expect(() => manager.hideAll()).not.toThrow();
      expect(manager.getActiveTabId()).toBeNull();
    });
  });

  describe("updateBounds()", () => {
    it("updates bounds of active view", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-update-bounds", "http://localhost:3000");
      manager.showTab("tab-update-bounds", { x: 0, y: 0, width: 800, height: 600 });

      manager.updateBounds({ x: 50, y: 50, width: 1000, height: 800 });

      expect(manager.getActiveTabId()).toBe("tab-update-bounds");
    });

    it("does nothing when no active view", () => {
      const manager = new PortalManagerClass(mockWindow);

      expect(() => manager.updateBounds({ x: 0, y: 0, width: 800, height: 600 })).not.toThrow();
    });
  });

  describe("closeTab()", () => {
    it("closes an existing tab", async () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-close", "http://localhost:3000");
      expect(manager.hasTab("tab-close")).toBe(true);

      await manager.closeTab("tab-close");
      expect(manager.hasTab("tab-close")).toBe(false);
    });

    it("clears active tab if closing active", async () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-close-active", "http://localhost:3000");
      manager.showTab("tab-close-active", { x: 0, y: 0, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-close-active");

      await manager.closeTab("tab-close-active");

      expect(manager.getActiveTabId()).toBeNull();
      expect(manager.hasTab("tab-close-active")).toBe(false);
    });

    it("does nothing for non-existent tab", async () => {
      const manager = new PortalManagerClass(mockWindow);

      await expect(manager.closeTab("non-existent")).resolves.toBeUndefined();
    });

    it("flushes storage data before closing webContents", async () => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-flush", "http://localhost:3000");
      const wc = createdWebContents[createdWebContents.length - 1];

      const callOrder: string[] = [];
      wc.session.flushStorageData.mockImplementation(() => {
        callOrder.push("flush");
        return Promise.resolve();
      });
      wc.close.mockImplementation(() => {
        callOrder.push("close");
      });

      await manager.closeTab("tab-flush");

      expect(callOrder).toEqual(["flush", "close"]);
    });

    it("still closes webContents if flushStorageData rejects", async () => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-flush-fail", "http://localhost:3000");
      const wc = createdWebContents[createdWebContents.length - 1];
      wc.session.flushStorageData.mockRejectedValueOnce(new Error("flush failed"));

      await manager.closeTab("tab-flush-fail");

      expect(wc.close).toHaveBeenCalled();
      expect(manager.hasTab("tab-flush-fail")).toBe(false);
    });
  });

  describe("navigate()", () => {
    it("navigates to valid http URL", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-nav", "http://localhost:3000");
      manager.navigate("tab-nav", "http://localhost:4000");

      expect(manager.hasTab("tab-nav")).toBe(true);
    });

    it("navigates to valid https URL", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-nav-https", "http://localhost:3000");
      manager.navigate("tab-nav-https", "https://example.com");

      expect(manager.hasTab("tab-nav-https")).toBe(true);
    });

    it("rejects navigation to invalid protocol", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-nav-invalid", "http://localhost:3000");
      const wc = createdWebContents[createdWebContents.length - 1];
      const initialLoadCount = wc.loadURL.mock.calls.length;

      expect(() => manager.navigate("tab-nav-invalid", "file:///etc/passwd")).not.toThrow();
      expect(wc.loadURL.mock.calls.length).toBe(initialLoadCount);
    });

    it("rejects navigation to javascript: URL", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-nav-js", "http://localhost:3000");
      const wc = createdWebContents[createdWebContents.length - 1];
      const initialLoadCount = wc.loadURL.mock.calls.length;

      expect(() => manager.navigate("tab-nav-js", "javascript:alert(1)")).not.toThrow();
      expect(wc.loadURL.mock.calls.length).toBe(initialLoadCount);
    });

    it("does nothing for non-existent tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      expect(() => manager.navigate("non-existent", "http://localhost:3000")).not.toThrow();
    });

    it("catches loadURL rejection to prevent unhandled promise rejection", async () => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab("tab-nav-reject", "http://localhost:3000");

      const wc = createdWebContents[createdWebContents.length - 1];
      const navError = new Error("net::ERR_NAME_NOT_RESOLVED");
      wc.loadURL.mockRejectedValueOnce(navError);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        manager.navigate("tab-nav-reject", "http://unreachable.test");

        await Promise.resolve();

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("[PortalManager] Failed to navigate tab tab-nav-reject"),
          navError
        );
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe("goBack() / goForward()", () => {
    it("returns false when cannot go back", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-back", "http://localhost:3000");

      expect(manager.goBack("tab-back")).toBe(false);
    });

    it("returns false when cannot go forward", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-forward", "http://localhost:3000");

      expect(manager.goForward("tab-forward")).toBe(false);
    });

    it("returns false for non-existent tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      expect(manager.goBack("non-existent")).toBe(false);
      expect(manager.goForward("non-existent")).toBe(false);
    });
  });

  describe("reload()", () => {
    it("reloads an existing tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-reload", "http://localhost:3000");

      expect(() => manager.reload("tab-reload")).not.toThrow();
    });

    it("does nothing for non-existent tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      expect(() => manager.reload("non-existent")).not.toThrow();
    });
  });

  describe("hasTab()", () => {
    it("returns true for existing tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-has", "http://localhost:3000");

      expect(manager.hasTab("tab-has")).toBe(true);
    });

    it("returns false for non-existent tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      expect(manager.hasTab("non-existent")).toBe(false);
    });
  });

  describe("getActiveTabId()", () => {
    it("returns null when no tab is active", () => {
      const manager = new PortalManagerClass(mockWindow);

      expect(manager.getActiveTabId()).toBeNull();
    });

    it("returns active tab ID when a tab is shown", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-active", "http://localhost:3000");
      manager.showTab("tab-active", { x: 0, y: 0, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-active");
    });
  });

  describe("destroy()", () => {
    it("destroys all tabs and clears state", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-d1", "http://localhost:3000");
      manager.createTab("tab-d2", "http://localhost:4000");
      manager.showTab("tab-d1", { x: 0, y: 0, width: 800, height: 600 });

      manager.destroy();

      expect(manager.hasTab("tab-d1")).toBe(false);
      expect(manager.hasTab("tab-d2")).toBe(false);
      expect(manager.getActiveTabId()).toBeNull();
    });

    it("is safe to call multiple times", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-multi-destroy", "http://localhost:3000");

      expect(() => {
        manager.destroy();
        manager.destroy();
      }).not.toThrow();
    });
  });
});

describe("PortalManager LRU eviction", () => {
  let PortalManagerClass: typeof import("../PortalManager.js").PortalManager;
  let PORTAL_MAX_LIVE_TABS: number;
  let mockWindow: InstanceType<typeof import("electron").BrowserWindow>;

  beforeEach(async () => {
    createdWebContents.length = 0;
    vi.resetModules();

    const electron = await import("electron");
    mockWindow = new electron.BrowserWindow() as InstanceType<typeof electron.BrowserWindow>;

    const module = await import("../PortalManager.js");
    PortalManagerClass = module.PortalManager;
    PORTAL_MAX_LIVE_TABS = module.PORTAL_MAX_LIVE_TABS;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("has a limit of 3", () => {
    expect(PORTAL_MAX_LIVE_TABS).toBe(3);
  });

  it("evicts the oldest background tab when exceeding the limit", () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:1001");
    manager.createTab("tab-2", "http://localhost:1002");
    manager.createTab("tab-3", "http://localhost:1003");

    expect(manager.hasTab("tab-1")).toBe(true);
    expect(manager.hasTab("tab-2")).toBe(true);
    expect(manager.hasTab("tab-3")).toBe(true);

    manager.createTab("tab-4", "http://localhost:1004");

    expect(manager.hasTab("tab-1")).toBe(false);
    expect(manager.hasTab("tab-2")).toBe(true);
    expect(manager.hasTab("tab-3")).toBe(true);
    expect(manager.hasTab("tab-4")).toBe(true);
  });

  it("sends exactly one PORTAL_TAB_EVICTED event per eviction", () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:1001");
    manager.createTab("tab-2", "http://localhost:1002");
    manager.createTab("tab-3", "http://localhost:1003");

    const evictedCalls = () =>
      (mockWindow.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ch]: string[]) => ch === "portal:tab-evicted"
      );

    expect(evictedCalls()).toHaveLength(0);

    manager.createTab("tab-4", "http://localhost:1004");
    expect(evictedCalls()).toHaveLength(1);
    expect(evictedCalls()[0][1]).toEqual({ tabId: "tab-1" });

    manager.createTab("tab-5", "http://localhost:1005");
    expect(evictedCalls()).toHaveLength(2);
    expect(evictedCalls()[1][1]).toEqual({ tabId: "tab-2" });
  });

  it("closeTab does not emit eviction event", async () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:1001");
    manager.createTab("tab-2", "http://localhost:1002");
    (mockWindow.webContents.send as ReturnType<typeof vi.fn>).mockClear();

    await manager.closeTab("tab-2");

    const evictedCalls = (
      mockWindow.webContents.send as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([ch]: string[]) => ch === "portal:tab-evicted");
    expect(evictedCalls).toHaveLength(0);
  });

  it("no eviction on hideAll + re-show", () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:1001");
    manager.createTab("tab-2", "http://localhost:1002");
    manager.createTab("tab-3", "http://localhost:1003");

    manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });
    (mockWindow.webContents.send as ReturnType<typeof vi.fn>).mockClear();

    manager.hideAll();
    manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });

    const evictedCalls = (
      mockWindow.webContents.send as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([ch]: string[]) => ch === "portal:tab-evicted");
    expect(evictedCalls).toHaveLength(0);
    expect(manager.hasTab("tab-1")).toBe(true);
    expect(manager.hasTab("tab-2")).toBe(true);
    expect(manager.hasTab("tab-3")).toBe(true);
  });

  it("never evicts the active tab", () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:1001");
    manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });
    manager.createTab("tab-2", "http://localhost:1002");
    manager.createTab("tab-3", "http://localhost:1003");

    // tab-1 is active (oldest), tab-2 and tab-3 are background
    // Creating tab-4 should evict tab-2 (oldest background), not tab-1 (active)
    manager.createTab("tab-4", "http://localhost:1004");

    expect(manager.hasTab("tab-1")).toBe(true);
    expect(manager.getActiveTabId()).toBe("tab-1");
    expect(manager.hasTab("tab-2")).toBe(false);
    expect(manager.hasTab("tab-3")).toBe(true);
    expect(manager.hasTab("tab-4")).toBe(true);
  });

  it("showTab refreshes LRU order", () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:1001");
    manager.createTab("tab-2", "http://localhost:1002");
    manager.createTab("tab-3", "http://localhost:1003");

    // Show tab-1, making it MRU
    manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });

    // Creating tab-4 should evict tab-2 (now the LRU background tab)
    manager.createTab("tab-4", "http://localhost:1004");

    expect(manager.hasTab("tab-1")).toBe(true);
    expect(manager.hasTab("tab-2")).toBe(false);
    expect(manager.hasTab("tab-3")).toBe(true);
    expect(manager.hasTab("tab-4")).toBe(true);
  });

  it("closeTab on already-evicted tab is a no-op", async () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:1001");
    manager.createTab("tab-2", "http://localhost:1002");
    manager.createTab("tab-3", "http://localhost:1003");
    manager.createTab("tab-4", "http://localhost:1004");

    // tab-1 was evicted
    expect(manager.hasTab("tab-1")).toBe(false);

    // Closing it again should not throw
    await expect(manager.closeTab("tab-1")).resolves.toBeUndefined();
  });

  it("calls webContents.close() on evicted views", async () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:1001");
    const evictedWebContents = createdWebContents[0];
    manager.createTab("tab-2", "http://localhost:1002");
    manager.createTab("tab-3", "http://localhost:1003");
    manager.createTab("tab-4", "http://localhost:1004");

    // Eviction is fire-and-forget async — wait for flush+close to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(evictedWebContents.session.flushStorageData).toHaveBeenCalled();
    expect(evictedWebContents.close).toHaveBeenCalled();
  });

  it("handles rapid create/show cycling without crashing", () => {
    const manager = new PortalManagerClass(mockWindow);

    expect(() => {
      for (let i = 0; i < 10; i++) {
        const tabId = `tab-${i}`;
        manager.createTab(tabId, `http://localhost:${3000 + i}`);
        manager.showTab(tabId, { x: 0, y: 0, width: 800, height: 600 });
      }
    }).not.toThrow();

    // Only the last PORTAL_MAX_LIVE_TABS tabs should be alive
    for (let i = 0; i < 10 - PORTAL_MAX_LIVE_TABS; i++) {
      expect(manager.hasTab(`tab-${i}`)).toBe(false);
    }
    for (let i = 10 - PORTAL_MAX_LIVE_TABS; i < 10; i++) {
      expect(manager.hasTab(`tab-${i}`)).toBe(true);
    }
  });

  it("destroy after evictions does not double-close", async () => {
    const manager = new PortalManagerClass(mockWindow);

    manager.createTab("tab-1", "http://localhost:1001");
    manager.createTab("tab-2", "http://localhost:1002");
    manager.createTab("tab-3", "http://localhost:1003");
    manager.createTab("tab-4", "http://localhost:1004");

    // Wait for eviction flush+close to settle
    await new Promise((r) => setTimeout(r, 0));

    // tab-1 was evicted, its close was already called
    const evictedWebContents = createdWebContents[0];
    const closeCallsBefore = evictedWebContents.close.mock.calls.length;

    expect(() => manager.destroy()).not.toThrow();

    // Wait for destroy flush+close to settle
    await new Promise((r) => setTimeout(r, 0));

    // tab-1 should not have been closed again (it was already evicted)
    expect(evictedWebContents.close.mock.calls.length).toBe(closeCallsBefore);
  });
});

describe("PortalManager destroyHiddenTabs()", () => {
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

  it("awaits flushStorageData before closing hidden tabs", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-1", "http://localhost:3000");
    manager.createTab("tab-2", "http://localhost:3001");
    manager.showTab("tab-2", { x: 0, y: 0, width: 800, height: 600 });

    const wc = createdWebContents[0]; // tab-1's webContents
    let flushResolved = false;
    let closeCalledBeforeFlush = false;

    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    wc.session.flushStorageData.mockReturnValue(promise);
    wc.close.mockImplementation(() => {
      if (!flushResolved) closeCalledBeforeFlush = true;
    });

    const destroyPromise = manager.destroyHiddenTabs();

    // Flush hasn't resolved yet — close should not have been called
    await Promise.resolve(); // let microtasks run
    expect(wc.close).not.toHaveBeenCalled();

    flushResolved = true;
    resolve();
    await destroyPromise;

    expect(closeCalledBeforeFlush).toBe(false);
    expect(wc.close).toHaveBeenCalled();
  });

  it("returns destroyed tab IDs and preserves active tab", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-a", "http://localhost:3000");
    manager.createTab("tab-b", "http://localhost:3001");
    manager.createTab("tab-c", "http://localhost:3002");
    manager.showTab("tab-b", { x: 0, y: 0, width: 800, height: 600 });

    const result = await manager.destroyHiddenTabs();

    expect(result.sort()).toEqual(["tab-a", "tab-c"]);
    expect(manager.hasTab("tab-b")).toBe(true);
    expect(manager.hasTab("tab-a")).toBe(false);
    expect(manager.hasTab("tab-c")).toBe(false);
  });

  it("preserves lastShownTabId when activeTabId is null", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-1", "http://localhost:3000");
    manager.createTab("tab-2", "http://localhost:3001");
    manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });
    manager.hideAll(); // clears activeTabId, but lastShownTabId = tab-1

    const result = await manager.destroyHiddenTabs();

    expect(result).toEqual(["tab-2"]);
    expect(manager.hasTab("tab-1")).toBe(true);
    expect(manager.hasTab("tab-2")).toBe(false);
  });

  it("one flush failure does not block other tabs from closing", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-1", "http://localhost:3000");
    manager.createTab("tab-2", "http://localhost:3001");
    manager.createTab("tab-3", "http://localhost:3002");
    manager.showTab("tab-3", { x: 0, y: 0, width: 800, height: 600 });

    // Make tab-1's flush reject
    createdWebContents[0].session.flushStorageData.mockRejectedValue(new Error("disk full"));

    const result = await manager.destroyHiddenTabs();

    expect(result.sort()).toEqual(["tab-1", "tab-2"]);
    // Both tabs should still be closed despite tab-1's flush failure
    expect(createdWebContents[0].close).toHaveBeenCalled();
    expect(createdWebContents[1].close).toHaveBeenCalled();
  });

  it("returns empty array when all tabs are active/skipped", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-only", "http://localhost:3000");
    manager.showTab("tab-only", { x: 0, y: 0, width: 800, height: 600 });

    const result = await manager.destroyHiddenTabs();

    expect(result).toEqual([]);
    expect(manager.hasTab("tab-only")).toBe(true);
  });

  it("is idempotent — second call returns empty array", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-1", "http://localhost:3000");
    manager.createTab("tab-2", "http://localhost:3001");
    manager.showTab("tab-2", { x: 0, y: 0, width: 800, height: 600 });

    const first = await manager.destroyHiddenTabs();
    expect(first).toEqual(["tab-1"]);

    const second = await manager.destroyHiddenTabs();
    expect(second).toEqual([]);
  });
});

describe("PortalManager URL validation", () => {
  let PortalManagerClass: typeof import("../PortalManager.js").PortalManager;
  let mockWindow: InstanceType<typeof import("electron").BrowserWindow>;

  beforeEach(async () => {
    vi.resetModules();

    const electron = await import("electron");
    mockWindow = new electron.BrowserWindow() as InstanceType<typeof electron.BrowserWindow>;

    const module = await import("../PortalManager.js");
    PortalManagerClass = module.PortalManager;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const invalidUrls = [
    { url: "file:///etc/passwd", desc: "file protocol" },
    { url: "javascript:alert(1)", desc: "javascript protocol" },
    { url: "data:text/html,<h1>XSS</h1>", desc: "data protocol" },
    { url: "vbscript:msgbox(1)", desc: "vbscript protocol" },
    { url: "about:blank", desc: "about protocol" },
    { url: "chrome://settings", desc: "chrome protocol" },
    { url: "ftp://example.com", desc: "ftp protocol" },
    { url: "mailto:test@example.com", desc: "mailto protocol" },
    { url: "tel:+1234567890", desc: "tel protocol" },
  ];

  for (const { url, desc } of invalidUrls) {
    it(`rejects ${desc} URL: ${url}`, () => {
      const manager = new PortalManagerClass(mockWindow);
      manager.createTab(`tab-${desc}`, url);
      expect(manager.hasTab(`tab-${desc}`)).toBe(false);
    });
  }

  const validUrls = [
    "http://localhost:3000",
    "https://localhost:3000",
    "http://127.0.0.1:8080",
    "https://example.com",
    "http://example.com/path?query=1#hash",
    "https://subdomain.example.com:8443/api/v1",
  ];

  for (const url of validUrls) {
    it(`accepts valid URL: ${url}`, () => {
      const manager = new PortalManagerClass(mockWindow);
      const tabId = `tab-valid-${url.replace(/[^a-z0-9]/gi, "")}`;
      manager.createTab(tabId, url);
      expect(manager.hasTab(tabId)).toBe(true);
    });
  }
});
