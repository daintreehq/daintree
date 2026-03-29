import { describe, it, expect, vi, beforeEach } from "vitest";

type WebContentsCreatedListener = (event: unknown, contents: MockWebContents) => void;

interface MockWebContents {
  getType: () => string;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  id: number;
}

const webContentsCreatedListeners: WebContentsCreatedListener[] = [];

const mockFromWebContents = vi.hoisted(() => vi.fn<() => unknown>(() => null));
vi.mock("electron", () => ({
  app: {
    on: vi.fn((event: string, listener: WebContentsCreatedListener) => {
      if (event === "web-contents-created") {
        webContentsCreatedListeners.push(listener);
      }
    }),
  },
  BrowserWindow: {
    fromWebContents: mockFromWebContents,
  },
  protocol: {
    handle: vi.fn(),
  },
  net: {
    fetch: vi.fn(),
  },
  session: {
    fromPartition: vi.fn(() => ({
      webRequest: {
        onHeadersReceived: vi.fn(),
      },
    })),
  },
}));

vi.mock("../../utils/webviewCsp.js", () => ({
  classifyPartition: vi.fn(() => "browser"),
  getLocalhostDevCSP: vi.fn(() => "default-src 'self'"),
  mergeCspHeaders: vi.fn((_details: unknown, csp: string) => ({
    "Content-Security-Policy": [csp],
  })),
  isDevPreviewPartition: vi.fn(() => false),
}));

vi.mock("../../utils/openExternal.js", () => ({
  canOpenExternalUrl: vi.fn((url: string) => {
    try {
      const protocol = new URL(url.trim()).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }),
  openExternalUrl: vi.fn(),
}));

vi.mock("../../utils/appProtocol.js", () => ({
  resolveAppUrlToDistPath: vi.fn(),
  getMimeType: vi.fn(),
  buildHeaders: vi.fn(),
}));

const mockSend = vi.fn();
const mockMainWindow = {
  isDestroyed: () => false,
  webContents: { send: mockSend },
};

vi.mock("../../services/WebviewDialogService.js", () => ({
  getWebviewDialogService: vi.fn(() => ({
    registerDialog: vi.fn(),
    getPanelId: vi.fn(() => "panel-browser-1"),
  })),
}));

vi.mock("../../window/windowRef.js", () => ({
  getMainWindow: vi.fn(() => mockMainWindow),
}));


vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: {
    WEBVIEW_FIND_SHORTCUT: "webview:find-shortcut",
    WEBVIEW_NAVIGATION_BLOCKED: "webview:navigation-blocked",
  },
}));

import { setupWebviewCSP } from "../protocols.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";

const mockedGetWebviewDialogService = vi.mocked(getWebviewDialogService);

function createMockWebContents(type: "webview" | "window" | "browserView"): MockWebContents {
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    getType: () => type,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    }),
    id: Math.floor(Math.random() * 1000),
    // expose for testing
    _eventHandlers: eventHandlers,
  } as unknown as MockWebContents & {
    _eventHandlers: Map<string, ((...args: unknown[]) => void)[]>;
  };
}

function getEventHandlers(
  contents: MockWebContents,
  eventName: string
): ((...args: unknown[]) => void)[] {
  return (contents.on as ReturnType<typeof vi.fn>).mock.calls
    .filter((call) => call[0] === eventName)
    .map((call) => call[1] as (...args: unknown[]) => void);
}

describe("setupWebviewCSP — webview guest navigation restriction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webContentsCreatedListeners.length = 0;
  });

  function simulateWebContentsCreated(contents: MockWebContents) {
    setupWebviewCSP();
    const listener = webContentsCreatedListeners[webContentsCreatedListeners.length - 1];
    listener({}, contents);
  }

  describe("will-navigate handler", () => {
    it("is registered on webview guest contents", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handlers = getEventHandlers(contents, "will-navigate");
      expect(handlers.length).toBe(1);
    });

    it("allows navigation to http://localhost:3000/dashboard", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "http://localhost:3000/dashboard");

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("allows navigation to http://127.0.0.1:8080/", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "http://127.0.0.1:8080/");

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("blocks navigation to https://example.com", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://example.com");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("allows https://localhost:3000", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://localhost:3000/secure");

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("blocks navigation to file:///etc/passwd", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "file:///etc/passwd");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["javascript:alert(1)", "javascript: scheme"],
      ["data:text/html,<h1>XSS</h1>", "data: scheme"],
      ["about:blank", "about:blank"],
      ["", "empty string"],
    ])("blocks %s (%s)", (url) => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, url);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("logs blocked navigations", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://evil.com");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Blocked webview navigation to non-localhost URL: https://evil.com")
      );
      warnSpy.mockRestore();
    });
  });

  describe("will-redirect handler", () => {
    it("allows localhost redirects", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-redirect")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "http://localhost:4000/callback");

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("blocks non-localhost redirects", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-redirect")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://external-oauth.com/authorize");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("logs blocked redirects", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-redirect")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://external-oauth.com/authorize");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Blocked webview redirect to non-localhost URL: https://external-oauth.com/authorize"
        )
      );
      warnSpy.mockRestore();
    });
  });

  describe("js-dialog routing via BrowserWindow.fromWebContents", () => {
    it("sends dialog request to the parent window resolved from hostWebContents", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(() => "panel-1"),
        getPanelId: vi.fn(),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const jsDialogHandlers = getEventHandlers(contents, "js-dialog");
      expect(jsDialogHandlers.length).toBe(1);

      const mockEvent = { preventDefault: vi.fn() };
      const mockCallback = vi.fn();
      jsDialogHandlers[0](
        mockEvent,
        "http://localhost:3000",
        "Test message",
        "confirm",
        "",
        mockCallback
      );

      expect(mockSend).toHaveBeenCalledWith(
        "webview:dialog-request",
        expect.objectContaining({
          panelId: "panel-1",
          type: "confirm",
          message: "Test message",
        })
      );
    });

    it("resolves dialog when no parent window is found", () => {
      mockFromWebContents.mockReturnValue(null);
      const mockResolveDialog = vi.fn();
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(() => "panel-1"),
        getPanelId: vi.fn(),
        resolveDialog: mockResolveDialog,
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const jsDialogHandlers = getEventHandlers(contents, "js-dialog");
      const mockEvent = { preventDefault: vi.fn() };
      const mockCallback = vi.fn();
      jsDialogHandlers[0](mockEvent, "http://localhost:3000", "Alert", "alert", "", mockCallback);

      expect(mockResolveDialog).toHaveBeenCalledWith(expect.any(String), true);
    });

    it("sends find shortcut to the parent window resolved from hostWebContents", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-1"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const beforeInputHandlers = getEventHandlers(contents, "before-input-event");
      expect(beforeInputHandlers.length).toBe(1);

      const mockEvent = { preventDefault: vi.fn() };
      beforeInputHandlers[0](mockEvent, {
        type: "keyDown",
        key: "f",
        meta: true,
        control: true,
        alt: false,
        shift: false,
      });

      expect(mockSend).toHaveBeenCalledWith("webview:find-shortcut", {
        panelId: "panel-1",
        shortcut: "find",
      });
    });
  });

  describe("navigation-blocked IPC routing", () => {
    it("sends navigation-blocked to parent when will-navigate blocks a non-localhost URL", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-42"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://oauth.provider.com/authorize");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("webview:navigation-blocked", {
        panelId: "panel-42",
        url: "https://oauth.provider.com/authorize",
      });
    });

    it("sends navigation-blocked to parent when will-redirect blocks a non-localhost URL", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-7"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-redirect")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://external-oauth.com/callback");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("webview:navigation-blocked", {
        panelId: "panel-7",
        url: "https://external-oauth.com/callback",
      });
    });

    it("does not send IPC when panelId is not registered", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => undefined),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://example.com");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("does not crash when parent window is destroyed", () => {
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => true,
        webContents: { send: vi.fn() },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-1"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };

      expect(() => handler(event, "https://example.com")).not.toThrow();
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("does not send IPC for localhost URLs", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });

      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "http://localhost:3000/page");

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("non-webview contents", () => {
    it("does not register will-navigate on non-webview contents", () => {
      const contents = createMockWebContents("window");
      simulateWebContentsCreated(contents);

      const handlers = getEventHandlers(contents, "will-navigate");
      expect(handlers.length).toBe(0);
    });

    it("does not register will-redirect on non-webview contents", () => {
      const contents = createMockWebContents("browserView");
      simulateWebContentsCreated(contents);

      const handlers = getEventHandlers(contents, "will-redirect");
      expect(handlers.length).toBe(0);
    });
  });

  describe("blocked navigation IPC notification", () => {
    beforeEach(() => {
      mockSend.mockClear();
    });

    it("sends navigation-blocked IPC when cross-origin navigation is blocked", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://accounts.google.com/oauth");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("webview:navigation-blocked", {
        panelId: "panel-browser-1",
        url: "https://accounts.google.com/oauth",
        canOpenExternal: true,
      });
    });

    it("sends navigation-blocked IPC when cross-origin redirect is blocked", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-redirect")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://auth.provider.com/callback");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("webview:navigation-blocked", {
        panelId: "panel-browser-1",
        url: "https://auth.provider.com/callback",
        canOpenExternal: true,
      });
    });

    it("does not send navigation-blocked IPC for localhost navigations", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "http://localhost:3000/dashboard");

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("sends canOpenExternal false for javascript: URLs", () => {
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "javascript:alert(1)");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("webview:navigation-blocked", {
        panelId: "panel-browser-1",
        url: "javascript:alert(1)",
        canOpenExternal: false,
      });
    });

    it("does not send navigation-blocked IPC when panelId is not found", async () => {
      const mod = await import("../../services/WebviewDialogService.js");
      vi.mocked(mod.getWebviewDialogService).mockReturnValueOnce({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => undefined),
      } as never);

      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://example.com");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
