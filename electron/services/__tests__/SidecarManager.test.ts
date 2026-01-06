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
});

vi.mock("electron", () => {
  class MockWebContentsView {
    webContents = createMockWebContents();
    setBounds = vi.fn();
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

vi.mock("../ClipboardFileInjector.js", () => ({
  ClipboardFileInjector: {
    hasFileDataInClipboard: vi.fn().mockReturnValue(false),
    getFilePathsFromClipboard: vi.fn().mockResolvedValue([]),
    injectFileIntoPaste: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("SidecarManager", () => {
  let SidecarManagerClass: typeof import("../SidecarManager.js").SidecarManager;
  let mockWindow: InstanceType<typeof import("electron").BrowserWindow>;

  beforeEach(async () => {
    vi.resetModules();

    const electron = await import("electron");
    mockWindow = new electron.BrowserWindow() as InstanceType<typeof electron.BrowserWindow>;

    const module = await import("../SidecarManager.js");
    SidecarManagerClass = module.SidecarManager;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("createTab()", () => {
    it("creates a new tab with valid http URL", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-1", "http://localhost:3000");

      expect(manager.hasTab("tab-1")).toBe(true);
    });

    it("creates a new tab with valid https URL", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-2", "https://example.com");

      expect(manager.hasTab("tab-2")).toBe(true);
    });

    it("rejects invalid URL protocol (file:)", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-3", "file:///etc/passwd");

      expect(manager.hasTab("tab-3")).toBe(false);
    });

    it("rejects invalid URL protocol (javascript:)", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-4", "javascript:alert(1)");

      expect(manager.hasTab("tab-4")).toBe(false);
    });

    it("rejects invalid URL protocol (ftp:)", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-5", "ftp://example.com");

      expect(manager.hasTab("tab-5")).toBe(false);
    });

    it("rejects malformed URLs", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-6", "not-a-valid-url");

      expect(manager.hasTab("tab-6")).toBe(false);
    });

    it("does not create duplicate tabs with same ID", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-dup", "http://localhost:3000");
      manager.createTab("tab-dup", "http://localhost:4000");

      expect(manager.hasTab("tab-dup")).toBe(true);
    });

    it("rejects data: URLs", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-data", "data:text/html,<h1>Test</h1>");

      expect(manager.hasTab("tab-data")).toBe(false);
    });
  });

  describe("showTab()", () => {
    it("shows an existing tab with valid bounds", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-show", "http://localhost:3000");
      manager.showTab("tab-show", { x: 100, y: 100, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-show");
      expect(mockWindow.contentView.addChildView).toHaveBeenCalled();
    });

    it("does nothing for non-existent tab", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.showTab("non-existent", { x: 0, y: 0, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBeNull();
    });

    it("switches from one tab to another", () => {
      const manager = new SidecarManagerClass(mockWindow);

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
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-bounds-neg", "http://localhost:3000");
      manager.showTab("tab-bounds-neg", { x: -100, y: -50, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-bounds-neg");
    });

    it("validates and normalizes invalid width/height", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-bounds-small", "http://localhost:3000");
      manager.showTab("tab-bounds-small", { x: 0, y: 0, width: 10, height: 10 });

      expect(manager.getActiveTabId()).toBe("tab-bounds-small");
    });

    it("handles NaN values in bounds", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-bounds-nan", "http://localhost:3000");
      manager.showTab("tab-bounds-nan", { x: NaN, y: NaN, width: NaN, height: NaN });

      expect(manager.getActiveTabId()).toBe("tab-bounds-nan");
    });

    it("handles Infinity values in bounds", () => {
      const manager = new SidecarManagerClass(mockWindow);

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
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-hide", "http://localhost:3000");
      manager.showTab("tab-hide", { x: 0, y: 0, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-hide");

      manager.hideAll();

      expect(manager.getActiveTabId()).toBeNull();
      expect(mockWindow.contentView.removeChildView).toHaveBeenCalled();
    });

    it("is safe to call when no tab is active", () => {
      const manager = new SidecarManagerClass(mockWindow);

      expect(() => manager.hideAll()).not.toThrow();
      expect(manager.getActiveTabId()).toBeNull();
    });
  });

  describe("updateBounds()", () => {
    it("updates bounds of active view", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-update-bounds", "http://localhost:3000");
      manager.showTab("tab-update-bounds", { x: 0, y: 0, width: 800, height: 600 });

      manager.updateBounds({ x: 50, y: 50, width: 1000, height: 800 });

      expect(manager.getActiveTabId()).toBe("tab-update-bounds");
    });

    it("does nothing when no active view", () => {
      const manager = new SidecarManagerClass(mockWindow);

      expect(() => manager.updateBounds({ x: 0, y: 0, width: 800, height: 600 })).not.toThrow();
    });
  });

  describe("closeTab()", () => {
    it("closes an existing tab", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-close", "http://localhost:3000");
      expect(manager.hasTab("tab-close")).toBe(true);

      manager.closeTab("tab-close");
      expect(manager.hasTab("tab-close")).toBe(false);
    });

    it("clears active tab if closing active", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-close-active", "http://localhost:3000");
      manager.showTab("tab-close-active", { x: 0, y: 0, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-close-active");

      manager.closeTab("tab-close-active");

      expect(manager.getActiveTabId()).toBeNull();
      expect(manager.hasTab("tab-close-active")).toBe(false);
    });

    it("does nothing for non-existent tab", () => {
      const manager = new SidecarManagerClass(mockWindow);

      expect(() => manager.closeTab("non-existent")).not.toThrow();
    });
  });

  describe("navigate()", () => {
    it("navigates to valid http URL", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-nav", "http://localhost:3000");
      manager.navigate("tab-nav", "http://localhost:4000");

      expect(manager.hasTab("tab-nav")).toBe(true);
    });

    it("navigates to valid https URL", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-nav-https", "http://localhost:3000");
      manager.navigate("tab-nav-https", "https://example.com");

      expect(manager.hasTab("tab-nav-https")).toBe(true);
    });

    it("rejects navigation to invalid protocol", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-nav-invalid", "http://localhost:3000");

      // Should not throw, just log error
      expect(() => manager.navigate("tab-nav-invalid", "file:///etc/passwd")).not.toThrow();
    });

    it("rejects navigation to javascript: URL", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-nav-js", "http://localhost:3000");

      expect(() => manager.navigate("tab-nav-js", "javascript:alert(1)")).not.toThrow();
    });

    it("does nothing for non-existent tab", () => {
      const manager = new SidecarManagerClass(mockWindow);

      expect(() => manager.navigate("non-existent", "http://localhost:3000")).not.toThrow();
    });
  });

  describe("goBack() / goForward()", () => {
    it("returns false when cannot go back", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-back", "http://localhost:3000");

      expect(manager.goBack("tab-back")).toBe(false);
    });

    it("returns false when cannot go forward", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-forward", "http://localhost:3000");

      expect(manager.goForward("tab-forward")).toBe(false);
    });

    it("returns false for non-existent tab", () => {
      const manager = new SidecarManagerClass(mockWindow);

      expect(manager.goBack("non-existent")).toBe(false);
      expect(manager.goForward("non-existent")).toBe(false);
    });
  });

  describe("reload()", () => {
    it("reloads an existing tab", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-reload", "http://localhost:3000");

      expect(() => manager.reload("tab-reload")).not.toThrow();
    });

    it("does nothing for non-existent tab", () => {
      const manager = new SidecarManagerClass(mockWindow);

      expect(() => manager.reload("non-existent")).not.toThrow();
    });
  });

  describe("hasTab()", () => {
    it("returns true for existing tab", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-has", "http://localhost:3000");

      expect(manager.hasTab("tab-has")).toBe(true);
    });

    it("returns false for non-existent tab", () => {
      const manager = new SidecarManagerClass(mockWindow);

      expect(manager.hasTab("non-existent")).toBe(false);
    });
  });

  describe("getActiveTabId()", () => {
    it("returns null when no tab is active", () => {
      const manager = new SidecarManagerClass(mockWindow);

      expect(manager.getActiveTabId()).toBeNull();
    });

    it("returns active tab ID when a tab is shown", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-active", "http://localhost:3000");
      manager.showTab("tab-active", { x: 0, y: 0, width: 800, height: 600 });

      expect(manager.getActiveTabId()).toBe("tab-active");
    });
  });

  describe("destroy()", () => {
    it("destroys all tabs and clears state", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-d1", "http://localhost:3000");
      manager.createTab("tab-d2", "http://localhost:4000");
      manager.showTab("tab-d1", { x: 0, y: 0, width: 800, height: 600 });

      manager.destroy();

      expect(manager.hasTab("tab-d1")).toBe(false);
      expect(manager.hasTab("tab-d2")).toBe(false);
      expect(manager.getActiveTabId()).toBeNull();
    });

    it("is safe to call multiple times", () => {
      const manager = new SidecarManagerClass(mockWindow);

      manager.createTab("tab-multi-destroy", "http://localhost:3000");

      expect(() => {
        manager.destroy();
        manager.destroy();
      }).not.toThrow();
    });
  });
});

describe("SidecarManager URL validation", () => {
  let SidecarManagerClass: typeof import("../SidecarManager.js").SidecarManager;
  let mockWindow: InstanceType<typeof import("electron").BrowserWindow>;

  beforeEach(async () => {
    vi.resetModules();

    const electron = await import("electron");
    mockWindow = new electron.BrowserWindow() as InstanceType<typeof electron.BrowserWindow>;

    const module = await import("../SidecarManager.js");
    SidecarManagerClass = module.SidecarManager;
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
      const manager = new SidecarManagerClass(mockWindow);
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
      const manager = new SidecarManagerClass(mockWindow);
      const tabId = `tab-valid-${url.replace(/[^a-z0-9]/gi, "")}`;
      manager.createTab(tabId, url);
      expect(manager.hasTab(tabId)).toBe(true);
    });
  }
});
