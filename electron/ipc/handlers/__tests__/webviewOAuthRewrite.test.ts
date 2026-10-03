import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type MessageListener = (event: unknown, method: string, params: unknown) => void;

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const debuggerMock = vi.hoisted(() => ({
  isAttached: vi.fn(() => false),
  attach: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendCommand: vi.fn<(...args: any[]) => Promise<any>>(() => Promise.resolve({})),
  on: vi.fn(),
  off: vi.fn(),
  removeListener: vi.fn(),
}));

const mockWebContents = vi.hoisted(() => ({
  id: 42,
  isDestroyed: vi.fn(() => false),
  debugger: debuggerMock,
  executeJavaScript: vi.fn().mockResolvedValue([]),
  getURL: vi.fn(() => "http://localhost:5173/"),
  loadURL: vi.fn<(url: string) => Promise<void>>(),
  once: vi.fn(),
  hostWebContents: null as unknown,
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  webContents: { fromId: vi.fn(() => mockWebContents) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: vi.fn(() => null) },
  app: { on: vi.fn() },
}));

const mockDialogService = vi.hoisted(() => ({
  registerPanel: vi.fn(),
  resolveDialog: vi.fn(),
  getPanelId: vi.fn<(id: number) => string | undefined>(() => "oauth-panel"),
  consumeOAuthSessionStorage: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../services/WebviewDialogService.js", () => ({
  getWebviewDialogService: () => mockDialogService,
}));

const ownerWindow = vi.hoisted(() => ({ id: "owner-window" }));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => ownerWindow),
}));

const startOAuthLoopbackMock = vi.hoisted(() => vi.fn());

vi.mock("../../../services/OAuthLoopbackService.js", () => ({
  startOAuthLoopback: startOAuthLoopbackMock,
  cancelOAuthLoopback: vi.fn(),
}));

vi.mock("../../utils.js", () => ({
  sendToRenderer: vi.fn(),
  broadcastToRenderer: vi.fn(),
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)({ webContentsId: 0 }, ...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

import { registerWebviewHandlers } from "../webview.js";
import { sendToRenderer } from "../../utils.js";
import type { HandlerDependencies } from "../../types.js";

const deps = { mainWindow: {} } as unknown as HandlerDependencies;

const ORIGINAL_REDIRECT = "https://app.example.com/auth/callback";
const LOOPBACK_REDIRECT = "http://127.0.0.1:53682/callback";
const CALLBACK_URL = "https://app.example.com/auth/callback?code=abc&state=xyz";

function getOAuthHandler() {
  const call = ipcMainMock.handle.mock.calls.find(
    ([channel]: string[]) => channel === "webview:oauth-loopback"
  );
  if (!call) throw new Error("webview:oauth-loopback handler not registered");
  return call[1] as (
    event: unknown,
    authUrl: unknown,
    panelId: unknown,
    webContentsId: unknown,
    snapshot?: unknown
  ) => Promise<unknown>;
}

function getInterceptor(): MessageListener {
  const call = debuggerMock.on.mock.calls.find(([event]: string[]) => event === "message");
  if (!call) throw new Error("CDP message listener was never bound");
  return call[1] as MessageListener;
}

function continueRequestCalls() {
  return debuggerMock.sendCommand.mock.calls.filter(
    ([command]: string[]) => command === "Fetch.continueRequest"
  ) as Array<[string, { requestId: string; postData?: string }]>;
}

function decode(postData: string | undefined): string | undefined {
  return postData === undefined ? undefined : Buffer.from(postData, "base64").toString("utf8");
}

describe("webview OAuth loopback CDP token-exchange rewrite", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    debuggerMock.isAttached.mockReturnValue(false);
    debuggerMock.sendCommand.mockImplementation(() => Promise.resolve({}));
    mockWebContents.isDestroyed.mockReturnValue(false);
    mockDialogService.getPanelId.mockReturnValue("oauth-panel");
    startOAuthLoopbackMock.mockResolvedValue({
      success: true,
      callbackUrl: CALLBACK_URL,
      loopbackRedirectUri: LOOPBACK_REDIRECT,
      originalRedirectUri: ORIGINAL_REDIRECT,
    });
    cleanup = registerWebviewHandlers(deps);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("enables Fetch interception for Fetch/XHR requests before navigating to the callback", async () => {
    const order: string[] = [];
    debuggerMock.sendCommand.mockImplementation((command: string) => {
      order.push(command);
      return Promise.resolve({});
    });
    mockWebContents.loadURL.mockImplementation((url: string) => {
      order.push(`loadURL:${url}`);
      getInterceptor()({}, "Fetch.requestPaused", {
        requestId: "token",
        request: {
          url: "https://idp.example.com/token",
          method: "POST",
          postData: "grant_type=authorization_code&code=abc",
        },
      });
      return Promise.resolve();
    });

    await getOAuthHandler()(null, "https://idp.example.com/authorize", "oauth-panel", 42);

    expect(debuggerMock.attach).toHaveBeenCalledWith("1.3");
    expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [
        { urlPattern: "*", resourceType: "Fetch", requestStage: "Request" },
        { urlPattern: "*", resourceType: "XHR", requestStage: "Request" },
      ],
    });
    expect(order.indexOf("Fetch.enable")).toBeLessThan(order.indexOf(`loadURL:${CALLBACK_URL}`));
  });

  it("rewrites redirect_uri in the token-exchange POST body to the loopback URI", async () => {
    const originalBody =
      `grant_type=authorization_code&code=abc&redirect_uri=${encodeURIComponent(ORIGINAL_REDIRECT)}` +
      `&client_id=daintree`;
    mockWebContents.loadURL.mockImplementation(() => {
      const interceptor = getInterceptor();
      interceptor({}, "Network.requestWillBeSent", { requestId: "ignored" });
      interceptor({}, "Fetch.requestPaused", {
        requestId: "asset",
        request: { url: "https://app.example.com/app.js", method: "GET" },
      });
      interceptor({}, "Fetch.requestPaused", {
        requestId: "refresh",
        request: {
          url: "https://idp.example.com/token",
          method: "POST",
          postData: "grant_type=refresh_token&refresh_token=r1",
        },
      });
      interceptor({}, "Fetch.requestPaused", {
        requestId: "token",
        request: { url: "https://idp.example.com/token", method: "POST", postData: originalBody },
      });
      return Promise.resolve();
    });

    const result = await getOAuthHandler()(
      null,
      "https://idp.example.com/authorize",
      "oauth-panel",
      42
    );

    expect(result).toEqual({
      success: true,
      callbackUrl: CALLBACK_URL,
      loopbackRedirectUri: LOOPBACK_REDIRECT,
      originalRedirectUri: ORIGINAL_REDIRECT,
    });

    const calls = continueRequestCalls();
    expect(calls.map(([, params]) => params.requestId)).toEqual(["asset", "refresh", "token"]);

    const [, assetParams] = calls[0];
    const [, refreshParams] = calls[1];
    expect(assetParams).toEqual({ requestId: "asset" });
    expect(refreshParams).toEqual({ requestId: "refresh" });

    const [, tokenParams] = calls[2];
    expect(decode(tokenParams.postData)).toBe(
      `grant_type=authorization_code&code=abc&redirect_uri=${encodeURIComponent(LOOPBACK_REDIRECT)}` +
        `&client_id=daintree`
    );

    expect(sendToRenderer).toHaveBeenCalledWith(ownerWindow, "webview:oauth-loopback-status", {
      panelId: "oauth-panel",
      phase: "token-exchange-intercepted",
    });
    expect(sendToRenderer).toHaveBeenLastCalledWith(ownerWindow, "webview:oauth-loopback-status", {
      panelId: "oauth-panel",
      phase: "completed",
    });
  });

  it("passes a token-exchange body through unchanged when it carries no matching redirect_uri", async () => {
    const body = "grant_type=authorization_code&code=abc&code_verifier=v";
    mockWebContents.loadURL.mockImplementation(() => {
      getInterceptor()({}, "Fetch.requestPaused", {
        requestId: "token",
        request: { url: "https://idp.example.com/token", method: "POST", postData: body },
      });
      return Promise.resolve();
    });

    await getOAuthHandler()(null, "https://idp.example.com/authorize", "oauth-panel", 42);

    const calls = continueRequestCalls();
    expect(calls).toHaveLength(1);
    expect(decode(calls[0][1].postData)).toBe(body);
  });

  it("tears down the interceptor and disables Fetch after the exchange", async () => {
    mockWebContents.loadURL.mockImplementation(() => {
      getInterceptor()({}, "Fetch.requestPaused", {
        requestId: "token",
        request: {
          url: "https://idp.example.com/token",
          method: "POST",
          postData: "grant_type=authorization_code&code=abc",
        },
      });
      return Promise.resolve();
    });

    await getOAuthHandler()(null, "https://idp.example.com/authorize", "oauth-panel", 42);

    expect(debuggerMock.removeListener).toHaveBeenCalledWith("message", getInterceptor());
    expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Fetch.disable");
  });

  it("restores the captured sessionStorage only on the callback origin", async () => {
    debuggerMock.sendCommand.mockImplementation((command: string) =>
      Promise.resolve(
        command === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "restore-1" } : {}
      )
    );
    mockWebContents.loadURL.mockImplementation(() => {
      getInterceptor()({}, "Fetch.requestPaused", {
        requestId: "token",
        request: {
          url: "https://idp.example.com/token",
          method: "POST",
          postData: "grant_type=authorization_code&code=abc",
        },
      });
      return Promise.resolve();
    });

    await getOAuthHandler()(null, "https://idp.example.com/authorize", "oauth-panel", 42, [
      ["pkce_verifier", "v-123"],
    ]);

    const addScript = debuggerMock.sendCommand.mock.calls.find(
      ([command]: string[]) => command === "Page.addScriptToEvaluateOnNewDocument"
    ) as [string, { source: string }] | undefined;
    expect(addScript).toBeDefined();
    const source = addScript![1].source;

    // Run the injected script against a stand-in page on each origin.
    const runOn = (origin: string) => {
      const storage = new Map<string, string>();
      const fakeWindow = { location: { origin } } as Record<string, unknown>;
      const sessionStorage = { setItem: (k: string, v: string) => storage.set(k, v) };
      new Function("window", "sessionStorage", source)(fakeWindow, sessionStorage);
      return storage;
    };
    expect(Object.fromEntries(runOn("https://app.example.com"))).toEqual({
      pkce_verifier: "v-123",
    });
    expect(runOn("https://evil.example.com").size).toBe(0);
    expect(debuggerMock.sendCommand).toHaveBeenCalledWith(
      "Page.removeScriptToEvaluateOnNewDocument",
      { identifier: "restore-1" }
    );
  });
});
