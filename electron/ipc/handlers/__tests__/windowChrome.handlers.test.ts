import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const registryMock = vi.hoisted(() => ({
  getWindowForWebContents: vi.fn(),
  getProjectForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(),
  hasRegisteredProjectViews: vi.fn(() => false),
  isCachedViewWebContents: vi.fn(() => false),
}));

const overlayMock = vi.hoisted(() => ({ setTitleBarOverlayBannerSeverity: vi.fn() }));

vi.mock("electron", () => ({ ipcMain: ipcMainMock, BrowserWindow: class {} }));
vi.mock("../../../window/webContentsRegistry.js", () => registryMock);
vi.mock("../../../window/titleBarOverlay.js", () => overlayMock);

import { registerWindowChromeHandlers } from "../windowChrome.js";
import { WINDOW_CHROME_METHOD_CHANNELS } from "../windowChrome.preload.js";
import type { HandlerDependencies } from "../../types.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(): Handler {
  const fn = ipcHandlers.get(WINDOW_CHROME_METHOD_CHANNELS.setBannerSeverity);
  if (!fn) throw new Error("windowChrome.setBannerSeverity handler not registered");
  return fn as Handler;
}

function makeWindow(destroyed = false) {
  return { isDestroyed: () => destroyed };
}

function eventFrom(id = 1): Electron.IpcMainInvokeEvent {
  return { sender: { id } as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

/**
 * Issue #11766. A renderer report may only recolour the chrome of the window it
 * came from, and only for severities the banner scale actually defines.
 */
describe("windowChrome IPC", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    registryMock.getWindowForWebContents.mockReturnValue(makeWindow());
    cleanup = registerWindowChromeHandlers({} as HandlerDependencies);
  });

  afterEach(() => cleanup());

  it("forwards a severity to the sender's own window", async () => {
    const win = makeWindow();
    registryMock.getWindowForWebContents.mockReturnValue(win);

    await getHandler()(eventFrom(), { severity: "warning" });

    expect(overlayMock.setTitleBarOverlayBannerSeverity).toHaveBeenCalledWith(win, "warning");
  });

  it("forwards a null severity when the banner leaves the band", async () => {
    await getHandler()(eventFrom(), { severity: null });

    expect(overlayMock.setTitleBarOverlayBannerSeverity).toHaveBeenCalledWith(
      expect.anything(),
      null
    );
  });

  it("routes each sender to its own window, never a sibling's", async () => {
    const first = makeWindow();
    const second = makeWindow();

    registryMock.getWindowForWebContents.mockReturnValueOnce(first);
    await getHandler()(eventFrom(1), { severity: "error" });
    registryMock.getWindowForWebContents.mockReturnValueOnce(second);
    await getHandler()(eventFrom(2), { severity: "info" });

    expect(overlayMock.setTitleBarOverlayBannerSeverity).toHaveBeenNthCalledWith(1, first, "error");
    expect(overlayMock.setTitleBarOverlayBannerSeverity).toHaveBeenNthCalledWith(2, second, "info");
  });

  it("ignores a report whose sender has no resolvable window", async () => {
    registryMock.getWindowForWebContents.mockReturnValue(null);

    await getHandler()(eventFrom(), { severity: "warning" });

    expect(overlayMock.setTitleBarOverlayBannerSeverity).not.toHaveBeenCalled();
  });

  it("ignores a report arriving after its window was destroyed", async () => {
    registryMock.getWindowForWebContents.mockReturnValue(makeWindow(true));

    await getHandler()(eventFrom(), { severity: "warning" });

    expect(overlayMock.setTitleBarOverlayBannerSeverity).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown severity", { severity: "catastrophic" }],
    ["a non-string severity", { severity: 3 }],
    ["a missing severity key", {}],
    ["a bare string instead of a payload", "warning"],
    ["no payload at all", undefined],
  ])("rejects %s without touching the native overlay", async (_label, payload) => {
    await expect(getHandler()(eventFrom(), payload)).rejects.toThrow();

    expect(overlayMock.setTitleBarOverlayBannerSeverity).not.toHaveBeenCalled();
  });
});
