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
  isCurrentlyAudible: vi.fn().mockReturnValue(false),
  isDevToolsOpened: vi.fn().mockReturnValue(false),
  isLoading: vi.fn().mockReturnValue(false),
  getOSProcessId: vi.fn().mockReturnValue(0),
  mainFrame: { framesInSubtree: [] as Array<{ osProcessId: number }> },
  removeListener: vi.fn().mockReturnThis(),
  session: {
    flushStorageData: vi.fn().mockResolvedValue(undefined),
  },
});

const createdWebContents: ReturnType<typeof createMockWebContents>[] = [];

vi.mock("electron", () => {
  class MockWebContentsView {
    webContents = createMockWebContents();
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();
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

const lifecycleMocks = vi.hoisted(() => ({
  unthrottleCpuWebContents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/webContentsLifecycle.js", () => lifecycleMocks);

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

    it("rejects malformed URLs", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-6", "not-a-valid-url");

      expect(manager.hasTab("tab-6")).toBe(false);
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
      // Tab switching parks the previous active view offscreen rather than
      // detaching it — preserves embedded page state across switches.
      expect(mockWindow.contentView.removeChildView).not.toHaveBeenCalled();
      expect(mockWindow.contentView.addChildView).toHaveBeenCalledTimes(2);
    });

    it("parks the previous tab without touching its CPU rate and resets the shown tab's", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-a", "http://localhost:3000");
      manager.createTab("tab-b", "http://localhost:4000");
      const wcA = createdWebContents[0];
      const wcB = createdWebContents[1];

      manager.showTab("tab-a", { x: 0, y: 0, width: 800, height: 600 });
      expect(lifecycleMocks.unthrottleCpuWebContents).toHaveBeenCalledWith(wcA);

      lifecycleMocks.unthrottleCpuWebContents.mockClear();
      manager.showTab("tab-b", { x: 0, y: 0, width: 800, height: 600 });
      // CDP CPU throttling busy-spins the renderer it "slows" (#12456), so the
      // parked tab gets no CPU-rate command at all.
      expect(lifecycleMocks.unthrottleCpuWebContents).toHaveBeenCalledTimes(1);
      expect(lifecycleMocks.unthrottleCpuWebContents).toHaveBeenCalledWith(wcB);
    });

    it("skips the CPU-rate reset for a destroyed tab being shown", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-a", "http://localhost:3000");
      const wcA = createdWebContents[0];
      wcA.isDestroyed.mockReturnValue(true);

      manager.showTab("tab-a", { x: 0, y: 0, width: 800, height: 600 });
      expect(lifecycleMocks.unthrottleCpuWebContents).not.toHaveBeenCalled();
    });
  });

  describe("hideAll()", () => {
    it("parks active view offscreen without detaching or clearing activeTabId", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-hide", "http://localhost:3000");
      manager.showTab("tab-hide", { x: 0, y: 0, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-hide");

      const view = createdWebContents[createdWebContents.length - 1];
      // Resolve the WebContentsView instance via the same mock pattern other
      // tests use — setBounds is on the view itself, not webContents.
      const electronModule = (
        mockWindow as unknown as { contentView: { addChildView: ReturnType<typeof vi.fn> } }
      ).contentView;
      const addedView = electronModule.addChildView.mock.calls.at(-1)?.[0] as {
        setBounds: ReturnType<typeof vi.fn>;
      };

      const setBoundsCallsBefore = addedView.setBounds.mock.calls.length;

      manager.hideAll();

      // activeView/activeTabId remain set so the same tab re-appears when the
      // overlay closes and destroyHiddenTabs() still protects this tab.
      expect(manager.getActiveTabId()).toBe("tab-hide");
      // No detach — preserves embedded page state across overlay open/close.
      expect(mockWindow.contentView.removeChildView).not.toHaveBeenCalled();
      // setBounds was called with offscreen coordinates.
      expect(addedView.setBounds.mock.calls.length).toBe(setBoundsCallsBefore + 1);
      const offscreenBounds = addedView.setBounds.mock.calls.at(-1)?.[0];
      expect(offscreenBounds.x).toBeLessThan(0);
      expect(offscreenBounds.y).toBeLessThan(0);
      // Suppress unused-warning for `view` — it is still imported to allow the
      // test name to refer to "view" semantics even though webContents-level
      // assertions aren't needed here.
      expect(view).toBeDefined();
    });

    it("parks the view without touching its CPU rate; showTab resets it", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-hide-park", "http://localhost:3000");
      const wc = createdWebContents[0];

      manager.showTab("tab-hide-park", { x: 0, y: 0, width: 800, height: 600 });
      lifecycleMocks.unthrottleCpuWebContents.mockClear();

      manager.hideAll();
      expect(lifecycleMocks.unthrottleCpuWebContents).not.toHaveBeenCalled();

      manager.showTab("tab-hide-park", { x: 0, y: 0, width: 800, height: 600 });
      expect(lifecycleMocks.unthrottleCpuWebContents).toHaveBeenCalledWith(wc);
    });

    it("re-showing the same tab after hideAll does not call addChildView again", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-cycle", "http://localhost:3000");
      manager.showTab("tab-cycle", { x: 0, y: 0, width: 800, height: 600 });
      expect(mockWindow.contentView.addChildView).toHaveBeenCalledTimes(1);

      manager.hideAll();
      manager.showTab("tab-cycle", { x: 0, y: 0, width: 800, height: 600 });

      // No second addChildView — view stayed attached across hide/show cycle.
      // This is what preserves embedded WebContents state across overlay open/close.
      expect(mockWindow.contentView.addChildView).toHaveBeenCalledTimes(1);
      expect(mockWindow.contentView.removeChildView).not.toHaveBeenCalled();
    });

    it("updateBounds is a no-op while parked offscreen", () => {
      // Regression guard for #9207 follow-up: PortalDock's ResizeObserver and
      // window-resize listener only gate on activeTabId, which is preserved
      // across hideAll(). Without this guard a window resize while an overlay
      // is open would re-show the parked view on top of the overlay.
      const manager = new PortalManagerClass(mockWindow);

      const addChildViewMock = mockWindow.contentView.addChildView as ReturnType<typeof vi.fn>;
      manager.createTab("tab-resize", "http://localhost:3000");
      manager.showTab("tab-resize", { x: 0, y: 0, width: 800, height: 600 });
      const view = addChildViewMock.mock.calls.at(-1)?.[0] as {
        setBounds: ReturnType<typeof vi.fn>;
      };

      manager.hideAll();
      const setBoundsCallsAfterHide = view.setBounds.mock.calls.length;

      // Simulate a window resize firing through PortalDock → portal.resize.
      manager.updateBounds({ x: 0, y: 0, width: 1024, height: 768 });

      // The view must remain offscreen — updateBounds was suppressed.
      expect(view.setBounds.mock.calls.length).toBe(setBoundsCallsAfterHide);
    });

    it("updateBounds resumes after showTab re-shows the parked tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      const addChildViewMock = mockWindow.contentView.addChildView as ReturnType<typeof vi.fn>;
      manager.createTab("tab-resume", "http://localhost:3000");
      manager.showTab("tab-resume", { x: 0, y: 0, width: 800, height: 600 });
      const view = addChildViewMock.mock.calls.at(-1)?.[0] as {
        setBounds: ReturnType<typeof vi.fn>;
      };

      manager.hideAll();
      manager.showTab("tab-resume", { x: 0, y: 0, width: 1024, height: 768 });

      const setBoundsCallsBefore = view.setBounds.mock.calls.length;
      manager.updateBounds({ x: 0, y: 0, width: 1200, height: 900 });

      // updateBounds is no longer suppressed — view receives the new bounds.
      expect(view.setBounds.mock.calls.length).toBe(setBoundsCallsBefore + 1);
      const lastBounds = view.setBounds.mock.calls.at(-1)?.[0];
      expect(lastBounds.width).toBe(1200);
      expect(lastBounds.height).toBe(900);
    });

    it("hideAll returns focus to the main app webContents", () => {
      // The old removeChildView path implicitly blurred the portal view.
      // Keep that behavior so the overlay's renderer focus-trap receives
      // keyboard input instead of the now-hidden portal page.
      const manager = new PortalManagerClass(mockWindow);

      // The window's webContents is the app WebContents in this test mock
      // (single-WebContents BrowserWindow stand-in).
      const focusMock = vi.fn();
      (mockWindow.webContents as unknown as { focus: typeof focusMock }).focus = focusMock;

      manager.createTab("tab-focus", "http://localhost:3000");
      manager.showTab("tab-focus", { x: 0, y: 0, width: 800, height: 600 });
      manager.hideAll();

      expect(focusMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("setBackgroundColor (flash prevention)", () => {
    it("applies background color to new view before loadURL", () => {
      const customBg = "#1a1a1a";
      const manager = new PortalManagerClass(mockWindow, customBg);

      const addChildViewMock = mockWindow.contentView.addChildView as ReturnType<typeof vi.fn>;
      const beforeCalls = addChildViewMock.mock.calls.length;

      manager.createTab("tab-bg", "http://localhost:3000");
      manager.showTab("tab-bg", { x: 0, y: 0, width: 800, height: 600 });

      const view = addChildViewMock.mock.calls[beforeCalls]?.[0] as {
        setBackgroundColor: ReturnType<typeof vi.fn>;
      };
      const wc = createdWebContents[createdWebContents.length - 1];

      expect(view.setBackgroundColor).toHaveBeenCalledWith(customBg);

      // Order: setBackgroundColor must run before loadURL so the first paint
      // doesn't show the default opaque white.
      const bgOrder = view.setBackgroundColor.mock.invocationCallOrder[0];
      const loadOrder = wc.loadURL.mock.invocationCallOrder[0];
      expect(bgOrder).toBeLessThan(loadOrder);
    });
  });

  describe("updateBounds()", () => {
    it("does nothing when no active view", () => {
      const manager = new PortalManagerClass(mockWindow);

      expect(() => manager.updateBounds({ x: 0, y: 0, width: 800, height: 600 })).not.toThrow();
    });
  });

  describe("closeTab()", () => {
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
    it("rejects navigation to invalid protocol", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.createTab("tab-nav-invalid", "http://localhost:3000");
      const wc = createdWebContents[createdWebContents.length - 1];
      const initialLoadCount = wc.loadURL.mock.calls.length;

      expect(() => manager.navigate("tab-nav-invalid", "file:///etc/passwd")).not.toThrow();
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
    it("does nothing for non-existent tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      expect(() => manager.reload("non-existent")).not.toThrow();
    });
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

    const blockedUrls = ["file:///etc/passwd", "not a url"];

    const allowedUrls = ["https://example.com/path?q=1"];

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

  describe("restoring tab guard (#9971)", () => {
    it("does not evict a tab in the create→show restore window", () => {
      const manager = new PortalManagerClass(mockWindow);

      // tab-1 is mid-restore: created, bounds polling in flight, show pending.
      manager.markRestoring("tab-1");
      manager.createTab("tab-1", "http://localhost:1001");
      manager.createTab("tab-2", "http://localhost:1002");
      manager.createTab("tab-3", "http://localhost:1003");

      // A background create overflows the limit. tab-1 is the LRU and not the
      // active tab, but the restore guard must protect it — tab-2 (oldest
      // unprotected) is evicted instead.
      manager.createTab("tab-4", "http://localhost:1004");

      expect(manager.hasTab("tab-1")).toBe(true);
      expect(manager.hasTab("tab-2")).toBe(false);
      expect(manager.hasTab("tab-3")).toBe(true);
      expect(manager.hasTab("tab-4")).toBe(true);
    });

    it("showTab clears the guard so the tab re-enters normal LRU order", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.markRestoring("tab-1");
      manager.createTab("tab-1", "http://localhost:1001");
      manager.createTab("tab-2", "http://localhost:1002");
      manager.createTab("tab-3", "http://localhost:1003");

      // Restore completes, then the user switches through the other tabs,
      // leaving tab-1 as the LRU background tab.
      manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });
      manager.showTab("tab-2", { x: 0, y: 0, width: 800, height: 600 });
      manager.showTab("tab-3", { x: 0, y: 0, width: 800, height: 600 });

      manager.createTab("tab-4", "http://localhost:1004");

      // Guard is gone — tab-1 is evictable again.
      expect(manager.hasTab("tab-1")).toBe(false);
      expect(manager.hasTab("tab-2")).toBe(true);
      expect(manager.hasTab("tab-3")).toBe(true);
      expect(manager.hasTab("tab-4")).toBe(true);
    });

    it("closeTab mid-restore leaves no stale guard for a reused tab id", async () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.markRestoring("tab-1");
      manager.createTab("tab-1", "http://localhost:1001");
      await manager.closeTab("tab-1");

      // Recreate the same id as a plain background tab — it must follow
      // normal LRU eviction, which fails if the old guard entry leaked.
      manager.createTab("tab-1", "http://localhost:1001");
      manager.createTab("tab-2", "http://localhost:1002");
      manager.createTab("tab-3", "http://localhost:1003");
      manager.createTab("tab-4", "http://localhost:1004");

      expect(manager.hasTab("tab-1")).toBe(false);
      expect(manager.hasTab("tab-2")).toBe(true);
    });

    it("createTab failure clears the guard set by a preceding markRestoring", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.markRestoring("tab-1");
      manager.createTab("tab-1", "not-a-valid-url");
      expect(manager.hasTab("tab-1")).toBe(false);

      // Same id later created as a background tab must not inherit protection.
      manager.createTab("tab-1", "http://localhost:1001");
      manager.createTab("tab-2", "http://localhost:1002");
      manager.createTab("tab-3", "http://localhost:1003");
      manager.createTab("tab-4", "http://localhost:1004");

      expect(manager.hasTab("tab-1")).toBe(false);
      expect(manager.hasTab("tab-2")).toBe(true);
    });

    it("tolerates exceeding the limit when every candidate is protected", () => {
      const manager = new PortalManagerClass(mockWindow);

      for (let i = 1; i <= 4; i++) {
        manager.markRestoring(`tab-${i}`);
        manager.createTab(`tab-${i}`, `http://localhost:${1000 + i}`);
      }

      // No eligible eviction candidate — all four stay alive until a show
      // resolves one of the restores.
      for (let i = 1; i <= 4; i++) {
        expect(manager.hasTab(`tab-${i}`)).toBe(true);
      }

      // First show clears tab-1's guard but makes it active — still over the
      // limit, still nothing evictable. The second show releases tab-1 as a
      // normal LRU candidate and the deferred eviction reclaims it.
      manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });
      for (let i = 1; i <= 4; i++) {
        expect(manager.hasTab(`tab-${i}`)).toBe(true);
      }

      manager.showTab("tab-2", { x: 0, y: 0, width: 800, height: 600 });
      expect(manager.hasTab("tab-1")).toBe(false);
      expect(manager.hasTab("tab-2")).toBe(true);
      expect(manager.hasTab("tab-3")).toBe(true);
      expect(manager.hasTab("tab-4")).toBe(true);
    });

    it("protects multiple concurrent restores while evicting the unprotected LRU tab", () => {
      const manager = new PortalManagerClass(mockWindow);

      // Two restores in flight at once (e.g. queued restore follows an overlay
      // close) racing a background create that overflows the limit.
      manager.markRestoring("tab-1");
      manager.createTab("tab-1", "http://localhost:3001");
      manager.createTab("tab-2", "http://localhost:3002");
      manager.markRestoring("tab-3");
      manager.createTab("tab-3", "http://localhost:3003");

      manager.createTab("tab-4", "http://localhost:3004");

      expect(manager.hasTab("tab-1")).toBe(true);
      expect(manager.hasTab("tab-2")).toBe(false);
      expect(manager.hasTab("tab-3")).toBe(true);
      expect(manager.hasTab("tab-4")).toBe(true);
    });

    it("restoring guard does not leak through destroy()", () => {
      const manager = new PortalManagerClass(mockWindow);

      manager.markRestoring("tab-1");
      manager.createTab("tab-1", "http://localhost:3001");
      manager.destroy();

      // Fresh session reusing the same id as a background tab — normal LRU.
      manager.createTab("tab-1", "http://localhost:3001");
      manager.createTab("tab-2", "http://localhost:3002");
      manager.createTab("tab-3", "http://localhost:3003");
      manager.createTab("tab-4", "http://localhost:3004");

      expect(manager.hasTab("tab-1")).toBe(false);
      expect(manager.hasTab("tab-2")).toBe(true);
    });
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

  it("hideAll keeps activeTabId set so the parked tab is protected from eviction", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-1", "http://localhost:3000");
    manager.createTab("tab-2", "http://localhost:3001");
    manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });
    manager.hideAll(); // parks tab-1 offscreen; activeTabId stays "tab-1"

    expect(manager.getActiveTabId()).toBe("tab-1");

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
});

describe("PortalManager across project views (#14537)", () => {
  let PortalManagerClass: typeof import("../PortalManager.js").PortalManager;
  let PORTAL_MAX_LIVE_TABS: number;
  let mockWindow: InstanceType<typeof import("electron").BrowserWindow>;
  const frontView = { id: 1, send: vi.fn(), isDestroyed: () => false };
  const cachedView = { id: 2, send: vi.fn(), isDestroyed: () => false };

  const sentOn = (wc: { send: ReturnType<typeof vi.fn> }, channel: string) =>
    wc.send.mock.calls.filter(([ch]) => ch === channel).map(([, payload]) => payload);

  const handlerFor = (wc: ReturnType<typeof createMockWebContents>, event: string) => {
    const calls = [...wc.on.mock.calls, ...wc.once.mock.calls] as Array<
      [string, (...args: unknown[]) => void]
    >;
    return calls.find(([name]) => name === event)![1];
  };

  beforeEach(async () => {
    createdWebContents.length = 0;
    vi.resetModules();
    vi.doMock("../../window/webContentsRegistry.js", () => ({
      getAppWebContents: () => frontView,
      getWindowAppWebContents: () => [frontView, cachedView],
    }));

    const electron = await import("electron");
    mockWindow = new electron.BrowserWindow() as InstanceType<typeof electron.BrowserWindow>;

    const module = await import("../PortalManager.js");
    PortalManagerClass = module.PortalManager;
    PORTAL_MAX_LIVE_TABS = module.PORTAL_MAX_LIVE_TABS;
  });

  afterEach(() => {
    vi.doUnmock("../../window/webContentsRegistry.js");
    vi.clearAllMocks();
  });

  it("tells a cached project view when LRU eviction takes one of its tabs", () => {
    const manager = new PortalManagerClass(mockWindow);
    for (let i = 1; i <= PORTAL_MAX_LIVE_TABS + 1; i++) {
      manager.createTab(`tab-${i}`, `http://localhost:${1000 + i}`);
    }

    expect(sentOn(cachedView, "portal:tab-evicted")).toEqual([{ tabId: "tab-1" }]);
    expect(sentOn(frontView, "portal:tab-evicted")).toEqual([{ tabId: "tab-1" }]);
  });

  it("tells a cached project view when memory pressure takes its tabs, before the flush ends", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-1", "http://localhost:3000");
    manager.createTab("tab-2", "http://localhost:3001");
    manager.showTab("tab-2", { x: 0, y: 0, width: 800, height: 600 });
    let finishFlush!: () => void;
    createdWebContents[0].session.flushStorageData.mockReturnValue(
      new Promise<void>((resolve) => {
        finishFlush = resolve;
      })
    );

    const sweep = manager.destroyHiddenTabs();

    expect(sentOn(cachedView, "portal:tabs-evicted")).toEqual([{ tabIds: ["tab-1"] }]);
    expect(sentOn(frontView, "portal:tabs-evicted")).toEqual([{ tabIds: ["tab-1"] }]);
    finishFlush();
    await sweep;
  });

  it("announces nothing when memory pressure takes no tabs", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-1", "http://localhost:3000");
    manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });

    await manager.destroyHiddenTabs();

    expect(sentOn(cachedView, "portal:tabs-evicted")).toEqual([]);
  });

  it("keeps a cached project view's tab URL current", () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-1", "http://localhost:3000");

    handlerFor(createdWebContents[0], "did-navigate")({}, "http://localhost:3000/next");

    expect(sentOn(cachedView, "portal:nav-event")).toEqual([
      { tabId: "tab-1", title: "Test Page", url: "http://localhost:3000/next" },
    ]);
  });

  it("drops navigation from a released view once its tab is recreated", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-1", "http://localhost:3000");
    const oldView = createdWebContents[0];
    await manager.closeTab("tab-1");
    manager.createTab("tab-1", "http://localhost:3000/new");

    handlerFor(oldView, "did-navigate")({}, "http://localhost:3000/stale");
    handlerFor(createdWebContents[1], "did-navigate")({}, "http://localhost:3000/new");

    expect(sentOn(cachedView, "portal:nav-event")).toEqual([
      { tabId: "tab-1", title: "Test Page", url: "http://localhost:3000/new" },
    ]);
  });

  it("spares a tab between its create and its show from memory pressure", async () => {
    const manager = new PortalManagerClass(mockWindow);
    manager.createTab("tab-1", "http://localhost:3000");
    manager.showTab("tab-1", { x: 0, y: 0, width: 800, height: 600 });
    manager.markRestoring("tab-2");
    manager.createTab("tab-2", "http://localhost:3001");

    const destroyed = await manager.destroyHiddenTabs();

    expect(destroyed).toEqual([]);
    expect(manager.hasTab("tab-2")).toBe(true);
  });

  it("reports whether it had a view to show", async () => {
    const manager = new PortalManagerClass(mockWindow);
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    manager.createTab("tab-1", "http://localhost:3000");

    await expect(manager.showTab("tab-1", bounds)).resolves.toBe(true);
    await expect(manager.showTab("tab-gone", bounds)).resolves.toBe(false);
  });

  it("keeps a tab recreated while its old view is still shutting down", async () => {
    const manager = new PortalManagerClass(mockWindow);
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    manager.createTab("tab-1", "http://localhost:3000");
    manager.showTab("tab-1", bounds);
    const oldView = createdWebContents[0];

    await manager.closeTab("tab-1");
    manager.createTab("tab-1", "http://localhost:3000");
    manager.showTab("tab-1", bounds);
    handlerFor(oldView, "destroyed")();

    expect(manager.hasTab("tab-1")).toBe(true);
    expect(manager.getActiveTabId()).toBe("tab-1");
    await expect(manager.showTab("tab-1", bounds)).resolves.toBe(true);
  });
});

describe("PortalManager idle release (#14538)", () => {
  let mod: typeof import("../PortalManager.js");
  let mockWindow: InstanceType<typeof import("electron").BrowserWindow>;
  const frontView = { id: 1, send: vi.fn(), isDestroyed: () => false };
  const cachedView = { id: 2, send: vi.fn(), isDestroyed: () => false };
  const logMocks = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
  const metricsMocks = vi.hoisted(() => ({
    getAppMetricsSnapshot: vi.fn(
      (): Array<{ pid: number; memory: { workingSetSize: number } }> => []
    ),
  }));
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const HOUR = 60 * 60 * 1000;

  type MockWc = ReturnType<typeof createMockWebContents>;

  const sentOn = (wc: { send: ReturnType<typeof vi.fn> }, channel: string) =>
    wc.send.mock.calls.filter(([ch]) => ch === channel).map(([, payload]) => payload);

  const emit = (wc: MockWc, event: string, ...args: unknown[]) => {
    const removed = new Set(wc.removeListener.mock.calls.map(([, handler]) => handler));
    const calls = [...wc.on.mock.calls, ...wc.once.mock.calls] as Array<
      [string, (...a: unknown[]) => void]
    >;
    for (const [name, handler] of calls) {
      if (name === event && !removed.has(handler)) handler(...args);
    }
  };

  const closeDestroys = (wc: MockWc) =>
    wc.close.mockImplementation(() => queueMicrotask(() => emit(wc, "destroyed")));

  beforeEach(async () => {
    createdWebContents.length = 0;
    vi.resetModules();
    vi.doMock("../../window/webContentsRegistry.js", () => ({
      getAppWebContents: () => frontView,
      getWindowAppWebContents: () => [frontView, cachedView],
    }));
    vi.doMock("../../utils/logger.js", () => logMocks);
    vi.doMock("../../utils/appMetricsSnapshot.js", () => metricsMocks);
    vi.doMock("../../utils/processMemory.js", () => ({
      getProcessMemoryKb: (m: { memory: { workingSetSize: number } }) => m.memory.workingSetSize,
    }));

    const electron = await import("electron");
    mockWindow = new electron.BrowserWindow() as InstanceType<typeof electron.BrowserWindow>;
    mod = await import("../PortalManager.js");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T09:00:00Z"));
  });

  afterEach(() => {
    vi.doUnmock("../../window/webContentsRegistry.js");
    vi.doUnmock("../../utils/logger.js");
    vi.doUnmock("../../utils/appMetricsSnapshot.js");
    vi.doUnmock("../../utils/processMemory.js");
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  /** tab-1 parked behind tab-2, which is on screen. */
  const parkedBehindAnother = async () => {
    const manager = new mod.PortalManager(mockWindow);
    manager.createTab("tab-1", "http://localhost:3001");
    await manager.showTab("tab-1", bounds);
    manager.createTab("tab-2", "http://localhost:3002");
    await manager.showTab("tab-2", bounds);
    return { manager, parked: createdWebContents[0]!, shown: createdWebContents[1]! };
  };

  it("releases a tab after an hour off screen, counting time the machine slept", async () => {
    const { manager, parked, shown } = await parkedBehindAnother();
    closeDestroys(parked);

    // One check interval of timer time, but an hour of wall clock: asleep.
    vi.setSystemTime(Date.now() + HOUR);
    await vi.advanceTimersByTimeAsync(mod.PORTAL_IDLE_CHECK_INTERVAL_MS);

    expect(parked.close).toHaveBeenCalledWith({ waitForBeforeUnload: true });
    expect(shown.close).not.toHaveBeenCalled();
    expect(manager.hasTab("tab-1")).toBe(false);
    expect(manager.hasTab("tab-2")).toBe(true);
    expect(sentOn(frontView, "portal:tab-evicted")).toEqual([{ tabId: "tab-1" }]);
    expect(sentOn(cachedView, "portal:tab-evicted")).toEqual([{ tabId: "tab-1" }]);
    manager.destroy();
  });

  it("logs each release with how long the tab was hidden and its footprint", async () => {
    const { manager, parked } = await parkedBehindAnother();
    closeDestroys(parked);
    parked.getOSProcessId.mockReturnValue(101);
    parked.mainFrame.framesInSubtree = [{ osProcessId: 202 }, { osProcessId: 202 }];
    metricsMocks.getAppMetricsSnapshot.mockReturnValue([
      { pid: 101, memory: { workingSetSize: 150_000 } },
      { pid: 202, memory: { workingSetSize: 50_000 } },
      { pid: 303, memory: { workingSetSize: 999_999 } },
    ]);

    vi.setSystemTime(Date.now() + HOUR + 1000);
    await manager.releaseIdleTabs();

    expect(logMocks.logInfo).toHaveBeenCalledWith("portal.idle-release", {
      tabId: "tab-1",
      hiddenMs: HOUR + 1000,
      memoryKb: 200_000,
      processCount: 2,
    });
    manager.destroy();
  });

  it("never releases the tab on screen", async () => {
    const { manager, parked, shown } = await parkedBehindAnother();
    closeDestroys(parked);
    vi.setSystemTime(Date.now() + 5 * HOUR);

    await manager.releaseIdleTabs();

    expect(shown.close).not.toHaveBeenCalled();
    expect(manager.getActiveTabId()).toBe("tab-2");
    manager.destroy();
  });

  it("counts a hidden dock's tab from when it was hidden, not from activeTabId", async () => {
    const manager = new mod.PortalManager(mockWindow);
    manager.createTab("tab-1", "http://localhost:3001");
    await manager.showTab("tab-1", bounds);
    const wc = createdWebContents[0]!;
    closeDestroys(wc);

    vi.setSystemTime(Date.now() + 50 * 60_000);
    manager.hideAll();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    manager.hideAll();
    vi.setSystemTime(Date.now() + 20 * 60_000);
    await manager.releaseIdleTabs();
    expect(wc.close).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 30 * 60_000);
    await manager.releaseIdleTabs();
    expect(manager.hasTab("tab-1")).toBe(false);
    expect(manager.getActiveTabId()).toBeNull();
    manager.destroy();
  });

  it.each([
    ["playing audio", (wc: MockWc) => wc.isCurrentlyAudible.mockReturnValue(true)],
    ["with devtools open", (wc: MockWc) => wc.isDevToolsOpened.mockReturnValue(true)],
    ["still loading", (wc: MockWc) => wc.isLoading.mockReturnValue(true)],
  ])("keeps a tab %s", async (_label, exempt) => {
    const { manager, parked } = await parkedBehindAnother();
    exempt(parked);
    vi.setSystemTime(Date.now() + 2 * HOUR);

    await manager.releaseIdleTabs();

    expect(parked.close).not.toHaveBeenCalled();
    expect(manager.hasTab("tab-1")).toBe(true);
    manager.destroy();
  });

  it("keeps a tab mid-restore, but not one whose restore was abandoned", async () => {
    const manager = new mod.PortalManager(mockWindow);
    manager.createTab("tab-1", "http://localhost:3001");
    await manager.showTab("tab-1", bounds);
    manager.markRestoring("tab-2");
    manager.createTab("tab-2", "http://localhost:3002");
    const restoring = createdWebContents[1]!;
    closeDestroys(restoring);

    vi.setSystemTime(Date.now() + HOUR);
    manager.markRestoring("tab-2");
    await manager.releaseIdleTabs();
    expect(restoring.close).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + mod.PORTAL_RESTORE_LEASE_MS);
    await manager.releaseIdleTabs();
    expect(manager.hasTab("tab-2")).toBe(false);
    manager.destroy();
  });

  it("leaves a tab whose page refuses exactly as it was, and asks again an hour later", async () => {
    const { manager, parked } = await parkedBehindAnother();
    parked.close.mockImplementation(() =>
      queueMicrotask(() => emit(parked, "will-prevent-unload"))
    );

    vi.setSystemTime(Date.now() + HOUR);
    await expect(manager.releaseIdleTabs()).resolves.toEqual([]);

    expect(manager.hasTab("tab-1")).toBe(true);
    expect(mockWindow.contentView.removeChildView).not.toHaveBeenCalled();
    expect(sentOn(frontView, "portal:tab-evicted")).toEqual([]);
    expect(sentOn(cachedView, "portal:tab-evicted")).toEqual([]);

    vi.setSystemTime(Date.now() + HOUR - 1000);
    await manager.releaseIdleTabs();
    expect(parked.close).toHaveBeenCalledTimes(1);

    closeDestroys(parked);
    vi.setSystemTime(Date.now() + 1000);
    await manager.releaseIdleTabs();
    expect(parked.close).toHaveBeenCalledTimes(2);
    expect(manager.hasTab("tab-1")).toBe(false);
    manager.destroy();
  });

  it("calls the release off when the tab is shown during its storage flush", async () => {
    const { manager, parked } = await parkedBehindAnother();
    let finishFlush!: () => void;
    parked.session.flushStorageData.mockReturnValue(
      new Promise<void>((resolve) => (finishFlush = resolve))
    );
    vi.setSystemTime(Date.now() + HOUR);

    const release = manager.releaseIdleTabs();
    await expect(manager.showTab("tab-1", bounds)).resolves.toBe(true);
    manager.hideAll();
    vi.setSystemTime(Date.now() + HOUR);
    finishFlush();

    await expect(release).resolves.toEqual([]);
    expect(parked.close).not.toHaveBeenCalled();
    expect(manager.hasTab("tab-1")).toBe(true);
    manager.destroy();
  });

  it("holds a show that lands after the close was sent until the page answers", async () => {
    const { manager, parked } = await parkedBehindAnother();
    vi.setSystemTime(Date.now() + HOUR);
    const release = manager.releaseIdleTabs();
    await vi.waitFor(() => expect(parked.close).toHaveBeenCalled());

    const show = manager.showTab("tab-1", bounds);
    await Promise.resolve();
    expect(manager.getActiveTabId()).toBe("tab-2");

    emit(parked, "will-prevent-unload");
    await expect(show).resolves.toBe(true);
    expect(manager.getActiveTabId()).toBe("tab-1");
    await release;
    manager.destroy();
  });

  it("answers false to a waiting show when the page let the release through", async () => {
    const { manager, parked } = await parkedBehindAnother();
    vi.setSystemTime(Date.now() + HOUR);
    const release = manager.releaseIdleTabs();
    await vi.waitFor(() => expect(parked.close).toHaveBeenCalled());

    const show = manager.showTab("tab-1", bounds);
    emit(parked, "destroyed");

    await expect(show).resolves.toBe(false);
    await expect(release).resolves.toEqual(["tab-1"]);
    expect(manager.getActiveTabId()).toBe("tab-2");
    manager.destroy();
  });

  it("doesn't show a waiting tab over an overlay opened while it waited", async () => {
    const { manager, parked } = await parkedBehindAnother();
    vi.setSystemTime(Date.now() + HOUR);
    const release = manager.releaseIdleTabs();
    await vi.waitFor(() => expect(parked.close).toHaveBeenCalled());

    const show = manager.showTab("tab-1", bounds);
    manager.hideAll();
    emit(parked, "will-prevent-unload");

    await expect(show).resolves.toBe(true);
    expect(manager.getActiveTabId()).toBe("tab-2");
    await release;
    manager.destroy();
  });

  it("keeps holding a show after the sweep stops waiting, and logs a late release once", async () => {
    const { manager, parked } = await parkedBehindAnother();
    vi.setSystemTime(Date.now() + HOUR);

    const release = manager.releaseIdleTabs();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(release).resolves.toEqual([]);
    expect(manager.hasTab("tab-1")).toBe(true);

    const show = manager.showTab("tab-1", bounds);
    await Promise.resolve();
    emit(parked, "destroyed");

    await expect(show).resolves.toBe(false);
    expect(manager.getActiveTabId()).toBe("tab-2");
    expect(sentOn(cachedView, "portal:tab-evicted")).toEqual([{ tabId: "tab-1" }]);
    expect(
      logMocks.logInfo.mock.calls.filter(([event]) => event === "portal.idle-release")
    ).toHaveLength(1);
    manager.destroy();
  });

  it("lets a held show through once a close has gone a minute unanswered", async () => {
    const { manager, parked } = await parkedBehindAnother();
    vi.setSystemTime(Date.now() + HOUR);
    void manager.releaseIdleTabs();
    await vi.waitFor(() => expect(parked.close).toHaveBeenCalled());

    const show = manager.showTab("tab-1", bounds);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(show).resolves.toBe(true);
    expect(manager.getActiveTabId()).toBe("tab-1");
    expect(logMocks.logWarn).toHaveBeenCalledWith(
      "portal.idle-release-no-verdict",
      expect.objectContaining({ tabId: "tab-1" })
    );
    manager.destroy();
  });

  it("logs a release that lands after its deadline once, however often it was asked", async () => {
    const { manager, parked } = await parkedBehindAnother();
    vi.setSystemTime(Date.now() + HOUR);
    void manager.releaseIdleTabs();
    await vi.advanceTimersByTimeAsync(60_000);
    vi.setSystemTime(Date.now() + HOUR);
    void manager.releaseIdleTabs();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(parked.close).toHaveBeenCalledTimes(2);

    emit(parked, "destroyed");

    const releases = logMocks.logInfo.mock.calls.filter(([e]) => e === "portal.idle-release");
    expect(releases).toEqual([
      ["portal.idle-release", expect.objectContaining({ tabId: "tab-1" })],
    ]);
    expect(sentOn(cachedView, "portal:tab-evicted")).toEqual([{ tabId: "tab-1" }]);
    manager.destroy();
  });

  it("doesn't log a user's close as an idle release after an unanswered one", async () => {
    const { manager, parked } = await parkedBehindAnother();
    vi.setSystemTime(Date.now() + HOUR);
    void manager.releaseIdleTabs();
    await vi.advanceTimersByTimeAsync(60_000);

    await manager.closeTab("tab-1");
    emit(parked, "destroyed");

    expect(logMocks.logInfo.mock.calls.some(([e]) => e === "portal.idle-release")).toBe(false);
    manager.destroy();
  });

  it("doesn't let a newer show be overtaken by one that waited out a release", async () => {
    const { manager, parked } = await parkedBehindAnother();
    vi.setSystemTime(Date.now() + HOUR);
    const release = manager.releaseIdleTabs();
    await vi.waitFor(() => expect(parked.close).toHaveBeenCalled());

    const waiting = manager.showTab("tab-1", bounds);
    await expect(manager.showTab("tab-2", bounds)).resolves.toBe(true);
    emit(parked, "will-prevent-unload");

    await expect(waiting).resolves.toBe(true);
    expect(manager.getActiveTabId()).toBe("tab-2");
    await release;
    manager.destroy();
  });

  it("brings the tab count back under the cap when refused releases held it over", async () => {
    const manager = new mod.PortalManager(mockWindow);
    for (let i = 1; i <= mod.PORTAL_MAX_LIVE_TABS; i++) {
      manager.createTab(`tab-${i}`, `http://localhost:${3000 + i}`);
    }
    vi.setSystemTime(Date.now() + HOUR);
    const release = manager.releaseIdleTabs();
    await vi.waitFor(() =>
      expect(createdWebContents.every((wc) => wc.close.mock.calls.length === 1)).toBe(true)
    );

    manager.createTab("tab-new", "http://localhost:4000");
    await manager.showTab("tab-new", bounds);
    expect(manager.hasTab("tab-1")).toBe(true);

    for (const wc of createdWebContents.slice(0, mod.PORTAL_MAX_LIVE_TABS)) {
      emit(wc, "will-prevent-unload");
    }
    await release;

    const live = ["tab-1", "tab-2", "tab-3", "tab-new"].filter((id) => manager.hasTab(id));
    expect(live).toHaveLength(mod.PORTAL_MAX_LIVE_TABS);
    expect(live).toContain("tab-new");
    manager.destroy();
  });

  it("checks the exemptions again after the storage flush", async () => {
    const { manager, parked } = await parkedBehindAnother();
    let finishFlush!: () => void;
    parked.session.flushStorageData.mockReturnValue(
      new Promise<void>((resolve) => (finishFlush = resolve))
    );
    vi.setSystemTime(Date.now() + HOUR);

    const release = manager.releaseIdleTabs();
    parked.isCurrentlyAudible.mockReturnValue(true);
    finishFlush();

    await expect(release).resolves.toEqual([]);
    expect(parked.close).not.toHaveBeenCalled();
    manager.destroy();
  });

  it("runs no check timer unless a tab is hidden", async () => {
    const manager = new mod.PortalManager(mockWindow);
    manager.createTab("tab-1", "http://localhost:3001");
    expect(vi.getTimerCount()).toBe(1);

    await manager.showTab("tab-1", bounds);
    expect(vi.getTimerCount()).toBe(0);

    manager.hideAll();
    expect(vi.getTimerCount()).toBe(1);
    manager.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
