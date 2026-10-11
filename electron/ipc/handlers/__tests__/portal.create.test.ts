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
  getProjectForWebContents: vi.fn(() => null),
}));

import { CHANNELS } from "../../channels.js";
import { registerPortalHandlers } from "../portal.js";
import { setRemoteWebviewSrcGate } from "../../../window/webviewSrcGate.js";

function createPortalManager() {
  return {
    createTab: vi.fn<(tabId: string, url: string, partition?: string, options?: unknown) => void>(),
    markRestoring: vi.fn<(tabId: string) => void>(),
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

  it("marks the tab as restoring before createTab when isRestore is true", async () => {
    const order: string[] = [];
    portalManager.markRestoring.mockImplementationOnce(() => {
      order.push("markRestoring");
    });
    portalManager.createTab.mockImplementationOnce(() => {
      order.push("createTab");
    });

    const handler = getHandler(CHANNELS.PORTAL_CREATE);
    await handler(
      { sender: {} },
      { tabId: "tab-1", url: "http://localhost:3000/", isRestore: true }
    );

    expect(portalManager.markRestoring).toHaveBeenCalledWith("tab-1");
    expect(order).toEqual(["markRestoring", "createTab"]);
  });

  it("does not mark restoring when isRestore is absent or false", async () => {
    const handler = getHandler(CHANNELS.PORTAL_CREATE);

    await handler({ sender: {} }, { tabId: "tab-1", url: "http://localhost:3000/" });
    await handler(
      { sender: {} },
      { tabId: "tab-2", url: "http://localhost:3000/", isRestore: false }
    );

    expect(portalManager.markRestoring).not.toHaveBeenCalled();
    expect(portalManager.createTab).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid url before touching the session", async () => {
    const handler = getHandler(CHANNELS.PORTAL_CREATE);
    await expect(handler({ sender: {} }, { tabId: "tab-1" })).rejects.toThrow("Invalid url");
    expect(fromPartitionMock).not.toHaveBeenCalled();
    expect(portalManager.createTab).not.toHaveBeenCalled();
  });

  it("gives a window attached to a host its host's own portal session, never persist:portal", async () => {
    const dispose = setRemoteWebviewSrcGate(
      (id, src) => (id === 9 ? src.startsWith("http://localhost:5173/") : null),
      (id) => id === 9,
      (id) => (id === 9 ? "studio" : null)
    );
    try {
      const handler = getHandler(CHANNELS.PORTAL_CREATE);
      await handler({ sender: { id: 9 } }, { tabId: "tab-1", url: "http://localhost:5173/" });
      const partition = portalManager.createTab.mock.calls[0]![2]!;
      expect(partition).not.toBe("persist:portal");
      expect(partition.startsWith("persist:browser-remote__studio__")).toBe(true);
      // Its popups open outside only where the window's webviews may go.
      const { isPopupAllowed } = portalManager.createTab.mock.calls[0]![3] as unknown as {
        isPopupAllowed: (url: string) => boolean;
      };
      expect(isPopupAllowed("http://localhost:8080/admin")).toBe(false);
      expect(isPopupAllowed("http://localhost:5173/")).toBe(true);
      expect(isPopupAllowed("https://github.com/")).toBe(true);

      // A preview partition of this machine's (or another host's) isn't the host's to open.
      await handler(
        { sender: { id: 9 } },
        {
          tabId: "tab-2",
          url: "http://localhost:5173/",
          partition: "persist:dev-preview-proj-wt-p",
        }
      );
      expect(portalManager.createTab.mock.calls[1]![2]).toBe(partition);
      const own = "persist:dev-preview-remote__studio__p1-main-panel";
      await handler(
        { sender: { id: 9 } },
        { tabId: "tab-3", url: "http://localhost:5173/", partition: own }
      );
      expect(portalManager.createTab.mock.calls[2]![2]).toBe(own);
    } finally {
      dispose();
    }
  });
});
