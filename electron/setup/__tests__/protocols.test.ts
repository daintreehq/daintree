import { describe, it, expect, vi, beforeEach } from "vitest";

type WebContentsCreatedListener = (event: unknown, contents: MockWebContents) => void;

interface MockWebContents {
  getType: () => string;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  id: number;
}

const webContentsCreatedListeners: WebContentsCreatedListener[] = [];

vi.mock("electron", () => ({
  app: {
    on: vi.fn((event: string, listener: WebContentsCreatedListener) => {
      if (event === "web-contents-created") {
        webContentsCreatedListeners.push(listener);
      }
    }),
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

const mockCanOpenExternalUrl = vi.fn<(url: string) => boolean>(() => false);

vi.mock("../../utils/openExternal.js", () => ({
  canOpenExternalUrl: (url: string) => mockCanOpenExternalUrl(url),
  openExternalUrl: vi.fn(),
}));

vi.mock("../../utils/appProtocol.js", () => ({
  resolveAppUrlToDistPath: vi.fn(),
  getMimeType: vi.fn(),
  buildHeaders: vi.fn(),
}));

const mockGetPanelId = vi.fn<(id: number) => string | undefined>(() => undefined);

vi.mock("../../services/WebviewDialogService.js", () => ({
  getWebviewDialogService: vi.fn(() => ({
    registerDialog: vi.fn(),
    getPanelId: mockGetPanelId,
  })),
}));

const mockMainWindowSend = vi.fn();
const mockMainWindow = {
  isDestroyed: () => false,
  webContents: { send: mockMainWindowSend },
};

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
    mockCanOpenExternalUrl.mockReturnValue(false);
    mockGetPanelId.mockReturnValue(undefined);
    mockMainWindowSend.mockClear();
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

  describe("blocked navigation notification", () => {
    it("sends WEBVIEW_NAVIGATION_BLOCKED for blocked http/https URLs", () => {
      mockCanOpenExternalUrl.mockReturnValue(true);
      mockGetPanelId.mockReturnValue("panel-123");
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://auth.example.com/authorize");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockMainWindowSend).toHaveBeenCalledWith("webview:navigation-blocked", {
        panelId: "panel-123",
        url: "https://auth.example.com/authorize",
      });
    });

    it("sends notification for blocked redirects", () => {
      mockCanOpenExternalUrl.mockReturnValue(true);
      mockGetPanelId.mockReturnValue("panel-456");
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-redirect")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://accounts.google.com/o/oauth2/auth");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockMainWindowSend).toHaveBeenCalledWith("webview:navigation-blocked", {
        panelId: "panel-456",
        url: "https://accounts.google.com/o/oauth2/auth",
      });
    });

    it("does not send notification for non-web URLs (javascript:, data:, etc.)", () => {
      mockGetPanelId.mockReturnValue("panel-789");
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "javascript:alert(1)");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockMainWindowSend).not.toHaveBeenCalledWith(
        "webview:navigation-blocked",
        expect.anything()
      );
    });

    it("does not send notification when panelId is not registered", () => {
      mockGetPanelId.mockReturnValue(undefined);
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://example.com");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockMainWindowSend).not.toHaveBeenCalledWith(
        "webview:navigation-blocked",
        expect.anything()
      );
    });
  });
});
