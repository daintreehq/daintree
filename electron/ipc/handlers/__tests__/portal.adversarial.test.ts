import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SenderShape = {
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
  send: ReturnType<typeof vi.fn<(channel: string, payload: unknown) => void>>;
};

type WindowShape = {
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
  webContents: {
    isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
    send: ReturnType<typeof vi.fn<(channel: string, payload: string) => void>>;
  };
};

type HandlerShape = (event: { sender: SenderShape }, payload: unknown) => Promise<unknown>;

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: HandlerShape) => void>(),
  removeHandler: vi.fn<(channel: string) => void>(),
}));
const getWindowForWebContentsMock = vi.hoisted(() =>
  vi.fn<(sender: SenderShape) => WindowShape | null>()
);
const getAppWebContentsMock = vi.hoisted(() =>
  vi.fn<(win: WindowShape) => WindowShape["webContents"]>()
);

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: getWindowForWebContentsMock,
  getAppWebContents: getAppWebContentsMock,
  getProjectForWebContents: vi.fn(() => null),
}));

import { CHANNELS } from "../../channels.js";
import { registerPortalHandlers } from "../portal.js";

function getHandler(channel: string): HandlerShape {
  const call = ipcMainMock.handle.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel
  );
  if (!call) {
    throw new Error(`Missing handler for ${channel}`);
  }
  return call[1];
}

function createSender(): SenderShape {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  };
}

function createWindow(): WindowShape {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
}

function createPortalManager() {
  return {
    createTab: vi.fn<(tabId: string, url: string) => void>(),
    showTab:
      vi.fn<
        (tabId: string, bounds: { x: number; y: number; width: number; height: number }) => void
      >(),
    hideAll: vi.fn<() => void>(),
    updateBounds:
      vi.fn<(bounds: { x: number; y: number; width: number; height: number }) => void>(),
    closeTab: vi.fn<(tabId: string) => Promise<void>>(),
    navigate: vi.fn<(tabId: string, url: string) => void>(),
    goBack: vi.fn<(tabId: string) => boolean>(),
    goForward: vi.fn<(tabId: string) => boolean>(),
    reload: vi.fn<(tabId: string) => void>(),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("registerPortalHandlers adversarial", () => {
  let cleanup: (() => void) | null = null;
  let portalManager: ReturnType<typeof createPortalManager>;
  let sender: SenderShape;
  let win: WindowShape;

  beforeEach(() => {
    vi.clearAllMocks();
    portalManager = createPortalManager();
    sender = createSender();
    win = createWindow();
    getWindowForWebContentsMock.mockReturnValue(win);
    getAppWebContentsMock.mockReturnValue(win.webContents);
    cleanup = registerPortalHandlers({ portalManager } as never);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("removes handlers exactly once even if close settles after cleanup", async () => {
    const closeDeferred = deferred<void>();
    portalManager.closeTab.mockReturnValue(closeDeferred.promise);
    const handler = getHandler(CHANNELS.PORTAL_CLOSE_TAB);

    const pending = handler({ sender }, { tabId: "tab-1" });

    cleanup?.();
    cleanup = null;

    const removeCallsAfterCleanup = ipcMainMock.removeHandler.mock.calls.length;
    closeDeferred.resolve();
    await pending;

    expect(ipcMainMock.removeHandler.mock.calls.length).toBe(removeCallsAfterCleanup);
    expect(new Set(ipcMainMock.removeHandler.mock.calls.map(([channel]) => channel)).size).toBe(
      removeCallsAfterCleanup
    );
  });

  it("rejects malformed bounds instead of forwarding them to the manager", async () => {
    const showHandler = getHandler(CHANNELS.PORTAL_SHOW);
    const resizeHandler = getHandler(CHANNELS.PORTAL_RESIZE);

    await expect(
      showHandler(
        { sender },
        {
          tabId: "tab-1",
          bounds: { x: Number.NaN, y: 0, width: "100", height: 20 },
        }
      )
    ).rejects.toThrow("Invalid bounds");

    await expect(
      resizeHandler(
        { sender },
        {
          x: 0,
          y: 0,
          width: 100,
        }
      )
    ).rejects.toThrow("Invalid bounds");

    expect(portalManager.showTab).not.toHaveBeenCalled();
    expect(portalManager.updateBounds).not.toHaveBeenCalled();
  });
});
