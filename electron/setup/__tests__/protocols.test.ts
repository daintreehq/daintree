import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import { Readable } from "node:stream";

type WebContentsCreatedListener = (event: unknown, contents: MockWebContents) => void;

interface MockWebContents {
  getType: () => string;
  isDestroyed: () => boolean;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
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

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
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
  isImmutableAppAsset: vi.fn(() => false),
  isNotModified: vi.fn(() => false),
  toHttpDate: vi.fn((date: Date) => date.toUTCString()),
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
  readFile: vi.fn(),
  constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x4 },
}));

vi.mock("fs/promises", () => ({
  default: fsPromisesMocks,
  ...fsPromisesMocks,
}));

const nodeFsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn<(...args: unknown[]) => string>(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
}));

vi.mock("node:fs", () => ({
  default: nodeFsMocks,
  ...nodeFsMocks,
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
    getPanelKind: vi.fn(() => "dev-preview"),
    cancelPendingForGuest: vi.fn(),
    storeOAuthSessionStorage: vi.fn(),
  })),
}));

vi.mock("../../window/windowRef.js", () => ({
  getMainWindow: vi.fn(() => mockMainWindow),
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: {
    WEBVIEW_FIND_SHORTCUT: "webview:find-shortcut",
    WEBVIEW_RELOAD_SHORTCUT: "webview:reload-shortcut",
    WEBVIEW_CLOSE_SHORTCUT: "webview:close-shortcut",
    WEBVIEW_NAVIGATION_BLOCKED: "webview:navigation-blocked",
    WEBVIEW_DIALOG_DISMISS: "webview:dialog-dismiss",
  },
}));

import {
  applyDaintreeAppCspToSession,
  createPluginProtocolHandler,
  registerAppProtocol,
  registerDaintreeFileProtocol,
  registerDaintreePdfProtocol,
  registerPluginProtocol,
  registerProtocolsForSession,
  setPluginDirResolver,
  setupWebviewCSP,
} from "../protocols.js";
import { mintHtmlPreviewToken, _resetHtmlPreviewTokensForTests } from "../htmlPreviewTokens.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";

const mockedGetWebviewDialogService = vi.mocked(getWebviewDialogService);

function createMockWebContents(type: "webview" | "window" | "browserView"): MockWebContents {
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const record = (event: string, handler: (...args: unknown[]) => void) => {
    const handlers = eventHandlers.get(event) ?? [];
    handlers.push(handler);
    eventHandlers.set(event, handlers);
  };
  return {
    getType: () => type,
    isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(record),
    once: vi.fn(record),
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
  // Reads both .on and .once registrations (both record into _eventHandlers).
  return (
    (
      contents as unknown as { _eventHandlers: Map<string, ((...args: unknown[]) => void)[]> }
    )._eventHandlers.get(eventName) ?? []
  );
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

    it("sends reload shortcut (Cmd/Ctrl+R) to the parent window and prevents default (#9497)", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-1"),
        getPanelKind: vi.fn(() => "dev-preview"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const beforeInputHandlers = getEventHandlers(contents, "before-input-event");
      const mockEvent = { preventDefault: vi.fn() };
      beforeInputHandlers[0](mockEvent, {
        type: "keyDown",
        key: "r",
        meta: true,
        control: true,
        alt: false,
        shift: false,
      });

      expect(mockEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("webview:reload-shortcut", {
        panelId: "panel-1",
      });
    });

    it("does not swallow Cmd/Ctrl+R for non-dev-preview webviews like browser panels (#9497)", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-browser-1"),
        getPanelKind: vi.fn(() => "browser"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const beforeInputHandlers = getEventHandlers(contents, "before-input-event");
      const mockEvent = { preventDefault: vi.fn() };
      beforeInputHandlers[0](mockEvent, {
        type: "keyDown",
        key: "r",
        meta: true,
        control: true,
        alt: false,
        shift: false,
      });

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalledWith("webview:reload-shortcut", expect.anything());
    });

    it("ignores Cmd/Ctrl+Shift+R so it does not shadow other reload variants (#9497)", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-1"),
        getPanelKind: vi.fn(() => "dev-preview"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const beforeInputHandlers = getEventHandlers(contents, "before-input-event");
      const mockEvent = { preventDefault: vi.fn() };
      beforeInputHandlers[0](mockEvent, {
        type: "keyDown",
        key: "r",
        meta: true,
        control: true,
        alt: false,
        shift: true,
      });

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalledWith("webview:reload-shortcut", expect.anything());
    });

    it("sends close shortcut (Cmd/Ctrl+W) to the parent window and prevents default for dev-preview webviews (#10859)", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-1"),
        getPanelKind: vi.fn(() => "dev-preview"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const beforeInputHandlers = getEventHandlers(contents, "before-input-event");
      const mockEvent = { preventDefault: vi.fn() };
      // The close chord is platform-specific: Cmd+W on macOS, Ctrl+W
      // elsewhere. Match the runtime platform so this passes on both the dev
      // machine (macOS) and CI (Linux).
      const isMac = process.platform === "darwin";
      beforeInputHandlers[0](mockEvent, {
        type: "keyDown",
        key: "w",
        meta: isMac,
        control: !isMac,
        alt: false,
        shift: false,
      });

      expect(mockEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("webview:close-shortcut", {
        panelId: "panel-1",
      });
    });

    it("also sends close shortcut (Cmd/Ctrl+W) for non-dev-preview webviews like browser panels — unlike reload, no panel-kind gate applies (#10859)", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-browser-1"),
        getPanelKind: vi.fn(() => "browser"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const beforeInputHandlers = getEventHandlers(contents, "before-input-event");
      const mockEvent = { preventDefault: vi.fn() };
      const isMac = process.platform === "darwin";
      beforeInputHandlers[0](mockEvent, {
        type: "keyDown",
        key: "w",
        meta: isMac,
        control: !isMac,
        alt: false,
        shift: false,
      });

      expect(mockEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("webview:close-shortcut", {
        panelId: "panel-browser-1",
      });
    });

    it("ignores Cmd/Ctrl+Shift+W so it does not shadow other shortcuts (#10859)", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-1"),
        getPanelKind: vi.fn(() => "dev-preview"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const beforeInputHandlers = getEventHandlers(contents, "before-input-event");
      const mockEvent = { preventDefault: vi.fn() };
      const isMac = process.platform === "darwin";
      beforeInputHandlers[0](mockEvent, {
        type: "keyDown",
        key: "w",
        meta: isMac,
        control: !isMac,
        alt: false,
        shift: true,
      });

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalledWith("webview:close-shortcut", expect.anything());
    });

    it("ignores Cmd+Ctrl+W — the opposite-platform modifier disqualifies the close chord (#10859)", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-1"),
        getPanelKind: vi.fn(() => "dev-preview"),
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      const beforeInputHandlers = getEventHandlers(contents, "before-input-event");
      const mockEvent = { preventDefault: vi.fn() };
      // Both modifiers held is always disqualified: on macOS the extra Ctrl
      // voids the Cmd+W chord, and on Linux/Windows the extra Cmd voids the
      // Ctrl+W chord — so this is rejected on every platform.
      beforeInputHandlers[0](mockEvent, {
        type: "keyDown",
        key: "w",
        meta: true,
        control: true,
        alt: false,
        shift: false,
      });

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalledWith("webview:close-shortcut", expect.anything());
    });
  });

  describe("dialog dismissal on navigation, crash, and destroy (#9943)", () => {
    function setupGuestWithDialogService(): {
      contents: MockWebContents;
      cancelPendingForGuest: ReturnType<typeof vi.fn>;
      mockSend: ReturnType<typeof vi.fn>;
    } {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      const cancelPendingForGuest = vi.fn();
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => "panel-1"),
        cancelPendingForGuest,
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);
      return { contents, cancelPendingForGuest, mockSend };
    }

    it("registers did-navigate, render-process-gone, and destroyed handlers on the guest", () => {
      const { contents } = setupGuestWithDialogService();
      expect(getEventHandlers(contents, "did-navigate").length).toBe(1);
      expect(getEventHandlers(contents, "render-process-gone").length).toBe(1);
      expect(getEventHandlers(contents, "destroyed").length).toBe(1);
    });

    it("cancels pending dialogs and notifies the renderer on did-navigate", () => {
      const { contents, cancelPendingForGuest, mockSend } = setupGuestWithDialogService();
      getEventHandlers(contents, "did-navigate")[0]({}, "http://localhost:3000/next", 200, "OK");

      expect(cancelPendingForGuest).toHaveBeenCalledWith(contents.id);
      expect(mockSend).toHaveBeenCalledWith("webview:dialog-dismiss", { panelId: "panel-1" });
    });

    it("cancels pending dialogs and notifies the renderer on render-process-gone", () => {
      const { contents, cancelPendingForGuest, mockSend } = setupGuestWithDialogService();
      getEventHandlers(contents, "render-process-gone")[0]({}, { reason: "crashed" });

      expect(cancelPendingForGuest).toHaveBeenCalledWith(contents.id);
      expect(mockSend).toHaveBeenCalledWith("webview:dialog-dismiss", { panelId: "panel-1" });
    });

    it("dismisses on destroyed using the cached parent window after hostWebContents is gone", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      const cancelPendingForGuest = vi.fn();
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(() => "panel-1"),
        getPanelId: vi.fn(() => "panel-1"),
        cancelPendingForGuest,
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      // A dialog is shown while the guest is alive — this caches the parent window.
      const jsDialogHandlers = getEventHandlers(contents, "js-dialog");
      jsDialogHandlers[0](
        { preventDefault: vi.fn() },
        "http://localhost:3000",
        "msg",
        "alert",
        "",
        vi.fn()
      );

      // The guest is then destroyed: hostWebContents is unreachable and the live
      // lookup returns null, so the destroy handler must fall back to the cached
      // window captured during the guest's lifetime.
      (contents as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;
      mockFromWebContents.mockReturnValue(null);
      mockSend.mockClear();

      getEventHandlers(contents, "destroyed")[0]();

      expect(cancelPendingForGuest).toHaveBeenCalledWith(contents.id);
      expect(mockSend).toHaveBeenCalledWith("webview:dialog-dismiss", { panelId: "panel-1" });
    });

    it("does not notify the renderer when no panel is registered for the guest", () => {
      const mockSend = vi.fn();
      mockFromWebContents.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: mockSend },
      });
      const cancelPendingForGuest = vi.fn();
      mockedGetWebviewDialogService.mockReturnValue({
        registerDialog: vi.fn(),
        getPanelId: vi.fn(() => undefined),
        cancelPendingForGuest,
      } as unknown as ReturnType<typeof getWebviewDialogService>);

      const contents = createMockWebContents("webview");
      (contents as unknown as { hostWebContents: unknown }).hostWebContents = { id: 99 };
      simulateWebContentsCreated(contents);

      getEventHandlers(contents, "did-navigate")[0]({}, "http://localhost:3000/next", 200, "OK");

      // Callbacks are still cancelled main-side, but no stale dismiss is broadcast.
      expect(cancelPendingForGuest).toHaveBeenCalledWith(contents.id);
      expect(mockSend).not.toHaveBeenCalledWith("webview:dialog-dismiss", expect.anything());
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

  describe("browser-panel navigation (per-project partition)", () => {
    function createBrowserWebContents(partition: string): MockWebContents {
      const contents = createMockWebContents("webview");
      (contents as unknown as { session: { partition: string } }).session = { partition };
      return contents;
    }

    it("allows cross-origin navigation for a per-project browser partition", () => {
      const contents = createBrowserWebContents("persist:browser-proj-a");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://github.com/login");

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("still blocks unsafe URLs for a browser partition", () => {
      const contents = createBrowserWebContents("persist:browser-proj-a");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "javascript:alert(1)");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("treats distinct per-project browser partitions independently as browser panels", () => {
      const contentsB = createBrowserWebContents("persist:browser-proj-b");
      simulateWebContentsCreated(contentsB);

      const handler = getEventHandlers(contentsB, "will-redirect")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://accounts.google.com/oauth");

      // Browser partitions allow cross-origin http/https (OAuth flows), unlike
      // dev-preview which is localhost-only.
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("restricts a dev-preview partition to localhost (cross-origin blocked)", () => {
      const contents = createBrowserWebContents("persist:dev-preview-proj-a-main-panel");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      handler(event, "https://github.com/login");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("safely treats a webview with no resolvable session partition as non-browser", () => {
      // contents.session is absent on the mock; the optional-chaining guard must
      // not throw and must fall back to the restrictive (localhost-only) path.
      const contents = createMockWebContents("webview");
      simulateWebContentsCreated(contents);

      const handler = getEventHandlers(contents, "will-navigate")[0];
      const event = { preventDefault: vi.fn() };
      expect(() => handler(event, "https://github.com/login")).not.toThrow();
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });
  });
});

describe("setupWebviewCSP — partition CSP wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webContentsCreatedListeners.length = 0;
  });

  it("registers CSP on persist:daintree and does not eagerly open a browser session", async () => {
    const { session } = await import("electron");
    const fromPartition = vi.mocked(session.fromPartition);

    setupWebviewCSP();

    const partitions = fromPartition.mock.calls.map((call) => call[0]);
    expect(partitions).toContain("persist:daintree");
    // Browser sessions are per-project and created lazily; setup no longer opens a
    // singleton persist:browser session for identity comparison (#9965).
    expect(partitions).not.toContain("persist:browser");
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

  it("passes daintree-html:// preview responses through without overwriting their CSP (#11191)", async () => {
    const { session } = await import("electron");
    const { mergeCspHeaders } = await import("../../utils/webviewCsp.js");
    const fromPartition = vi.mocked(session.fromPartition);
    vi.mocked(mergeCspHeaders).mockClear();

    let captured:
      | ((details: unknown, callback: (r: { responseHeaders?: unknown }) => void) => void)
      | undefined;
    fromPartition.mockImplementation((partition: string) => {
      const onHeadersReceived = vi.fn(
        (
          _filter: unknown,
          listener: (details: unknown, callback: (r: { responseHeaders?: unknown }) => void) => void
        ) => {
          if (partition === "persist:daintree") captured = listener;
        }
      );
      return { webRequest: { onHeadersReceived } } as unknown as Electron.Session;
    });

    setupWebviewCSP();
    expect(captured).toBeDefined();

    // A daintree-html preview iframe already carries its own token-scoped CSP;
    // the app overlay must NOT replace it (that would break the sandboxed page's
    // scripts and re-expose connect-src daintree-file:).
    const previewHeaders = {
      "Content-Security-Policy": ["sandbox allow-scripts; default-src 'none'"],
    };
    let previewResult: { responseHeaders?: unknown } | undefined;
    captured!({ url: "daintree-html://tok/index.html", responseHeaders: previewHeaders }, (r) => {
      previewResult = r;
    });
    expect(previewResult?.responseHeaders).toBe(previewHeaders);
    expect(vi.mocked(mergeCspHeaders)).not.toHaveBeenCalled();

    // A normal app response still gets the app CSP overlay applied.
    captured!({ url: "app://daintree/index.html", responseHeaders: {} }, () => {});
    expect(vi.mocked(mergeCspHeaders)).toHaveBeenCalledTimes(1);
  });

  it("passes daintree-pdf:// responses through without stamping a CSP on them (#11427)", async () => {
    const { session } = await import("electron");
    const { mergeCspHeaders } = await import("../../utils/webviewCsp.js");
    const fromPartition = vi.mocked(session.fromPartition);
    vi.mocked(mergeCspHeaders).mockClear();

    let captured:
      | ((details: unknown, callback: (r: { responseHeaders?: unknown }) => void) => void)
      | undefined;
    fromPartition.mockImplementation((partition: string) => {
      const onHeadersReceived = vi.fn(
        (
          _filter: unknown,
          listener: (details: unknown, callback: (r: { responseHeaders?: unknown }) => void) => void
        ) => {
          if (partition === "persist:daintree") captured = listener;
        }
      );
      return { webRequest: { onHeadersReceived } } as unknown as Electron.Session;
    });

    setupWebviewCSP();
    expect(captured).toBeDefined();

    // A PDF document must reach PDFium carrying NO CSP: the app policy's
    // frame-src omits chrome-extension:, so overlaying it would block the
    // viewer frame PDFium installs inside the document.
    const pdfHeaders = { "Content-Type": ["application/pdf"] };
    let pdfResult: { responseHeaders?: unknown } | undefined;
    captured!(
      { url: "daintree-pdf://load?path=%2Frepo%2Fa.pdf", responseHeaders: pdfHeaders },
      (r) => {
        pdfResult = r;
      }
    );
    expect(pdfResult?.responseHeaders).toBe(pdfHeaders);
    expect(vi.mocked(mergeCspHeaders)).not.toHaveBeenCalled();

    // A normal app response still gets the overlay, so the bypass is scoped.
    captured!({ url: "app://daintree/index.html", responseHeaders: {} }, () => {});
    expect(vi.mocked(mergeCspHeaders)).toHaveBeenCalledTimes(1);
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
    const filtersByPartition = new Map<string, Electron.WebRequestFilter>();
    fromPartition.mockImplementation((partition: string) => {
      const onHeadersReceived = vi.fn((filter, listener) => {
        filtersByPartition.set(partition, filter);
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

    // Electron 41+ treats an empty `urls` array as matching nothing, so an
    // empty registration would silently strip header-only CSP directives.
    const daintreeFilter = filtersByPartition.get("persist:daintree");
    expect(daintreeFilter?.urls.length).toBeGreaterThan(0);
    expect(daintreeFilter?.types).toContain("mainFrame");
    expect(daintreeFilter?.types).toContain("script");

    let daintreeResponse: { responseHeaders?: Record<string, string[]> } | undefined;
    daintreeListener!({ responseHeaders: {} }, (response: unknown) => {
      daintreeResponse = response as typeof daintreeResponse;
    });

    expect(daintreeResponse?.responseHeaders?.["Content-Security-Policy"]?.[0]).toContain(
      "/* daintree */"
    );
  });
});

describe("setupWebviewCSP — host import-map hash sidecar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webContentsCreatedListeners.length = 0;
    // Reset default: sidecar absent unless a test overrides.
    nodeFsMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  it("threads scriptSrcHashes from importmap-meta.json into the daintree CSP in production", async () => {
    const { getDaintreeAppCSP } = await import("../../utils/webviewCsp.js");
    const daintreeCspMock = vi.mocked(getDaintreeAppCSP);
    nodeFsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ scriptSrcHashes: ["'sha256-abc123'"] })
    );
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      registerAppProtocol("/tmp/dist");
      setupWebviewCSP();
      expect(daintreeCspMock).toHaveBeenCalledWith(false, {
        scriptSrcHashes: ["'sha256-abc123'"],
      });
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("reads importmap-meta.json from the cached dist path", () => {
    nodeFsMocks.readFileSync.mockReturnValue(JSON.stringify({ scriptSrcHashes: ["'sha256-xyz'"] }));
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      registerAppProtocol("/custom/dist");
      setupWebviewCSP();
      expect(nodeFsMocks.readFileSync).toHaveBeenCalledWith(
        path.join("/custom/dist", "importmap-meta.json"),
        "utf8"
      );
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("falls back to a single-arg CSP call when the sidecar is missing", async () => {
    const { getDaintreeAppCSP } = await import("../../utils/webviewCsp.js");
    const daintreeCspMock = vi.mocked(getDaintreeAppCSP);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      registerAppProtocol("/tmp/dist");
      setupWebviewCSP();
      expect(daintreeCspMock).toHaveBeenCalledWith(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load importmap-meta.json sidecar"),
        expect.anything()
      );
    } finally {
      process.env.NODE_ENV = original;
      warnSpy.mockRestore();
    }
  });

  it("falls back when sidecar JSON is malformed", async () => {
    const { getDaintreeAppCSP } = await import("../../utils/webviewCsp.js");
    const daintreeCspMock = vi.mocked(getDaintreeAppCSP);
    nodeFsMocks.readFileSync.mockReturnValue("not valid json");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      registerAppProtocol("/tmp/dist");
      setupWebviewCSP();
      expect(daintreeCspMock).toHaveBeenCalledWith(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = original;
      warnSpy.mockRestore();
    }
  });

  it("falls back when sidecar JSON is missing scriptSrcHashes array", async () => {
    const { getDaintreeAppCSP } = await import("../../utils/webviewCsp.js");
    const daintreeCspMock = vi.mocked(getDaintreeAppCSP);
    nodeFsMocks.readFileSync.mockReturnValue(JSON.stringify({ other: "value" }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      registerAppProtocol("/tmp/dist");
      setupWebviewCSP();
      expect(daintreeCspMock).toHaveBeenCalledWith(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("malformed; missing scriptSrcHashes array")
      );
    } finally {
      process.env.NODE_ENV = original;
      warnSpy.mockRestore();
    }
  });

  it("skips sidecar read entirely in development", async () => {
    const { getDaintreeAppCSP } = await import("../../utils/webviewCsp.js");
    const daintreeCspMock = vi.mocked(getDaintreeAppCSP);
    nodeFsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ scriptSrcHashes: ["'sha256-should-not-load'"] })
    );
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      registerAppProtocol("/tmp/dist");
      setupWebviewCSP();
      expect(nodeFsMocks.readFileSync).not.toHaveBeenCalled();
      expect(daintreeCspMock).toHaveBeenCalledWith(true);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("filters non-string entries out of scriptSrcHashes", async () => {
    const { getDaintreeAppCSP } = await import("../../utils/webviewCsp.js");
    const daintreeCspMock = vi.mocked(getDaintreeAppCSP);
    nodeFsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ scriptSrcHashes: ["'sha256-good'", 42, null, "'sha256-also-good'"] })
    );
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      registerAppProtocol("/tmp/dist");
      setupWebviewCSP();
      expect(daintreeCspMock).toHaveBeenCalledWith(false, {
        scriptSrcHashes: ["'sha256-good'", "'sha256-also-good'"],
      });
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe("protocol registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers app and daintree-file protocols on per-project sessions when no plugin resolver is cached", async () => {
    const handle = vi.fn();
    const mockSession = { protocol: { handle } } as unknown as Electron.Session;

    registerProtocolsForSession(mockSession, "/tmp/dist");

    // plugin:// is skipped here — registerPluginProtocol hasn't been called yet
    // in this test. Production order is the opposite: registerPluginProtocol runs
    // in app.whenReady() before any per-project session is created.
    const schemes = handle.mock.calls.map((c) => c[0] as string);
    expect(new Set(schemes)).toEqual(
      new Set(["app", "daintree-file", "daintree-html", "daintree-pdf"])
    );
    // Each exactly once: a duplicate handle() for one scheme throws in Electron.
    expect(schemes).toHaveLength(new Set(schemes).size);
    expect(schemes).not.toContain("plugin");
    for (const scheme of schemes) {
      expect(handle).toHaveBeenCalledWith(scheme, expect.any(Function));
    }
  });

  it("also registers plugin:// on per-project sessions after the resolver is cached", async () => {
    registerPluginProtocol(() => undefined);

    const handle = vi.fn();
    const mockSession = { protocol: { handle } } as unknown as Electron.Session;

    registerProtocolsForSession(mockSession, "/tmp/dist");

    expect(handle).toHaveBeenCalledWith("plugin", expect.any(Function));
  });

  it("registers the default-session daintree-file protocol", async () => {
    const { protocol } = await import("electron");

    registerDaintreeFileProtocol();

    expect(protocol.handle).toHaveBeenCalledWith("daintree-file", expect.any(Function));
  });

  it("registers the default-session daintree-pdf protocol", async () => {
    const { protocol } = await import("electron");

    registerDaintreePdfProtocol();

    expect(protocol.handle).toHaveBeenCalledWith("daintree-pdf", expect.any(Function));
  });

  it("registers the default-session plugin protocol", async () => {
    const { protocol } = await import("electron");

    registerPluginProtocol(() => undefined);

    expect(protocol.handle).toHaveBeenCalledWith("plugin", expect.any(Function));
  });

  it("setPluginDirResolver swaps the live resolver for an already-registered handler (#10322)", async () => {
    const { protocol } = await import("electron");
    const fs = await import("fs/promises");
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.open).mockResolvedValue({
      readFile: vi.fn().mockResolvedValue(Buffer.from("data")),
      close: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ isFile: () => true, mtime: new Date() }),
    } as unknown as Awaited<ReturnType<typeof fs.open>>);
    vi.mocked(appProtocol.getMimeType).mockReturnValue("text/javascript");

    const PLUGIN_ROOT = path.resolve("/plugins/installed/live-plugin");

    // main.ts registers the handler before first paint with the placeholder
    // resolver — every request 404s while the heavy PluginService import is
    // still deferred.
    registerPluginProtocol(() => undefined);
    const call = vi.mocked(protocol.handle).mock.calls.find((c) => c[0] === "plugin");
    expect(call).toBeDefined();
    const handler = call![1] as (req: GlobalRequest) => Promise<Response>;

    const before = await handler(
      new Request("plugin://live-plugin/dist/index.js") as GlobalRequest
    );
    expect(before.status).toBe(404);

    // The deferred plugin-service task settles and swaps in the real resolver.
    setPluginDirResolver((id) => (id === "live-plugin" ? PLUGIN_ROOT : undefined));

    // The SAME handler instance now resolves — proving the swap reaches handlers
    // registered before init, not just ones created afterward. This guards the
    // frozen-capture regression: a handler that closed over the placeholder
    // directly would still 404 here.
    const after = await handler(new Request("plugin://live-plugin/dist/index.js") as GlobalRequest);
    expect(after.status).toBe(200);
  });

  it("setPluginDirResolver swap reaches a per-session handler wired before init (#10322)", async () => {
    const fs = await import("fs/promises");
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.open).mockResolvedValue({
      readFile: vi.fn().mockResolvedValue(Buffer.from("data")),
      close: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ isFile: () => true, mtime: new Date() }),
    } as unknown as Awaited<ReturnType<typeof fs.open>>);
    vi.mocked(appProtocol.getMimeType).mockReturnValue("text/javascript");

    const PLUGIN_ROOT = path.resolve("/plugins/installed/session-plugin");

    // Placeholder registered before first paint flips the gate true, so the
    // per-session handler is wired during createWindow → registerProtocolsForSession.
    registerPluginProtocol(() => undefined);

    const handle = vi.fn();
    const mockSession = { protocol: { handle } } as unknown as Electron.Session;
    registerProtocolsForSession(mockSession, "/tmp/dist");

    const call = handle.mock.calls.find((c) => c[0] === "plugin");
    expect(call).toBeDefined();
    const handler = call![1] as (req: GlobalRequest) => Promise<Response>;

    const before = await handler(
      new Request("plugin://session-plugin/dist/index.js") as GlobalRequest
    );
    expect(before.status).toBe(404);

    setPluginDirResolver((id) => (id === "session-plugin" ? PLUGIN_ROOT : undefined));

    // The per-session handler — created before the resolver existed — now serves
    // via the resolvePluginDir indirection, not just the default-session handler.
    const after = await handler(
      new Request("plugin://session-plugin/dist/index.js") as GlobalRequest
    );
    expect(after.status).toBe(200);
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
    expect(fs.stat).toHaveBeenCalledWith(path.normalize("/project/src/index.ts"));
    // open() must be called on the user-supplied (normalized) path with O_NOFOLLOW
    // — this is the TOCTOU defense that net.fetch did not provide.
    expect(fs.open).toHaveBeenCalledTimes(1);
    const openArgs = vi.mocked(fs.open).mock.calls[0];
    expect(openArgs[0]).toBe(path.normalize("/project/src/index.ts"));
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

  it("serves an image past the 512 KB text cap (images use the larger ceiling)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 5 * 1024 * 1024 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("image/png");

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/big.png", "/project"));

    // 5 MB would 413 under the text cap; an image is decoded as pixels, not a
    // giant string, so it clears the larger image ceiling and gets read.
    expect(response.status).toBe(200);
    expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["image/avif", "/project/big.avif"],
    ["image/apng", "/project/big.apng"],
  ])("extends the raster ceiling to %s", async (mimeType, filePath) => {
    // Both decode to pixels like every other raster format, so they belong on
    // the image ceiling — an animated APNG in particular passes 512 KB quickly.
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 5 * 1024 * 1024 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue(mimeType);

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest(filePath, "/project"));

    expect(response.status).toBe(200);
    expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it("still rejects an image beyond the image ceiling with 413", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 25 * 1024 * 1024 + 1 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("image/png");

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/huge.png", "/project"));

    expect(response.status).toBe(413);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("serves an image exactly at the image ceiling (cap is exclusive)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 25 * 1024 * 1024 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("image/png");

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/edge.png", "/project"));

    expect(response.status).toBe(200);
    expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it("does not extend the raster ceiling to SVG (kept at the text cap)", async () => {
    // SVG is served through the sanitizing files:read path in the viewer, so the
    // protocol deliberately keeps it at the tight cap — a 5 MB SVG still 413s.
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 5 * 1024 * 1024 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("image/svg+xml");

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/big.svg", "/project"));

    expect(response.status).toBe(413);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("rejects a file that grows past the cap between stat and read (413 after open)", async () => {
    // The pre-open stat is advisory; a writer can grow/swap the file before the
    // read. The post-read length check is the real ceiling — without it an
    // oversized buffer would reach the renderer and risk a decode OOM.
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 4 } as Awaited<ReturnType<typeof fs.stat>>);
    const oversized = Buffer.alloc(512 * 1024 + 1);
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle(oversized) as unknown as Awaited<ReturnType<typeof fs.open>>
    );

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/grew.bin", "/project"));

    expect(response.status).toBe(413);
    // The open/read did happen — this is the second, post-read guard, not the stat guard.
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
    const projectRoot = path.normalize("/project");
    const escapeIn = path.normalize("/project/escape");
    const escapeOut = path.normalize("/etc/passwd");
    realpath.mockImplementation((p) => {
      if (p === projectRoot) return Promise.resolve(projectRoot);
      if (p === escapeIn) return Promise.resolve(escapeOut);
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
    const projectRoot = path.normalize("/project");
    const winlink = path.normalize("/project/winlink");
    realpath.mockImplementation((p) => {
      if (p === projectRoot) return Promise.resolve(projectRoot);
      // Simulate a symlink resolving to a path with a leading slash that path.relative
      // treats as absolute relative to the root — same shape as Windows cross-drive escape
      // (path.relative('D:\\project', 'C:\\windows') === 'C:\\windows').
      if (p === winlink) {
        // On Windows we explicitly resolve to a different drive so path.relative
        // returns an absolute path. On POSIX we just pick an unrelated absolute path.
        const elsewhere =
          process.platform === "win32" ? "C:\\totally\\elsewhere" : "/totally/elsewhere";
        return Promise.resolve(elsewhere);
      }
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
    const projectRoot = path.normalize("/project");
    const link = path.normalize("/project/link");
    const realFile = path.normalize("/project/real/file.txt");
    realpath.mockImplementation((p) => {
      if (p === projectRoot) return Promise.resolve(projectRoot);
      if (p === link) return Promise.resolve(realFile);
      return Promise.resolve(p as string);
    });

    const handler = await captureHandler("daintree-file");
    const response = await handler(makeRequest("/project/link", "/project"));

    expect(response.status).toBe(200);
    // stat reads the resolved real path (for accurate size); open uses the
    // user-supplied normalized path so O_NOFOLLOW catches a final-component swap.
    expect(fs.stat).toHaveBeenCalledWith(realFile);
    expect(vi.mocked(fs.open).mock.calls[0][0]).toBe(link);
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

describe("createDaintreeFileProtocolHandler — video streaming (#11382)", () => {
  type ProtocolHandler = (request: GlobalRequest) => Promise<Response>;

  async function captureHandler(): Promise<ProtocolHandler> {
    const handle = vi.fn();
    const mockSession = { protocol: { handle } } as unknown as Electron.Session;
    registerProtocolsForSession(mockSession, "/tmp/dist");
    const call = handle.mock.calls.find((c) => c[0] === "daintree-file");
    if (!call) throw new Error("handler for daintree-file not registered");
    return call[1] as ProtocolHandler;
  }

  function makeVideoRequest(
    filePath: string,
    rootPath: string,
    init?: { method?: string; range?: string; origin?: string }
  ): GlobalRequest {
    const url = new URL("daintree-file://serve");
    url.searchParams.set("path", filePath);
    url.searchParams.set("root", rootPath);
    return new Request(url.toString(), {
      method: init?.method ?? "GET",
      headers: {
        ...(init?.range && { Range: init.range }),
        ...(init?.origin && { Origin: init.origin }),
      },
    }) as GlobalRequest;
  }

  const VIDEO_BYTES = Buffer.from("0123456789abcdef");

  function makeVideoHandle(
    content: Buffer = VIDEO_BYTES,
    { size = content.length, isFile = true } = {}
  ) {
    return {
      stat: vi.fn().mockResolvedValue({ size, isFile: () => isFile }),
      createReadStream: vi.fn(({ start, end }: { start: number; end: number }) =>
        Readable.from([content.subarray(start, Math.min(end + 1, content.length))])
      ),
      close: vi.fn().mockResolvedValue(undefined),
      // The buffered core's entry point — a video must never reach it.
      readFile: vi.fn(),
    };
  }

  function installHandle(handle: ReturnType<typeof makeVideoHandle>) {
    return import("fs/promises").then((fs) =>
      vi.mocked(fs.open).mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>)
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.open).mockResolvedValue(
      makeVideoHandle() as unknown as Awaited<ReturnType<typeof fs.open>>
    );
    // Pinned here rather than inherited: clearAllMocks keeps implementations,
    // so a stat left over from an earlier describe would silently decide the
    // buffered-fallback cases below.
    vi.mocked(fs.stat).mockResolvedValue({
      size: VIDEO_BYTES.length,
    } as Awaited<ReturnType<typeof fs.stat>>);
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("video/mp4");
  });

  it("streams a 200 with Accept-Ranges and no whole-file cap, bypassing the buffered core", async () => {
    // Far beyond both the 512 KB text cap and the 25 MB image ceiling — video
    // responses are backpressured streams, so no whole-file cap applies.
    const size = 600 * 1024 * 1024;
    const handle = makeVideoHandle(VIDEO_BYTES, { size });
    await installHandle(handle);

    const handler = await captureHandler();
    const response = await handler(makeVideoRequest("/project/clip.mp4", "/project"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(size));
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(handle.readFile).not.toHaveBeenCalled();
    expect(handle.createReadStream).toHaveBeenCalledWith({
      start: 0,
      end: size - 1,
      autoClose: true,
    });
  });

  describe("audio streaming (#11425)", () => {
    // Audio joined the streaming route because the buffered core caps normal
    // files at 512 KB — every real track would have 413'd before reaching the
    // renderer.
    it("streams an audio file far past the buffered cap instead of 413ing", async () => {
      const size = 8 * 1024 * 1024;
      const handle = makeVideoHandle(VIDEO_BYTES, { size });
      await installHandle(handle);
      const appProtocol = await import("../../utils/appProtocol.js");
      vi.mocked(appProtocol.getMimeType).mockReturnValue("audio/mpeg");

      const handler = await captureHandler();
      const response = await handler(makeVideoRequest("/project/track.mp3", "/project"));

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Length")).toBe(String(size));
      expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(response.headers.get("Accept-Ranges")).toBe("bytes");
      expect(handle.readFile).not.toHaveBeenCalled();
    });

    it("serves a ranged audio request from the same stream path", async () => {
      const appProtocol = await import("../../utils/appProtocol.js");
      vi.mocked(appProtocol.getMimeType).mockReturnValue("audio/flac");

      const handler = await captureHandler();
      const response = await handler(
        makeVideoRequest("/project/track.flac", "/project", { range: "bytes=4-9" })
      );

      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe(`bytes 4-9/${String(VIDEO_BYTES.length)}`);
      expect(await response.text()).toBe("456789");
    });

    it("routes an audio-suffixed alias of a non-media file through the buffered path", async () => {
      // On Windows O_NOFOLLOW is a no-op, so an in-root `track.mp3 → notes.txt`
      // symlink opens fine — classification must follow the canonical target so
      // the read stays capped instead of streaming uncapped under an audio MIME.
      const fs = await import("fs/promises");
      const appProtocol = await import("../../utils/appProtocol.js");
      const alias = path.normalize("/project/track.mp3");
      const target = path.normalize("/project/notes.txt");
      vi.mocked(fs.realpath).mockImplementation((p) =>
        Promise.resolve(p === alias ? target : (p as string))
      );
      vi.mocked(appProtocol.getMimeType).mockImplementation((p: string) =>
        p.endsWith(".mp3") ? "audio/mpeg" : "text/plain"
      );
      vi.mocked(fs.stat).mockResolvedValue({ size: 4 } as Awaited<ReturnType<typeof fs.stat>>);
      const bufferedHandle = {
        readFile: vi.fn().mockResolvedValue(Buffer.from("data")),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.open).mockResolvedValue(
        bufferedHandle as unknown as Awaited<ReturnType<typeof fs.open>>
      );

      const handler = await captureHandler();
      const response = await handler(makeVideoRequest("/project/track.mp3", "/project"));

      // A 200 with the canonical text MIME — not a 500 from an unconfigured
      // buffered handle, which would let this pass without proving anything.
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/plain");
      expect(response.headers.get("Accept-Ranges")).toBeNull();
      expect(bufferedHandle.readFile).toHaveBeenCalledTimes(1);
    });

    it("rejects an oversize audio alias of a text file with 413 before opening it", async () => {
      // The cap is the whole point of routing the alias back to the buffered
      // core; a size past it must be refused rather than read.
      const fs = await import("fs/promises");
      const appProtocol = await import("../../utils/appProtocol.js");
      const alias = path.normalize("/project/track.mp3");
      const target = path.normalize("/project/notes.txt");
      vi.mocked(fs.realpath).mockImplementation((p) =>
        Promise.resolve(p === alias ? target : (p as string))
      );
      vi.mocked(appProtocol.getMimeType).mockImplementation((p: string) =>
        p.endsWith(".mp3") ? "audio/mpeg" : "text/plain"
      );
      vi.mocked(fs.stat).mockResolvedValue({
        size: 5 * 1024 * 1024,
      } as Awaited<ReturnType<typeof fs.stat>>);
      const bufferedHandle = {
        readFile: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.open).mockResolvedValue(
        bufferedHandle as unknown as Awaited<ReturnType<typeof fs.open>>
      );

      const handler = await captureHandler();
      const response = await handler(makeVideoRequest("/project/track.mp3", "/project"));

      expect(response.status).toBe(413);
      expect(bufferedHandle.readFile).not.toHaveBeenCalled();
    });
  });

  describe("CORS gate (blob-URL playback fetch)", () => {
    // corsEnabled on the scheme only makes cross-origin fetch possible;
    // these pin the actual grant: ACAO echoed solely for the trusted app
    // origin, never for arbitrary web content in a browser panel.
    it("echoes Access-Control-Allow-Origin for the trusted app origin", async () => {
      const handler = await captureHandler();
      const response = await handler(
        makeVideoRequest("/project/clip.mp4", "/project", { origin: "app://daintree" })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("app://daintree");
    });

    it("omits the grant for a foreign origin", async () => {
      const handler = await captureHandler();
      const response = await handler(
        makeVideoRequest("/project/clip.mp4", "/project", { origin: "https://evil.example" })
      );

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("omits the grant when no Origin header is present", async () => {
      const handler = await captureHandler();
      const response = await handler(makeVideoRequest("/project/clip.mp4", "/project"));

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("carries the grant on error responses so fetch() can read the status", async () => {
      const handler = await captureHandler();
      const response = await handler(
        makeVideoRequest("/project/clip.mp4", "/project", {
          origin: "app://daintree",
          range: "bytes=99-",
        })
      );

      expect(response.status).toBe(416);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("app://daintree");
    });
  });

  it("opens with O_RDONLY | O_NOFOLLOW | O_NONBLOCK (FIFO-swap TOCTOU hardening)", async () => {
    const fs = await import("fs/promises");
    const handler = await captureHandler();
    await handler(makeVideoRequest("/project/clip.mp4", "/project"));

    expect(fs.open).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.open).mock.calls[0][1]).toBe(
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
  });

  it("rejects a non-regular file after the fd-level stat and closes the handle", async () => {
    // O_NOFOLLOW only blocks symlink swaps; a FIFO swapped in after the realpath
    // check passes the open, so the post-open fstat is the guard that catches it.
    const handle = makeVideoHandle(VIDEO_BYTES, { isFile: false });
    await installHandle(handle);

    const handler = await captureHandler();
    const response = await handler(makeVideoRequest("/project/clip.mp4", "/project"));

    expect(response.status).toBe(404);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.createReadStream).not.toHaveBeenCalled();
  });

  it("serves an exact 206 for an explicit byte range", async () => {
    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: "bytes=2-5" })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/16");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("2345");
  });

  it("clamps an open-ended range to EOF", async () => {
    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: "bytes=4-" })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 4-15/16");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("456789abcdef");
  });

  it("serves a suffix range (last N bytes)", async () => {
    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: "bytes=-4" })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 12-15/16");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("cdef");
  });

  it("clamps a past-EOF explicit end to EOF", async () => {
    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: "bytes=10-9999" })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 10-15/16");
  });

  it("serves an open-ended range on a huge file to EOF, never a shorter chunk", async () => {
    // Chromium's custom-scheme media loader is single-shot: a 206 that ends
    // before the requested range is treated as the whole resource and never
    // re-requested, so serving `bytes=N-` in bounded chunks truncates playback
    // at the first chunk. The full remainder must stream in one response.
    const size = 100 * 1024 * 1024;
    const handle = makeVideoHandle(VIDEO_BYTES, { size });
    await installHandle(handle);

    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: "bytes=4-" })
    );

    expect(response.status).toBe(206);
    expect(handle.createReadStream).toHaveBeenCalledWith({
      start: 4,
      end: size - 1,
      autoClose: true,
    });
    expect(response.headers.get("Content-Length")).toBe(String(size - 4));
    expect(response.headers.get("Content-Range")).toBe(`bytes 4-${size - 1}/${size}`);
  });

  it("serves an over-cap suffix range exactly (the tail carries mp4 moov metadata)", async () => {
    // Clamping a suffix from its start would drop EOF — the very bytes a
    // suffix request exists to fetch. Client-bounded forms are served whole.
    const size = 100 * 1024 * 1024;
    const suffix = 16 * 1024 * 1024;
    const handle = makeVideoHandle(VIDEO_BYTES, { size });
    await installHandle(handle);

    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: `bytes=-${suffix}` })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes ${size - suffix}-${size - 1}/${size}`
    );
    expect(response.headers.get("Content-Length")).toBe(String(suffix));
  });

  it("serves a large explicit range exactly (client-bounded, no clamp)", async () => {
    const size = 100 * 1024 * 1024;
    const end = 20 * 1024 * 1024 - 1;
    const handle = makeVideoHandle(VIDEO_BYTES, { size });
    await installHandle(handle);

    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: `bytes=0-${end}` })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-${end}/${size}`);
    expect(response.headers.get("Content-Length")).toBe(String(end + 1));
  });

  it("returns 416 for a start past the safe-integer range (necessarily past EOF)", async () => {
    // Ignoring it would serve the whole file for a range that names no real byte.
    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: "bytes=9007199254740992-" })
    );

    expect(response.status).toBe(416);
  });

  it("returns 416 for a zero-length suffix (bytes=-0 names no byte)", async () => {
    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: "bytes=-0" })
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */16");
  });

  it("returns 416 with Content-Range */size for an unsatisfiable range", async () => {
    const handle = makeVideoHandle();
    await installHandle(handle);

    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: "bytes=99-" })
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */16");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.createReadStream).not.toHaveBeenCalled();
  });

  it.each(["bytes=abc", "bytes=0-1,4-5", "items=0-4", "bytes=5-2"])(
    "ignores unsupported Range header %s and serves a full 200 (RFC 9110)",
    async (range) => {
      const handler = await captureHandler();
      const response = await handler(makeVideoRequest("/project/clip.mp4", "/project", { range }));

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Length")).toBe("16");
    }
  );

  it("answers HEAD with metadata and Accept-Ranges without opening a stream", async () => {
    // Chromium probes with HEAD before issuing ranged GETs.
    const handle = makeVideoHandle();
    await installHandle(handle);

    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { method: "HEAD" })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("16");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(handle.createReadStream).not.toHaveBeenCalled();
    expect(handle.readFile).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("HEAD ignores Range entirely (RFC 9110 defines range handling for GET only)", async () => {
    // Even an unsatisfiable Range must not turn HEAD into a 416.
    const handle = makeVideoHandle();
    await installHandle(handle);

    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { method: "HEAD", range: "bytes=99-" })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("16");
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("serves an empty video as an empty 200 without a stream", async () => {
    const handle = makeVideoHandle(Buffer.alloc(0));
    await installHandle(handle);

    const handler = await captureHandler();
    const response = await handler(makeVideoRequest("/project/clip.mp4", "/project"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("0");
    expect(handle.createReadStream).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("emits the hardened response header set on streamed responses", async () => {
    const handler = await captureHandler();
    const response = await handler(
      makeVideoRequest("/project/clip.mp4", "/project", { range: "bytes=0-3" })
    );

    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("applies realpath containment to video paths (out-of-root symlink → 404)", async () => {
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    const projectRoot = path.normalize("/project");
    const escapeIn = path.normalize("/project/escape.mp4");
    realpath.mockImplementation((p) => {
      if (p === projectRoot) return Promise.resolve(projectRoot);
      if (p === escapeIn) return Promise.resolve(path.normalize("/etc/evil.mp4"));
      return Promise.resolve(p as string);
    });

    const handler = await captureHandler();
    const response = await handler(makeVideoRequest("/project/escape.mp4", "/project"));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("returns 404 when the video open is rejected with ELOOP (symlink swap)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.open).mockRejectedValue(Object.assign(new Error("ELOOP"), { code: "ELOOP" }));

    const handler = await captureHandler();
    const response = await handler(makeVideoRequest("/project/clip.mp4", "/project"));

    expect(response.status).toBe(404);
  });

  it("routes a video-suffixed alias of a non-video through the buffered path", async () => {
    // On Windows O_NOFOLLOW is a no-op, so an in-root `clip.mp4 → notes.txt`
    // symlink opens fine — classification must follow the canonical target,
    // which lands this request on the capped buffered path with a text MIME.
    const fs = await import("fs/promises");
    const appProtocol = await import("../../utils/appProtocol.js");
    const alias = path.normalize("/project/clip.mp4");
    const target = path.normalize("/project/notes.txt");
    vi.mocked(fs.realpath).mockImplementation((p) =>
      Promise.resolve(p === alias ? target : (p as string))
    );
    vi.mocked(appProtocol.getMimeType).mockImplementation((p: string) =>
      p.endsWith(".mp4") ? "video/mp4" : "text/plain"
    );
    vi.mocked(fs.stat).mockResolvedValue({ size: 4 } as Awaited<ReturnType<typeof fs.stat>>);
    const bufferedHandle = {
      readFile: vi.fn().mockResolvedValue(Buffer.from("data")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(fs.open).mockResolvedValue(
      bufferedHandle as unknown as Awaited<ReturnType<typeof fs.open>>
    );

    const handler = await captureHandler();
    const response = await handler(makeVideoRequest("/project/clip.mp4", "/project"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    // Buffered semantics: the whole (capped) read, not a stream.
    expect(bufferedHandle.readFile).toHaveBeenCalledTimes(1);
  });
});

describe("createPluginProtocolHandler", () => {
  type ProtocolHandler = (request: GlobalRequest) => Promise<Response>;

  const PLUGIN_ROOT = path.resolve("/plugins/installed/my-plugin");
  const PLUGIN_MTIME = new Date("2024-01-02T03:04:05.000Z");

  function makeFileHandle(content: string | Buffer = "data", isFile = true) {
    const buffer = typeof content === "string" ? Buffer.from(content) : content;
    return {
      readFile: vi.fn().mockResolvedValue(buffer),
      close: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ isFile: () => isFile, mtime: PLUGIN_MTIME }),
    };
  }

  function buildHandler(
    overrides: { getPluginDir?: (id: string) => string | undefined } = {}
  ): ProtocolHandler {
    const getPluginDir =
      overrides.getPluginDir ?? ((id: string) => (id === "my-plugin" ? PLUGIN_ROOT : undefined));
    return createPluginProtocolHandler(getPluginDir);
  }

  function makeRequest(url: string, init?: RequestInit): GlobalRequest {
    return new Request(url, init) as GlobalRequest;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle() as unknown as Awaited<ReturnType<typeof fs.open>>
    );
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("text/javascript");
  });

  it("serves a normal asset inside the plugin root and opens with O_NOFOLLOW", async () => {
    const fs = await import("fs/promises");
    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/dist/index.js"));

    expect(response.status).toBe(200);
    // open() must use the user-derived candidate (not the realpath-resolved
    // path) with O_NOFOLLOW so a final-component symlink injected after
    // realpath is rejected with ELOOP.
    expect(fs.open).toHaveBeenCalledTimes(1);
    const openArgs = vi.mocked(fs.open).mock.calls[0];
    expect(openArgs[0]).toBe(path.join(PLUGIN_ROOT, "dist", "index.js"));
    expect(openArgs[1]).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  });

  it("resolves a view-generation namespace to the same file on disk (#11301)", async () => {
    const fs = await import("fs/promises");
    const handler = buildHandler();

    const first = await handler(makeRequest("plugin://my-plugin/__dtv-1/dist/index.js"));
    const second = await handler(makeRequest("plugin://my-plugin/__dtv-42/dist/index.js"));

    // Two specifiers V8 has never seen before, backed by identical bytes — that
    // is the entire mechanism by which an upgraded plugin's view actually loads.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const opened = vi.mocked(fs.open).mock.calls.map((c) => c[0]);
    expect(opened).toEqual([
      path.join(PLUGIN_ROOT, "dist", "index.js"),
      path.join(PLUGIN_ROOT, "dist", "index.js"),
    ]);
  });

  it("keeps a relative chunk inside its entry's generation namespace", async () => {
    const fs = await import("fs/promises");
    const handler = buildHandler();

    // `./chunk.js` resolved against `.../__dtv-3/dist/index.js` produces this.
    const response = await handler(makeRequest("plugin://my-plugin/__dtv-3/dist/chunk.js"));

    expect(response.status).toBe(200);
    expect(vi.mocked(fs.open).mock.calls[0]?.[0]).toBe(path.join(PLUGIN_ROOT, "dist", "chunk.js"));
  });

  it.each([
    "plugin://my-plugin/__dtv-/dist/index.js",
    "plugin://my-plugin/__dtv-abc/dist/index.js",
    "plugin://my-plugin/__dtv-7",
  ])("404s a malformed generation namespace (%s) instead of hitting disk", async (url) => {
    const fs = await import("fs/promises");
    const handler = buildHandler();

    const response = await handler(makeRequest(url));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("still contains encoded traversal that follows a generation namespace", async () => {
    const fs = await import("fs/promises");
    const handler = buildHandler();
    // Stripping the namespace must not hand an un-normalized remainder to the
    // resolver — `..` after the prefix stays subject to the same containment.
    await handler(makeRequest("plugin://my-plugin/__dtv-2/%2e%2e/%2e%2e/secret"));

    expect(vi.mocked(fs.open).mock.calls[0]?.[0]).toBe(path.join(PLUGIN_ROOT, "secret"));
  });

  it("emits the hardened response header set with cross-origin CORP", async () => {
    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/dist/index.js"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript");
    // CORP MUST be cross-origin (not same-origin like app://). Same-origin would
    // break COEP isolation when the plugin embedder eventually opts in.
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Permissions-Policy")).toBeTruthy();
    // No Cross-Origin-Embedder-Policy header on sub-resources (document sets it).
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBeNull();
  });

  it("emits Last-Modified on 200 responses so the V8 code cache can persist (#10395)", async () => {
    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/dist/index.js"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Last-Modified")).toBe(PLUGIN_MTIME.toUTCString());
  });

  it("returns 304 with validator headers when If-Modified-Since matches (#10395)", async () => {
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.isNotModified).mockReturnValueOnce(true);

    const handler = buildHandler();
    const response = await handler(
      makeRequest("plugin://my-plugin/dist/index.js", {
        headers: { "If-Modified-Since": PLUGIN_MTIME.toUTCString() },
      })
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("Last-Modified")).toBe(PLUGIN_MTIME.toUTCString());
    expect(vi.mocked(appProtocol.isNotModified)).toHaveBeenCalledWith(
      PLUGIN_MTIME.toUTCString(),
      PLUGIN_MTIME
    );
  });

  it("returns 404 when the opened path is a directory (no 304 short-circuit)", async () => {
    const fs = await import("fs/promises");
    const handle = makeFileHandle("data", false);
    vi.mocked(fs.open).mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>);

    const handler = buildHandler();
    const response = await handler(
      makeRequest("plugin://my-plugin/dist", {
        headers: { "If-Modified-Since": PLUGIN_MTIME.toUTCString() },
      })
    );

    expect(response.status).toBe(404);
    expect(handle.close).toHaveBeenCalled();
  });

  it("returns 404 for an unknown plugin id", async () => {
    const fs = await import("fs/promises");
    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://does-not-exist/anything.js"));

    expect(response.status).toBe(404);
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("returns 404 for a disabled plugin (getPluginDir returns undefined)", async () => {
    const fs = await import("fs/promises");
    const handler = buildHandler({ getPluginDir: () => undefined });
    const response = await handler(makeRequest("plugin://my-plugin/dist/index.js"));

    expect(response.status).toBe(404);
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("returns 404 for an empty hostname", async () => {
    const handler = buildHandler();
    // `plugin:///path` → URL parses hostname as "".
    const response = await handler(makeRequest("plugin:///dist/index.js"));

    expect(response.status).toBe(404);
  });

  it("returns 404 for a bare directory request (no path component)", async () => {
    const fs = await import("fs/promises");
    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/"));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("normalizes ../ segments so a traversal URL stays inside the plugin root", async () => {
    // `path.posix.normalize("/../../etc/passwd")` returns `/etc/passwd`, so the
    // resolved candidate is `${PLUGIN_ROOT}/etc/passwd` — never `/etc/passwd`
    // on the host. The leading-slash normalization is the defense; the segment
    // check below is belt-and-suspenders for vectors that bypass posix.normalize.
    const fs = await import("fs/promises");
    const handler = buildHandler();
    await handler(makeRequest("plugin://my-plugin/../../etc/passwd"));

    const openArgs = vi.mocked(fs.open).mock.calls[0];
    expect(openArgs?.[0]).toBe(path.join(PLUGIN_ROOT, "etc", "passwd"));
  });

  it("normalizes URL-encoded ../ segments after decode without escaping root", async () => {
    const fs = await import("fs/promises");
    const handler = buildHandler();
    // %2e%2e decodes to `..` — must be subject to the same containment as raw `..`.
    await handler(makeRequest("plugin://my-plugin/%2e%2e/secret"));

    const openArgs = vi.mocked(fs.open).mock.calls[0];
    // The path is normalized to plugin-root/secret — never reaches the parent dir.
    expect(openArgs?.[0]).toBe(path.join(PLUGIN_ROOT, "secret"));
  });

  it("rejects backslash separators in the pathname (Windows traversal vector)", async () => {
    const fs = await import("fs/promises");
    const handler = buildHandler();
    // Backslashes in URL paths are not valid posix separators; we reject them
    // outright so a path like `..\..\windows\system32` is never normalized as
    // a single segment that bypasses the `..` scan.
    const response = await handler(makeRequest("plugin://my-plugin/foo%5C..%5Cbar"));

    expect(response.status).toBe(404);
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("rejects null bytes in the path with 400", async () => {
    const handler = buildHandler();
    // %00 is a null byte after decode; must be rejected.
    const response = await handler(makeRequest("plugin://my-plugin/dist/index.js%00.html"));

    expect(response.status).toBe(400);
  });

  it("permits paths starting with '..' that aren't parent traversal", async () => {
    // Regression for the segment-vs-substring check (#4702): `..hidden/file.js`
    // is a legitimate in-root file and must not be misclassified.
    const fs = await import("fs/promises");
    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/..hidden/file.js"));

    expect(response.status).toBe(200);
    expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it("blocks a symlink whose target resolves outside the plugin root", async () => {
    const fs = await import("fs/promises");
    const realpath = vi.mocked(fs.realpath);
    const escapeIn = path.join(PLUGIN_ROOT, "escape");
    realpath.mockImplementation((p) => {
      if (p === PLUGIN_ROOT) return Promise.resolve(PLUGIN_ROOT);
      if (p === escapeIn) return Promise.resolve("/etc/passwd");
      return Promise.resolve(p as string);
    });

    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/escape"));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("returns 404 when O_NOFOLLOW rejects a final-component symlink with ELOOP (TOCTOU)", async () => {
    const fs = await import("fs/promises");
    const eloop = Object.assign(new Error("ELOOP"), { code: "ELOOP" });
    vi.mocked(fs.open).mockRejectedValue(eloop);

    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/maybe-symlink.js"));

    expect(response.status).toBe(404);
  });

  it("returns 404 when the file is missing (ENOENT from open)", async () => {
    const fs = await import("fs/promises");
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(fs.open).mockRejectedValue(enoent);

    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/missing.js"));

    expect(response.status).toBe(404);
  });

  it("returns 404 when the target is a directory (EISDIR from open)", async () => {
    const fs = await import("fs/promises");
    const eisdir = Object.assign(new Error("EISDIR"), { code: "EISDIR" });
    vi.mocked(fs.open).mockRejectedValue(eisdir);

    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/somedir"));

    expect(response.status).toBe(404);
  });

  it("returns 405 with security headers for non-GET/HEAD methods", async () => {
    const handler = buildHandler();
    const response = await handler(
      makeRequest("plugin://my-plugin/dist/index.js", { method: "POST" })
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });

  it("uses immutable Cache-Control for fingerprinted assets", async () => {
    const appProtocol = await import("../../utils/appProtocol.js");
    // The real `isImmutableAppAsset` is imported alongside `getMimeType`, but
    // the appProtocol module is mocked in this test file. Verify the handler
    // calls `isImmutableAppAsset` and routes its return to Cache-Control.
    const fs = await import("fs/promises");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("text/javascript");

    // Stub isImmutableAppAsset to return true (fingerprinted Vite asset).
    const isImmutableAppAsset = vi.mocked(appProtocol.isImmutableAppAsset);
    isImmutableAppAsset.mockReturnValue(true);

    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/assets/index-Ab3Xy789.js"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it("uses no-cache Cache-Control for non-fingerprinted assets", async () => {
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.isImmutableAppAsset).mockReturnValue(false);

    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/manifest.json"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("returns 404 when realpath fails on the plugin root (EACCES)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation(() => {
      const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
      return Promise.reject(err);
    });

    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/index.js"));

    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("closes the file handle even when readFile fails", async () => {
    const fs = await import("fs/promises");
    const handle = {
      readFile: vi.fn().mockRejectedValue(new Error("EIO")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(fs.open).mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>);

    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/broken.js"));

    expect(response.status).toBe(500);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("returns 500 for unexpected open errors (EACCES) — distinct from the 404 not-found branch", async () => {
    const fs = await import("fs/promises");
    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
    vi.mocked(fs.open).mockRejectedValue(eacces);

    const handler = buildHandler();
    const response = await handler(makeRequest("plugin://my-plugin/permission-denied.js"));

    expect(response.status).toBe(500);
  });

  it("blocks via the path.isAbsolute(rel) branch (Windows cross-drive simulation)", async () => {
    // Symmetry with the daintree-file:// equivalent: forcing path.relative
    // to return an absolute path isolates the isAbsolute guard from the '..'
    // branch — same shape as Windows cross-drive (relative('D:\\proj','C:\\win')
    // === 'C:\\win'). With this branch removed, a cross-drive symlink target
    // would slip through containment.
    const fs = await import("fs/promises");
    const relativeSpy = vi.spyOn(path, "relative").mockReturnValue("/absolute/elsewhere");

    try {
      const handler = buildHandler();
      const response = await handler(makeRequest("plugin://my-plugin/file.js"));

      expect(response.status).toBe(404);
      expect(fs.open).not.toHaveBeenCalled();
    } finally {
      relativeSpy.mockRestore();
    }
  });
});

describe("createAppProtocolHandler — ASAR-safe buffered read", () => {
  type ProtocolHandler = (request: GlobalRequest) => Promise<Response>;

  async function captureHandler(): Promise<ProtocolHandler> {
    const handle = vi.fn();
    const mockSession = { protocol: { handle } } as unknown as Electron.Session;
    registerProtocolsForSession(mockSession, "/tmp/dist");
    const call = handle.mock.calls.find((c) => c[0] === "app");
    if (!call) throw new Error("handler for app not registered");
    return call[1] as ProtocolHandler;
  }

  function makeRequest(
    pathname = "/assets/index-abc123.js",
    init?: { method?: string; headers?: Record<string, string> }
  ): GlobalRequest {
    return new Request(`app://daintree${pathname}`, init) as GlobalRequest;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import("fs/promises");
    vi.mocked(fs.stat).mockResolvedValue({
      mtime: new Date(0),
      isFile: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("bytes"));
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.resolveAppUrlToDistPath).mockReturnValue({
      filePath: "/tmp/dist/assets/index-abc123.js",
    } as ReturnType<typeof appProtocol.resolveAppUrlToDistPath>);
    vi.mocked(appProtocol.getMimeType).mockReturnValue("text/javascript");
    vi.mocked(appProtocol.buildHeaders).mockReturnValue({
      "Content-Type": "text/javascript",
    } as ReturnType<typeof appProtocol.buildHeaders>);
    vi.mocked(appProtocol.isNotModified).mockReturnValue(false);
  });

  it("serves the file with fs.readFile and never calls fs.open or net.fetch", async () => {
    const { net } = await import("electron");
    const fs = await import("fs/promises");

    const handler = await captureHandler();
    const response = await handler(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("bytes");
    // The whole point of #9768: read directly, no Chromium network-stack hop.
    expect(vi.mocked(net.fetch)).not.toHaveBeenCalled();
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.readFile).mock.calls[0][0]).toBe("/tmp/dist/assets/index-abc123.js");
    // #11726: dist/ lives inside the asar, and fs.open on an archived path makes
    // Electron extract it to a memoized temp file. Once that file is reaped the
    // entry goes stale and every open throws ENOENT for the life of the process,
    // so index.html — and with it every project switch — fails until restart.
    // fs.readFile reads off the archive's backing fd and never extracts. Swapping
    // back to open would silently reintroduce the bug, so guard it here.
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("builds the 200 response headers from the validator stats (Last-Modified / Cache-Control)", async () => {
    const fs = await import("fs/promises");
    const appProtocol = await import("../../utils/appProtocol.js");
    const stats = { mtime: new Date(1000), isFile: () => true } as Awaited<
      ReturnType<typeof fs.stat>
    >;
    vi.mocked(fs.stat).mockResolvedValue(stats);

    const handler = await captureHandler();
    const response = await handler(makeRequest());

    expect(response.status).toBe(200);
    expect(appProtocol.buildHeaders).toHaveBeenCalledWith("text/javascript", {
      stats,
      filePath: "/tmp/dist/assets/index-abc123.js",
    });
  });

  it("returns 404 for a directory URL even when the validator matches (no spurious 304)", async () => {
    const fs = await import("fs/promises");
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(fs.stat).mockResolvedValue({
      mtime: new Date(0),
      isFile: () => false,
    } as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(appProtocol.isNotModified).mockReturnValue(true);

    const handler = await captureHandler();
    const response = await handler(
      makeRequest("/assets/", {
        headers: { "If-Modified-Since": new Date(0).toUTCString() },
      })
    );

    expect(response.status).toBe(404);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("short-circuits to 304 without reading the file when the validator matches", async () => {
    const fs = await import("fs/promises");
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.isNotModified).mockReturnValue(true);

    const handler = await captureHandler();
    const response = await handler(
      makeRequest("/assets/index-abc123.js", {
        headers: { "If-Modified-Since": new Date(0).toUTCString() },
      })
    );

    expect(response.status).toBe(304);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("returns 405 for non-GET/HEAD methods without resolving a path", async () => {
    const appProtocol = await import("../../utils/appProtocol.js");

    const handler = await captureHandler();
    const response = await handler(makeRequest("/assets/index-abc123.js", { method: "POST" }));

    expect(response.status).toBe(405);
    expect(appProtocol.resolveAppUrlToDistPath).not.toHaveBeenCalled();
  });

  it("returns 404 when the URL resolves outside the dist root", async () => {
    const fs = await import("fs/promises");
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.resolveAppUrlToDistPath).mockReturnValue({
      filePath: "",
      error: "path traversal",
    } as ReturnType<typeof appProtocol.resolveAppUrlToDistPath>);

    const handler = await captureHandler();
    const response = await handler(makeRequest("/../../etc/passwd"));

    expect(response.status).toBe(404);
    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("returns 404 when stat fails (missing file)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const handler = await captureHandler();
    const response = await handler(makeRequest());

    expect(response.status).toBe(404);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("returns 404 when the read rejects with ENOENT after stat succeeded", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    const handler = await captureHandler();
    const response = await handler(makeRequest());

    expect(response.status).toBe(404);
  });

  it("returns 404 when the read rejects with EISDIR (directory that slipped past isFile)", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.readFile).mockRejectedValue(
      Object.assign(new Error("EISDIR"), { code: "EISDIR" })
    );

    const handler = await captureHandler();
    const response = await handler(makeRequest());

    expect(response.status).toBe(404);
  });

  it("returns 500 when the read fails with an error that isn't a missing file", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));

    const handler = await captureHandler();
    const response = await handler(makeRequest());

    expect(response.status).toBe(500);
  });

  describe("404 diagnostics (#11635)", () => {
    // Every app:// URL is an application-owned dist asset, so a 404 always
    // means the packaged tree is damaged. All the branches returned the same
    // bare body with nothing in the log, so a production report could not say
    // which read actually failed — and losing index.html this way still
    // commits a document that looks like a successful navigation.
    /**
     * The single diagnostic for the request just served. Asserting there is
     * exactly one keeps a later branch from quietly adding a second,
     * contradictory line for the same 404.
     */
    async function notFoundLog(): Promise<Record<string, unknown> | undefined> {
      const { logWarn } = await import("../../utils/logger.js");
      const calls = vi
        .mocked(logWarn)
        .mock.calls.filter(([event]) => event === "app.protocol.not-found");
      expect(calls).toHaveLength(1);
      return calls[0]?.[1] as Record<string, unknown> | undefined;
    }

    it("distinguishes the stat failure from the other 404 branches", async () => {
      const fs = await import("fs/promises");
      vi.mocked(fs.stat).mockRejectedValue(
        Object.assign(new Error("nope"), {
          code: "ENOENT",
          errno: -2,
          path: "/tmp/dist/assets/vanished.js",
          syscall: "stat",
        })
      );

      const handler = await captureHandler();
      await handler(makeRequest("/assets/vanished.js"));

      expect(await notFoundLog()).toMatchObject({
        stage: "stat",
        // The requested URL and the path it resolved to are both needed: the
        // report has to name the asset that went missing, not just the stage.
        url: "app://daintree/assets/vanished.js",
        filePath: "/tmp/dist/assets/index-abc123.js",
        code: "ENOENT",
        errno: -2,
        // Carried through from the failing syscall alongside filePath, so a
        // report can tell the path we asked for apart from the one the
        // filesystem layer actually reported (#11726).
        path: "/tmp/dist/assets/vanished.js",
        syscall: "stat",
      });
    });

    it("reports a directory hit as its own stage rather than an error code", async () => {
      const fs = await import("fs/promises");
      vi.mocked(fs.stat).mockResolvedValue({
        mtime: new Date(0),
        isFile: () => false,
      } as Awaited<ReturnType<typeof fs.stat>>);

      const handler = await captureHandler();
      await handler(makeRequest("/assets/"));

      const logged = await notFoundLog();
      expect(logged).toMatchObject({ stage: "not-a-file" });
      // Nothing threw, so there is no errno to invent.
      expect(logged).not.toHaveProperty("code");
      // Same for the syscall fields: this branch has no caught error to read
      // them off, and a report that carried them anyway would be fiction.
      expect(logged).not.toHaveProperty("path");
      expect(logged).not.toHaveProperty("syscall");
    });

    it("reports a body-read failure as its own stage, apart from stat and not-a-file", async () => {
      const fs = await import("fs/promises");
      vi.mocked(fs.readFile).mockRejectedValue(
        Object.assign(new Error("nope"), { code: "EISDIR", syscall: "read" })
      );

      const handler = await captureHandler();
      await handler(makeRequest());

      expect(await notFoundLog()).toMatchObject({
        stage: "read",
        code: "EISDIR",
        syscall: "read",
      });
    });

    it("logs the resolver rejection with its reason and never touches disk", async () => {
      const fs = await import("fs/promises");
      const appProtocol = await import("../../utils/appProtocol.js");
      vi.mocked(appProtocol.resolveAppUrlToDistPath).mockReturnValue({
        filePath: "",
        error: "path traversal",
      } as ReturnType<typeof appProtocol.resolveAppUrlToDistPath>);

      const handler = await captureHandler();
      await handler(makeRequest("/../../etc/passwd"));

      expect(await notFoundLog()).toMatchObject({
        stage: "resolve",
        reason: "path traversal",
      });
      expect(fs.stat).not.toHaveBeenCalled();
    });
  });
});

describe("createDaintreeHtmlProtocolHandler — sandboxed HTML preview (#11191)", () => {
  type ProtocolHandler = (request: GlobalRequest) => Promise<Response>;

  const ROOT = path.resolve("/project/report");
  let token: string;

  async function captureHandler(): Promise<ProtocolHandler> {
    const handle = vi.fn();
    const mockSession = { protocol: { handle } } as unknown as Electron.Session;
    registerProtocolsForSession(mockSession, "/tmp/dist");
    const call = handle.mock.calls.find((c) => c[0] === "daintree-html");
    if (!call) throw new Error("handler for daintree-html not registered");
    return call[1] as ProtocolHandler;
  }

  function makeRequest(authority: string, relPath: string): GlobalRequest {
    return new Request(`daintree-html://${authority}/${relPath}`) as GlobalRequest;
  }

  function makeFileHandle(content: string | Buffer = "<h1>hi</h1>") {
    const buffer = typeof content === "string" ? Buffer.from(content) : content;
    return {
      readFile: vi.fn().mockResolvedValue(buffer),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetHtmlPreviewTokensForTests();
    token = mintHtmlPreviewToken(ROOT);
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 11 } as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle() as unknown as Awaited<ReturnType<typeof fs.open>>
    );
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("text/css");
  });

  it("serves an HTML document with a token-scoped preview CSP", async () => {
    const handler = await captureHandler();
    const response = await handler(makeRequest(token, "index.html"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    // Scoped to the EXACT token authority — never scheme-wide — so the framed
    // report can't tag-load through the legacy daintree-file:// route.
    expect(csp).toContain(`script-src daintree-html://${token} 'unsafe-inline' 'unsafe-eval'`);
    expect(csp).not.toMatch(/script-src daintree-html:(?!\/\/)/);
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    // WebRTC isn't governed by connect-src, so it's blocked explicitly.
    expect(csp).toContain("webrtc 'block'");
    // Egress-limiting response headers.
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-DNS-Prefetch-Control")).toBe("off");
    // Opens the user-derived path with O_NOFOLLOW (TOCTOU defense).
    const fs = await import("fs/promises");
    expect(fs.open).toHaveBeenCalledWith(
      path.resolve(ROOT, "index.html"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
  });

  it("404s when the token's root no longer canonically resolves to itself (retarget guard)", async () => {
    const fs = await import("fs/promises");
    // The root path was renamed away and now resolves elsewhere (symlink swap).
    vi.mocked(fs.realpath).mockImplementation((p) =>
      Promise.resolve(p === ROOT ? (path.resolve("/") as string) : (p as string))
    );

    const handler = await captureHandler();
    const response = await handler(makeRequest(token, "index.html"));
    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("treats .htm the same as .html", async () => {
    const handler = await captureHandler();
    const response = await handler(makeRequest(token, "page.htm"));
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
  });

  it("serves a non-HTML sibling asset with the strict leaf CSP, not the preview CSP", async () => {
    const handler = await captureHandler();
    const response = await handler(makeRequest(token, "assets/app.css"));

    expect(response.status).toBe(200);
    // Sub-resource: strict leaf headers (browser ignores CSP on sub-resources).
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("Content-Type")).toBe("text/css");
    const fs = await import("fs/promises");
    expect(fs.open).toHaveBeenCalledWith(
      path.resolve(ROOT, "assets/app.css"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
  });

  it("resolves root-relative asset paths within the mapped root", async () => {
    const handler = await captureHandler();
    await handler(makeRequest(token, "assets/logo.svg"));
    const fs = await import("fs/promises");
    expect(fs.open).toHaveBeenCalledWith(path.resolve(ROOT, "assets/logo.svg"), expect.any(Number));
  });

  it("404s an unknown or released token without touching the filesystem", async () => {
    const handler = await captureHandler();
    const response = await handler(
      makeRequest("00000000-dead-beef-0000-000000000000", "index.html")
    );

    expect(response.status).toBe(404);
    const fs = await import("fs/promises");
    expect(fs.open).not.toHaveBeenCalled();
    expect(fs.realpath).not.toHaveBeenCalled();
  });

  it("404s a bare token URL with no file path", async () => {
    const handler = await captureHandler();
    const response = await handler(new Request(`daintree-html://${token}/`) as GlobalRequest);
    expect(response.status).toBe(404);
  });

  it("rejects a symlink that escapes the root (realpath containment)", async () => {
    const fs = await import("fs/promises");
    // The requested file realpath-resolves outside the mapped root.
    vi.mocked(fs.realpath).mockImplementation((p) =>
      Promise.resolve(p === ROOT ? ROOT : (path.resolve("/etc/passwd") as string))
    );

    const handler = await captureHandler();
    const response = await handler(makeRequest(token, "link.html"));
    expect(response.status).toBe(404);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("rejects an encoded backslash segment", async () => {
    const handler = await captureHandler();
    const response = await handler(makeRequest(token, "sub%5Cfile.html"));
    expect(response.status).toBe(404);
  });

  it("enforces the 512 KB size cap with 413", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.stat).mockResolvedValue({ size: 512 * 1024 + 1 } as Awaited<
      ReturnType<typeof fs.stat>
    >);

    const handler = await captureHandler();
    const response = await handler(makeRequest(token, "big.html"));
    expect(response.status).toBe(413);
  });

  it("keeps report image assets at the 512 KB cap (raster allowance is file:// only)", async () => {
    // The larger raster-image ceiling is scoped to the daintree-file:// viewer;
    // a script-driven preview must not be able to pull multi-MB images through
    // the shared read core. A 2 MB PNG asset here still 413s.
    const fs = await import("fs/promises");
    vi.mocked(fs.stat).mockResolvedValue({ size: 2 * 1024 * 1024 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("image/png");

    const handler = await captureHandler();
    const response = await handler(makeRequest(token, "chart.png"));
    expect(response.status).toBe(413);
  });
});

describe("createDaintreePdfProtocolHandler — inline PDF preview (#11427)", () => {
  type ProtocolHandler = (request: GlobalRequest) => Promise<Response>;

  async function captureHandler(): Promise<ProtocolHandler> {
    const handle = vi.fn();
    const mockSession = { protocol: { handle } } as unknown as Electron.Session;
    registerProtocolsForSession(mockSession, "/tmp/dist");
    const call = handle.mock.calls.find((c) => c[0] === "daintree-pdf");
    if (!call) throw new Error("handler for daintree-pdf not registered");
    return call[1] as ProtocolHandler;
  }

  function makeRequest(filePath: string, rootPath: string, init?: RequestInit): GlobalRequest {
    const url = new URL("daintree-pdf://load");
    url.searchParams.set("path", filePath);
    url.searchParams.set("root", rootPath);
    return new Request(url.toString(), init) as GlobalRequest;
  }

  function makeFileHandle(content: string | Buffer = "%PDF-1.4 body") {
    const buffer = typeof content === "string" ? Buffer.from(content) : content;
    return {
      readFile: vi.fn().mockResolvedValue(buffer),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string));
    vi.mocked(fs.stat).mockResolvedValue({ size: 13 } as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle() as unknown as Awaited<ReturnType<typeof fs.open>>
    );
    const appProtocol = await import("../../utils/appProtocol.js");
    vi.mocked(appProtocol.getMimeType).mockReturnValue("application/pdf");
  });

  it("serves a PDF with no CSP and no COEP so PDFium can install its viewer frame", async () => {
    const handler = await captureHandler();
    const response = await handler(makeRequest("/project/spec.pdf", "/project"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    // Both headers are load-bearing by their ABSENCE: a `sandbox` CSP blocks
    // PDFium outright, and a COEP makes the PDF an embedder whose own viewer
    // frame is then blocked. The iframe carries `credentialless` instead.
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBeNull();
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports the byte length actually returned", async () => {
    const fs = await import("fs/promises");
    const bytes = Buffer.from("%PDF-1.7 a longer body than the stat claimed");
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle(bytes) as unknown as Awaited<ReturnType<typeof fs.open>>
    );

    const handler = await captureHandler();
    const response = await handler(makeRequest("/project/spec.pdf", "/project"));

    expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
  });

  it("names the download after the file, not the URL's `load` segment", async () => {
    const handler = await captureHandler();
    const response = await handler(makeRequest("/project/data sheet.pdf", "/project"));

    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition.startsWith("inline")).toBe(true);
    expect(disposition).toContain('filename="data sheet.pdf"');
    expect(disposition).not.toContain("load");
  });

  it("opens the user-supplied path with O_NOFOLLOW", async () => {
    const fs = await import("fs/promises");
    const handler = await captureHandler();
    await handler(makeRequest("/project/spec.pdf", "/project"));

    expect(fs.open).toHaveBeenCalledWith(
      path.normalize("/project/spec.pdf"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
  });

  it.each(["/project/spec.PDF", "/project/a.b.Pdf"])(
    "accepts the case-insensitive extension %s",
    async (filePath) => {
      const handler = await captureHandler();
      const response = await handler(makeRequest(filePath, "/project"));
      expect(response.status).toBe(200);
    }
  );

  it("rejects a non-PDF before reading any bytes", async () => {
    const fs = await import("fs/promises");
    const handler = await captureHandler();
    const response = await handler(makeRequest("/project/notes.txt", "/project"));

    expect(response.status).toBe(415);
    // The gate must run before the read, or an arbitrary in-root file would be
    // buffered under the PDF ceiling rather than the much tighter text cap.
    expect(fs.open).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it("rejects a .pdf name whose canonical path is not a PDF", async () => {
    // On Windows O_NOFOLLOW is a no-op, so a final-component symlink
    // (`spec.pdf` -> `huge.bin`) would otherwise be served under the PDF cap.
    const fs = await import("fs/promises");
    vi.mocked(fs.realpath).mockImplementation((p) =>
      Promise.resolve(
        (p as string).endsWith("spec.pdf") ? path.normalize("/project/huge.bin") : (p as string)
      )
    );

    const handler = await captureHandler();
    const response = await handler(makeRequest("/project/spec.pdf", "/project"));

    expect(response.status).toBe(415);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("types a .pdf holding active HTML as a PDF rather than a document", async () => {
    // This is what makes the `frame-src daintree-pdf:` allowance safe: the
    // bytes reach PDFium and fail as a malformed PDF instead of executing.
    const fs = await import("fs/promises");
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle("<script>parent.pwned = true</script>") as unknown as Awaited<
        ReturnType<typeof fs.open>
      >
    );

    const handler = await captureHandler();
    const response = await handler(makeRequest("/project/evil.pdf", "/project"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("ignores a Range header and answers with the whole document", async () => {
    // PDFium renders from a single buffered 200, so the video path's ranged
    // streaming is deliberately not wired here.
    const fs = await import("fs/promises");
    const bytes = Buffer.from("%PDF-1.4 the entire document body");
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle(bytes) as unknown as Awaited<ReturnType<typeof fs.open>>
    );

    const handler = await captureHandler();
    const response = await handler(
      makeRequest("/project/spec.pdf", "/project", { headers: { Range: "bytes=0-4" } })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Range")).toBeNull();
    // Assert the bytes, not just the status: a truncated or empty 200 would
    // otherwise satisfy this test while breaking the viewer.
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("answers HEAD with the metadata and no body", async () => {
    const handler = await captureHandler();
    const response = await handler(
      makeRequest("/project/spec.pdf", "/project", { method: "HEAD" })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("allows a PDF larger than the raster-image ceiling but rejects one past its own", async () => {
    const fs = await import("fs/promises");
    const handler = await captureHandler();

    // 30 MB clears the 25 MB image cap — proving PDFs get their own, larger
    // ceiling rather than inheriting one of the existing limits.
    vi.mocked(fs.stat).mockResolvedValue({ size: 30 * 1024 * 1024 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    expect((await handler(makeRequest("/project/big.pdf", "/project"))).status).toBe(200);

    // 60 MB must fail. Bracketing the ceiling between 30 and 60 pins it without
    // restating the constant, so a tenfold relaxation can't slip through.
    vi.mocked(fs.stat).mockResolvedValue({ size: 60 * 1024 * 1024 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    expect((await handler(makeRequest("/project/huge.pdf", "/project"))).status).toBe(413);
  });

  it("rejects bytes that grew past the ceiling between stat and read", async () => {
    const fs = await import("fs/promises");
    vi.mocked(fs.stat).mockResolvedValue({ size: 100 } as Awaited<ReturnType<typeof fs.stat>>);
    // The pre-read stat is advisory — a writer can swap the file underneath it,
    // so the bytes actually read are re-checked before they reach the renderer.
    vi.mocked(fs.open).mockResolvedValue(
      makeFileHandle(Buffer.alloc(60 * 1024 * 1024)) as unknown as Awaited<
        ReturnType<typeof fs.open>
      >
    );

    const handler = await captureHandler();
    expect((await handler(makeRequest("/project/spec.pdf", "/project"))).status).toBe(413);
  });

  it("percent-encodes an extended filename so a conforming parser accepts it", async () => {
    const handler = await captureHandler();
    const response = await handler(makeRequest("/project/O'Brien (1)*.pdf", "/project"));

    const disposition = response.headers.get("Content-Disposition") ?? "";
    const extended = disposition.match(/filename\*=UTF-8''(.*)$/)?.[1] ?? "";
    // RFC 8187 attr-char excludes ' ( ) * — none may survive unescaped, or the
    // recipient discards the extended value and falls back to the lossy one.
    expect(extended).not.toMatch(/['()*]/);
    expect(decodeURIComponent(extended)).toBe("O'Brien (1)*.pdf");
  });

  it("strips control characters from the ASCII filename fallback", async () => {
    const handler = await captureHandler();
    const response = await handler(makeRequest('/project/a\r\nb"c.pdf', "/project"));

    const disposition = response.headers.get("Content-Disposition") ?? "";
    // A raw CR/LF or quote here would break out of the header value.
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition.match(/filename="([^"]*)"/)?.[1]).toBe("a__b_c.pdf");
  });

  it("rejects a file outside the root", async () => {
    const handler = await captureHandler();
    const response = await handler(makeRequest("/elsewhere/secret.pdf", "/project"));
    expect(response.status).toBe(404);
  });

  it.each([
    ["relative paths", "project/spec.pdf", "/project"],
    ["a NUL byte", "/project/spec\0.pdf", "/project"],
  ])("rejects %s with 400", async (_label, filePath, rootPath) => {
    const handler = await captureHandler();
    const response = await handler(makeRequest(filePath, rootPath));
    expect(response.status).toBe(400);
  });

  it("rejects a request missing the path parameter", async () => {
    const handler = await captureHandler();
    const response = await handler(
      new Request("daintree-pdf://load?root=%2Fproject") as GlobalRequest
    );
    expect(response.status).toBe(400);
  });

  it("rejects a non-GET method", async () => {
    const handler = await captureHandler();
    const response = await handler(
      makeRequest("/project/spec.pdf", "/project", { method: "POST" })
    );
    expect(response.status).toBe(405);
  });

  it("keeps error responses inert rather than serving them as PDFs", async () => {
    const handler = await captureHandler();
    const response = await handler(makeRequest("/project/notes.txt", "/project"));

    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
  });
});

describe("applyDaintreeAppCspToSession — preview response pass-through", () => {
  // The second CSP overlay call site. It and setupWebviewCSP must agree about
  // which preview responses keep their own headers; a bypass added to only one
  // leaves paint-surface views silently broken (#11198).
  async function captureListener() {
    const { mergeCspHeaders } = await import("../../utils/webviewCsp.js");
    vi.mocked(mergeCspHeaders).mockClear();

    let captured:
      | ((details: unknown, callback: (r: { responseHeaders?: unknown }) => void) => void)
      | undefined;
    const ses = {
      webRequest: {
        onHeadersReceived: vi.fn(
          (
            _filter: unknown,
            listener: (
              details: unknown,
              callback: (r: { responseHeaders?: unknown }) => void
            ) => void
          ) => {
            captured = listener;
          }
        ),
      },
    } as unknown as Electron.Session;

    applyDaintreeAppCspToSession(ses);
    if (!captured) throw new Error("no onHeadersReceived listener registered");
    return { listener: captured, mergeCspHeaders: vi.mocked(mergeCspHeaders) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([["daintree-pdf://load?path=%2Frepo%2Fa.pdf"], ["daintree-html://tok/index.html"]])(
    "passes %s through untouched",
    async (url) => {
      const { listener, mergeCspHeaders } = await captureListener();
      const headers = { "Content-Type": ["application/pdf"] };

      let result: { responseHeaders?: unknown } | undefined;
      listener({ url, responseHeaders: headers }, (r) => {
        result = r;
      });

      expect(result?.responseHeaders).toBe(headers);
      expect(mergeCspHeaders).not.toHaveBeenCalled();
    }
  );

  it("still overlays the app CSP on ordinary responses", async () => {
    const { listener, mergeCspHeaders } = await captureListener();

    listener({ url: "app://daintree/index.html", responseHeaders: {} }, () => {});

    expect(mergeCspHeaders).toHaveBeenCalledTimes(1);
  });
});
