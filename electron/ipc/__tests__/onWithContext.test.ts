import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OnListener = (event: unknown, ...args: unknown[]) => unknown;

const { appMock, onListeners, ipcMainMock, getWindowMock, getProjectMock } = vi.hoisted(() => {
  const onListeners = new Map<string, OnListener[]>();
  return {
    appMock: { isPackaged: false, on: () => undefined },
    onListeners,
    ipcMainMock: {
      handle: () => undefined,
      handleOnce: () => undefined,
      removeHandler: () => undefined,
      on: (channel: string, listener: OnListener) => {
        onListeners.set(channel, [...(onListeners.get(channel) ?? []), listener]);
      },
      removeListener: (channel: string, listener: OnListener) => {
        onListeners.set(
          channel,
          (onListeners.get(channel) ?? []).filter((existing) => existing !== listener)
        );
      },
      removeAllListeners: () => undefined,
      off: () => undefined,
    },
    getWindowMock: vi.fn<(wc: unknown) => unknown>(() => null),
    getProjectMock: vi.fn<(id: number) => string | null>(() => null),
  };
});

vi.mock("electron", () => ({
  app: appMock,
  ipcMain: ipcMainMock,
  session: { defaultSession: {}, fromPartition: () => ({}) },
}));

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: vi.fn((url: string) => url.startsWith("app://")),
}));

vi.mock("../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: vi.fn(() => "corr-1"),
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: getWindowMock,
  getProjectForWebContents: getProjectMock,
  getAppWebContents: vi.fn(),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => false),
  isCachedViewWebContents: vi.fn(() => false),
}));

import { enforceIpcSenderValidation } from "../../setup/security.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../ipcGuard.js";
import { onWithContext } from "../utils.js";
import { getIpcDispatcher } from "../dispatcher.js";
import { _resetEndpointRegistryForTesting } from "../endpointRegistry.js";
import { _resetLocalEndpointsForTesting } from "../localEndpoint.js";
import type { ClientEndpoint, ClientRef } from "../endpoint.js";
import type { IpcContext } from "../types.js";

const HOST_SEND_CHANNEL = "terminal:input";

function makeSender(id: number) {
  return { id, isDestroyed: () => false, send: vi.fn(), once: vi.fn() };
}

function makeEvent(sender = makeSender(5), url = "app://daintree/index.html") {
  return { sender, senderFrame: { url } };
}

function sendLocal(channel: string, event: unknown, ...args: unknown[]): void {
  for (const listener of onListeners.get(channel) ?? []) listener(event, ...args);
}

const REMOTE_CLIENT: ClientRef = {
  clientId: "client-b",
  clientName: "greg-mbp",
  platform: "darwin",
  kind: "remote",
};

function makeRemoteEndpoint(): ClientEndpoint {
  return {
    endpointId: "remote:-3",
    clientId: "client-b",
    projectId: "proj-1",
    kind: "remote-view",
    handle: -3,
    send: vi.fn(),
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  };
}

const bareIpcMain = { ...ipcMainMock };
const cleanups: Array<() => void> = [];

beforeEach(() => {
  Object.assign(ipcMainMock, bareIpcMain);
  onListeners.clear();
  getWindowMock.mockReset().mockReturnValue(null);
  getProjectMock.mockReset().mockReturnValue(null);
  _resetIpcGuardForTesting();
  _resetEndpointRegistryForTesting();
  _resetLocalEndpointsForTesting();
  enforceIpcSenderValidation();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("onWithContext", () => {
  it("refuses to register before sender validation is installed", () => {
    _resetIpcGuardForTesting();
    expect(() => onWithContext(HOST_SEND_CHANNEL, () => undefined)).toThrow(
      /registered before enforceIpcSenderValidation/
    );
    markIpcSecurityReady();
  });

  it("hands a local message the same identity the invoke context carries", () => {
    const window = { id: 1 };
    getWindowMock.mockReturnValue(window);
    getProjectMock.mockReturnValue("proj-a");
    let seen: IpcContext | null = null;
    const listener = vi.fn((ctx: IpcContext) => {
      seen = ctx;
    });
    cleanups.push(onWithContext(HOST_SEND_CHANNEL, listener));

    const event = makeEvent();
    sendLocal(HOST_SEND_CHANNEL, event, "term-1", "ls\r");

    expect(listener).toHaveBeenCalledWith(expect.anything(), "term-1", "ls\r");
    const ctx = seen as unknown as IpcContext;
    expect(ctx.event).toBe(event);
    expect(ctx.webContentsId).toBe(5);
    expect(ctx.senderWindow).toBe(window);
    expect(ctx.projectId).toBe("proj-a");
    expect(ctx.endpoint.kind).toBe("local-view");
    expect(ctx.endpoint.handle).toBe(5);
    expect(ctx.client.kind).toBe("local");
  });

  it("resolves window and project only when a listener reads them", () => {
    cleanups.push(onWithContext(HOST_SEND_CHANNEL, () => undefined));

    sendLocal(HOST_SEND_CHANNEL, makeEvent(), "term-1", "x");

    expect(getWindowMock).not.toHaveBeenCalled();
    expect(getProjectMock).not.toHaveBeenCalled();
  });

  it("keeps the sender validation of ipcMain.on for local messages", () => {
    const listener = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    cleanups.push(onWithContext(HOST_SEND_CHANNEL, listener));

    sendLocal(HOST_SEND_CHANNEL, makeEvent(makeSender(5), "https://evil.example"), "id", "x");

    expect(listener).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("serves link sends with the endpoint context", async () => {
    const listener = vi.fn();
    cleanups.push(onWithContext(HOST_SEND_CHANNEL, listener));
    const endpoint = makeRemoteEndpoint();

    getIpcDispatcher().sendForEndpoint({ endpoint, client: REMOTE_CLIENT }, HOST_SEND_CHANNEL, [
      "term-1",
      "ls\r",
    ]);

    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          event: null,
          senderWindow: null,
          webContentsId: -3,
          projectId: "proj-1",
          endpoint,
          client: REMOTE_CLIENT,
        }),
        "term-1",
        "ls\r"
      );
    });
  });

  it("unregisters from both transports", async () => {
    const listener = vi.fn();
    onWithContext(HOST_SEND_CHANNEL, listener)();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    sendLocal(HOST_SEND_CHANNEL, makeEvent(), "term-1", "x");
    getIpcDispatcher().sendForEndpoint(
      { endpoint: makeRemoteEndpoint(), client: REMOTE_CLIENT },
      HOST_SEND_CHANNEL,
      ["term-1", "x"]
    );

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(HOST_SEND_CHANNEL));
    });
    expect(listener).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
