import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

type WebContentsCreatedListener = (event: unknown, contents: MockWebContents) => void;

interface MockWebContents {
  getType: () => string;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
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
  classifyPartition: vi.fn((partition: string) =>
    partition === "persist:daintree" ? "project" : "browser"
  ),
  getDaintreeAppCSP: vi.fn(() => "default-src 'self' /* daintree */"),
  getLocalhostDevCSP: vi.fn(() => "default-src 'self' /* browser */"),
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

// Real-ish flag values matter: the protocol handler passes
// `O_RDONLY | O_NOFOLLOW` to fs.open, and the test below asserts on the exact
// bitmask. With both flags mocked as 0, the OR collapses to 0 and the
// assertion succeeds whether or not O_NOFOLLOW is present in the source —
// silently disabling the TOCTOU regression guard. Match the values used in
// the sibling files:read test.
const fsPromisesMocks = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
  constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100 },
}));

vi.mock("fs/promises", () => ({
  default: fsPromisesMocks,
  ...fsPromisesMocks,
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
    storeOAuthSessionStorage: vi.fn(),
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

import {
  registerDaintreeFileProtocol,
  registerProtocolsForSession,
  setupWebviewCSP,
} from "../protocols.js";
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
    executeJavaScript: vi.fn().mockResolvedValue([]),
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
    it("captures OAuth sessionStorage before offering the loopback flow", async () => {
      const storeOAuthSessionStorage = vi.fn();
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-42"),
        storeOAuthSessionStorage,
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      contents.executeJavaScript.mockResolvedValue([
        ["kc_code_verifier", "verifier-123"],
        ["kc_state", "state-123"],
      ]);
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(
        event,
        "https://oauth.provider.com/authorize?client_id=test&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback&code_challenge=abc123"
      );

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(storeOAuthSessionStorage).toHaveBeenCalledTimes(1);
      expect(storeOAuthSessionStorage).toHaveBeenCalledWith("panel-42", expect.any(Promise));
      await expect(storeOAuthSessionStorage.mock.calls[0][1]).resolves.toEqual([
        ["kc_code_verifier", "verifier-123"],
        ["kc_state", "state-123"],
      ]);
      expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
    });

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
        canOpenExternal: true,
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
        canOpenExternal: true,
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
      mockFromWebContents.mockReturnValue(mockMainWindow);
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-browser-1"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);
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

describe("setupWebviewCSP — partition CSP wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webContentsCreatedListeners.length = 0;
  });

  it("registers CSP on persist:browser and persist:daintree", async () => {
    const { session } = await import("electron");
    const fromPartition = vi.mocked(session.fromPartition);

    setupWebviewCSP();

    const partitions = fromPartition.mock.calls.map((call) => call[0]);
    expect(partitions).toContain("persist:browser");
    expect(partitions).toContain("persist:daintree");
  });

  it("uses the daintree app CSP for persist:daintree (and skips localhost dev CSP for browser)", async () => {
    const { getDaintreeAppCSP, getLocalhostDevCSP } = await import("../../utils/webviewCsp.js");
    const daintreeCspMock = vi.mocked(getDaintreeAppCSP);
    const localhostCspMock = vi.mocked(getLocalhostDevCSP);

    setupWebviewCSP();

    expect(daintreeCspMock).toHaveBeenCalledTimes(1);
    expect(localhostCspMock).not.toHaveBeenCalled();
  });

  it("passes isDev=false to getDaintreeAppCSP when NODE_ENV is not 'development'", async () => {
    const { getDaintreeAppCSP } = await import("../../utils/webviewCsp.js");
    const daintreeCspMock = vi.mocked(getDaintreeAppCSP);
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      setupWebviewCSP();
      expect(daintreeCspMock).toHaveBeenCalledWith(false);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("passes isDev=true to getDaintreeAppCSP when NODE_ENV is 'development'", async () => {
    const { getDaintreeAppCSP } = await import("../../utils/webviewCsp.js");
    const daintreeCspMock = vi.mocked(getDaintreeAppCSP);
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      setupWebviewCSP();
      expect(daintreeCspMock).toHaveBeenCalledWith(true);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("attaches an onHeadersReceived listener for persist:daintree only (browser is excluded)", async () => {
    const { session } = await import("electron");
    const fromPartition = vi.mocked(session.fromPartition);
    const onHeadersReceivedRegistrations: string[] = [];
    fromPartition.mockImplementation((partition: string) => {
      const onHeadersReceived = vi.fn(() => {
        onHeadersReceivedRegistrations.push(partition);
      });
      return {
        webRequest: { onHeadersReceived },
      } as unknown as Electron.Session;
    });

    setupWebviewCSP();

    expect(onHeadersReceivedRegistrations).toEqual(["persist:daintree"]);
  });

  it("invokes the callback with the daintree CSP string for the persist:daintree session", async () => {
    const { session } = await import("electron");
    const fromPartition = vi.mocked(session.fromPartition);
    const callbacksByPartition = new Map<
      string,
      (details: unknown, callback: (response: unknown) => void) => void
    >();
    fromPartition.mockImplementation((partition: string) => {
      const onHeadersReceived = vi.fn((listener) => {
        callbacksByPartition.set(partition, listener);
      });
      return {
        webRequest: { onHeadersReceived },
      } as unknown as Electron.Session;
    });

    setupWebviewCSP();

    const daintreeListener = callbacksByPartition.get("persist:daintree");
    expect(daintreeListener).toBeDefined();
    expect(callbacksByPartition.has("persist:browser")).toBe(false);

    let daintreeResponse: { responseHeaders?: Record<string, string[]> } | undefined;
    daintreeListener!({ responseHeaders: {} }, (response: unknown) => {
      daintreeResponse = response as typeof daintreeResponse;
    });

    expect(daintreeResponse?.responseHeaders?.["Content-Security-Policy"]?.[0]).toContain(
      "/* daintree */"
    );
  });
});

describe("protocol registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers app and daintree-file protocols on per-project sessions", async () => {
    const handle = vi.fn();
    const mockSession = { protocol: { handle } } as unknown as Electron.Session;

    registerProtocolsForSession(mockSession, "/tmp/dist");

    expect(handle).toHaveBeenCalledTimes(2);
    expect(handle).toHaveBeenCalledWith("app", expect.any(Function));
    expect(handle).toHaveBeenCalledWith("daintree-file", expect.any(Function));
  });

  it("registers the default-session daintree-file protocol", async () => {
    const { protocol } = await import("electron");

    registerDaintreeFileProtocol();

    expect(protocol.handle).toHaveBeenCalledWith("daintree-file", expect.any(Function));
  });
});

describe("createDaintreeFileProtocolHandler — symlink containment", () => {
  type ProtocolHandler = (request: GlobalRequest) => Promise<Response>;

  async function captureHandler(scheme: "daintree-file"): Promise<ProtocolHandler> {
    const handle = vi.fn();
    const mockSession = { protocol: { handle } } as unknown as Electron.Session;
    registerProtocolsForSession(mockSession, "/tmp/dist");
    const call = handle.mock.calls.find((c) => c[0] === scheme);
    if (!call) throw new Error(`handler for ${scheme} not registered`);
    return call[1] as ProtocolHandler;
  }

  function makeRequest(filePath: string, rootPath: string): GlobalRequest {
    const url = new URL("daintree-file://serve");
    url.searchParams.set("path", filePath);
    url.searchParams.set("root", rootPath);
    return new Request(url.toString()) as GlobalRequest;
  }

  function makeFileHandle(content: string | Buffer = "data") {
    const buffer = typeof content === "string" ? Buffer.from(content) : content;
    return {
      readFile: vi.fn().mockResolvedValue(buffer),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import("fs/promises");
    vi.mocked(fs.stat).mockResolvedValue({ size: 4 } as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle() as unknown as Awaited<ReturnType<typeof fs.open>>
    );
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("text/plain");
  });

  it("serves a normal file inside root and opens the user-supplied path with O_NOFOLLOW", async () => {
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    realpath.mockImplementation((p) => Promise.resolve(p as string));

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/src/index.ts", "/project"));

    expect(response.status).toBe(200);
    // Stat is performed on the realpath-resolved file for accurate size.
    expect(fs.stat).toHaveBeenCalledWith("/project/src/index.ts");
    // open() must be called on the user-supplied (normalized) path with O_NOFOLLOW
    // — this is the TOCTOU defense that net.fetch did not provide.
    expect(fs.open).toHaveBeenCalledTimes(1);
    const openArgs = vi.mocked(fs.open).mock.calls[0];
    expect(openArgs[0]).toBe("/project/src/index.ts");
    expect(openArgs[1]).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  });

  it("emits the hardened response header set on success", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 7 } as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle("hello\n!") as unknown as Awaited<ReturnType<typeof fs.open>>
    );

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/src/index.ts", "/project"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("Content-Length")).toBe("7");
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
    // Must be cross-origin: app:// renderer and daintree-file:// are different schemes/sites.
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("uses the read buffer length for Content-Length, not the pre-read stat.size", async () => {
    // If the file changes between stat() and readFile(), Content-Length must
    // reflect what was actually returned in the body — using stat.size would
    // declare a stale length that mismatches the response body.
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 4 } as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle("hello world") as unknown as Awaited<ReturnType<typeof fs.open>>
    );

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/src/index.ts", "/project"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String("hello world".length));
  });

  it("rejects oversize files with 413 before opening the file (size cap parity with files:read)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 512 * 1024 + 1 } as Awaited<
      ReturnType<typeof fs.stat>
    >);

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/big.bin", "/project"));

    expect(response.status).toBe(413);
    expect(fs.open).not.toHaveBeenCalled();
    // Error responses still carry the security header set.
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves a file at exactly the size limit (cap is exclusive)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 512 * 1024 } as Awaited<
      ReturnType<typeof fs.stat>
    >);

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/edge.bin", "/project"));

    expect(response.status).toBe(200);
    expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when O_NOFOLLOW rejects a final-component symlink with ELOOP (TOCTOU)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    const eloop = Object.assign(new Error("ELOOP"), { code: "ELOOP" });
    vi.mocked(fs.open).mockRejectedValue(eloop);

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/sneaky", "/project"));

    expect(response.status).toBe(404);
  });

  it("returns 404 when the file vanishes between realpath and open (ENOENT)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(fs.open).mockRejectedValue(enoent);

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/missing", "/project"));

    expect(response.status).toBe(404);
  });

  it("closes the file handle even when readFile fails", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    const handle = {
      readFile: vi.fn().mockRejectedValue(new Error("EIO")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(fs.open).mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>);

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/broken", "/project"));

    expect(response.status).toBe(500);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("returns 200 when close() rejects after a successful read (close errors are swallowed)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    const handle = {
      readFile: vi.fn().mockResolvedValue(Buffer.from("ok")),
      close: vi.fn().mockRejectedValue(new Error("EBADF")),
    };
    vi.mocked(fs.open).mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>);

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/ok", "/project"));

    expect(response.status).toBe(200);
  });

  it("blocks a symlink whose path is inside root but whose target is outside root", async () => {
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    realpath.mockImplementation((p) => {
      if (p === "/project") return Promise.resolve("/project");
      if (p === "/project/escape") return Promise.resolve("/etc/passwd");
      return Promise.resolve(p as string);
    });

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/escape", "/project"));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("returns 404 for a dangling symlink (ENOENT)", async () => {
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    realpath.mockImplementation((p) => {
      if (p === "/project") return Promise.resolve("/project");
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Promise.reject(err);
    });

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/dangling", "/project"));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("returns 404 for a symlink loop (ELOOP)", async () => {
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    realpath.mockImplementation((p) => {
      if (p === "/project") return Promise.resolve("/project");
      const err = Object.assign(new Error("ELOOP"), { code: "ELOOP" });
      return Promise.reject(err);
    });

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/loop", "/project"));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("returns 404 when the root itself fails to resolve (EACCES)", async () => {
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    realpath.mockImplementation(() => {
      const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
      return Promise.reject(err);
    });

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/file.txt", "/project"));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("blocks a Windows cross-drive escape where path.relative returns an absolute path", async () => {
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    realpath.mockImplementation((p) => {
      if (p === "/project") return Promise.resolve("/project");
      // Simulate a symlink resolving to a path with a leading slash that path.relative
      // treats as absolute relative to the root — same shape as Windows cross-drive escape
      // (path.relative('D:\\project', 'C:\\windows') === 'C:\\windows').
      if (p === "/project/winlink") return Promise.resolve("/totally/elsewhere");
      return Promise.resolve(p as string);
    });

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/winlink", "/project"));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("permits a symlink whose resolved target stays inside root", async () => {
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    realpath.mockImplementation((p) => {
      if (p === "/project") return Promise.resolve("/project");
      if (p === "/project/link") return Promise.resolve("/project/real/file.txt");
      return Promise.resolve(p as string);
    });

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/link", "/project"));

    expect(response.status).toBe(200);
    // stat reads the resolved real path (for accurate size); open uses the
    // user-supplied normalized path so O_NOFOLLOW catches a final-component swap.
    expect(fs.stat).toHaveBeenCalledWith("/project/real/file.txt");
    expect(vi.mocked(fs.open).mock.calls[0][0]).toBe("/project/link");
  });

  it("returns 400 (not 404) for missing parameters — input validation precedes realpath", async () => {
    const handler = await captureHandler("daintree-file");
    const url = new URL("daintree-file://serve");
    const response = await handler(new Request(url.toString()) as GlobalRequest);

    expect(response.status).toBe(400);
    // 4xx error responses still carry the security headers.
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 405 with security headers for non-GET/HEAD methods", async () => {
    const handler = await captureHandler("daintree-file");
    const url = new URL("daintree-file://serve");
    url.searchParams.set("path", "/project/x");
    url.searchParams.set("root", "/project");
    const response = await handler(
      new Request(url.toString(), { method: "POST" }) as GlobalRequest
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
  });

  it("permits files whose name starts with '..' but isn't parent traversal", async () => {
    // Regression for the bare startsWith('..') guard — '..hidden/file.txt' is a
    // legitimate in-root path and must not be misclassified as escape.
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    realpath.mockImplementation((p) => Promise.resolve(p as string));

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/..hidden/file.txt", "/project"));

    expect(response.status).toBe(200);
    expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it("blocks a prefix-sibling escape (root=/tmp/project, target=/tmp/project-evil/...)", async () => {
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    realpath.mockImplementation((p) => Promise.resolve(p as string));

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/tmp/project-evil/secret.env", "/tmp/project"));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("blocks via the path.isAbsolute(rel) branch (Windows cross-drive simulation)", async () => {
    // Force path.relative to return an absolute path, isolating the isAbsolute guard
    // from the '..' branch. This is the shape of path.relative on Windows when root
    // and target are on different drives (e.g. relative('D:\\proj','C:\\win')==='C:\\win').
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    realpath.mockImplementation((p) => Promise.resolve(p as string));
    const relativeSpy = vi.spyOn(path, "relative").mockReturnValue("/absolute/elsewhere");

    try {
      const handler = await captureHandler("daintree-file");
      const response = await handler(makeRequest("/project/file.txt", "/project"));

      expect(response.status).toBe(404);
      expect(fs.open).not.toHaveBeenCalled();
    } finally {
      relativeSpy.mockRestore();
    }
  });
});
