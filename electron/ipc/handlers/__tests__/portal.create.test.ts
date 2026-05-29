import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HandlerShape = (event: { sender: unknown }, payload: unknown) => Promise<unknown>;

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: HandlerShape) => void>(),
  removeHandler: vi.fn<(channel: string) => void>(),
}));
const flushStorageDataMock = vi.hoisted(() => vi.fn(async () => undefined));
const fromPartitionMock = vi.hoisted(() =>
  vi.fn((_partition: string) => ({ flushStorageData: flushStorageDataMock }))
);

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  session: { fromPartition: fromPartitionMock },
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(() => ({ isDestroyed: () => false, send: vi.fn() })),
}));

import { CHANNELS } from "../../channels.js";
import { registerPortalHandlers } from "../portal.js";

function createPortalManager() {
  return {
    createTab: vi.fn<(tabId: string, url: string, partition?: string) => void>(),
    showTab: vi.fn(),
    hideAll: vi.fn(),
    updateBounds: vi.fn(),
    closeTab: vi.fn<(tabId: string) => Promise<void>>(),
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
  };
}

function getHandler(channel: string): HandlerShape {
  const call = ipcMainMock.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`Missing handler for ${channel}`);
  return call[1];
}

describe("portal create handler partition override", () => {
  let cleanup: (() => void) | null = null;
  let portalManager: ReturnType<typeof createPortalManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    portalManager = createPortalManager();
    cleanup = registerPortalHandlers({ portalManager } as never);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("forwards a valid dev-preview partition and flushes its session first", async () => {
    const handler = getHandler(CHANNELS.PORTAL_CREATE);
    const partition = "persist:dev-preview-proj-wt-panel";
    await handler({ sender: {} }, { tabId: "tab-1", url: "http://localhost:3000/", partition });

    expect(fromPartitionMock).toHaveBeenCalledWith(partition);
    expect(flushStorageDataMock).toHaveBeenCalledTimes(1);
    expect(portalManager.createTab).toHaveBeenCalledWith(
      "tab-1",
      "http://localhost:3000/",
      partition
    );
  });

  it("flushes before creating the tab", async () => {
    const order: string[] = [];
    flushStorageDataMock.mockImplementationOnce(async () => {
      order.push("flush");
    });
    portalManager.createTab.mockImplementationOnce(() => {
      order.push("create");
    });

    const handler = getHandler(CHANNELS.PORTAL_CREATE);
    await handler(
      { sender: {} },
      { tabId: "tab-1", url: "http://localhost:3000/", partition: "persist:dev-preview-a-b-c" }
    );

    expect(order).toEqual(["flush", "create"]);
  });

  it("falls back to persist:portal for a malformed partition without flushing", async () => {
    const handler = getHandler(CHANNELS.PORTAL_CREATE);
    await handler(
      { sender: {} },
      { tabId: "tab-1", url: "http://localhost:3000/", partition: "persist:evil" }
    );

    expect(fromPartitionMock).not.toHaveBeenCalled();
    expect(portalManager.createTab).toHaveBeenCalledWith(
      "tab-1",
      "http://localhost:3000/",
      "persist:portal"
    );
  });

  it("uses persist:portal when no partition is supplied", async () => {
    const handler = getHandler(CHANNELS.PORTAL_CREATE);
    await handler({ sender: {} }, { tabId: "tab-1", url: "http://localhost:3000/" });

    expect(fromPartitionMock).not.toHaveBeenCalled();
    expect(portalManager.createTab).toHaveBeenCalledWith(
      "tab-1",
      "http://localhost:3000/",
      "persist:portal"
    );
  });

  it("still creates the tab when flushStorageData rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    flushStorageDataMock.mockRejectedValueOnce(new Error("flush boom"));

    const handler = getHandler(CHANNELS.PORTAL_CREATE);
    await handler(
      { sender: {} },
      { tabId: "tab-1", url: "http://localhost:3000/", partition: "persist:dev-preview-a-b-c" }
    );

    expect(portalManager.createTab).toHaveBeenCalledWith(
      "tab-1",
      "http://localhost:3000/",
      "persist:dev-preview-a-b-c"
    );
    warnSpy.mockRestore();
  });

  it("rejects an invalid url before touching the session", async () => {
    const handler = getHandler(CHANNELS.PORTAL_CREATE);
    await expect(handler({ sender: {} }, { tabId: "tab-1" })).rejects.toThrow("Invalid url");
    expect(fromPartitionMock).not.toHaveBeenCalled();
    expect(portalManager.createTab).not.toHaveBeenCalled();
  });
});
