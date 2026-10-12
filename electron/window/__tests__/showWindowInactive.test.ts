import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  BrowserWindow: { getFocusedWindow: vi.fn<() => unknown>(() => null) },
}));
vi.mock("electron", () => electron);

import { showWindowInactive } from "../showWindowInactive.js";

const originalPlatform = process.platform;
const originalSessionType = process.env.XDG_SESSION_TYPE;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function webContentsMock(order: string[], name: string, focused: boolean) {
  return {
    isDestroyed: () => false,
    isFocused: () => focused,
    focus: vi.fn(() => order.push(`${name}.focus`)),
  };
}

function windowMock(
  order: string[],
  name: string,
  children: Array<{ webContents?: unknown }> = []
) {
  return {
    showInactive: vi.fn(() => order.push(`${name}.showInactive`)),
    focus: vi.fn(() => order.push(`${name}.focus`)),
    moveTop: vi.fn(() => order.push(`${name}.moveTop`)),
    isDestroyed: vi.fn(() => false),
    contentView: { children },
  };
}

afterEach(() => {
  setPlatform(originalPlatform);
  if (originalSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
  else process.env.XDG_SESSION_TYPE = originalSessionType;
  electron.BrowserWindow.getFocusedWindow.mockReset();
});

describe("showWindowInactive", () => {
  it("on X11 activates the window the user is in again after mapping the other one", () => {
    setPlatform("linux");
    process.env.XDG_SESSION_TYPE = "x11";
    const order: string[] = [];
    const terminalView = webContentsMock(order, "projectView", true);
    const focused = windowMock(order, "focused", [
      { webContents: webContentsMock(order, "browserPanel", false) },
      { webContents: terminalView },
    ]);
    electron.BrowserWindow.getFocusedWindow.mockReturnValue(focused);

    showWindowInactive(windowMock(order, "background") as never);

    // Through the view holding keyboard focus, so typing stays where it was.
    expect(order).toEqual(["background.showInactive", "projectView.focus"]);
    expect(focused.moveTop).not.toHaveBeenCalled();
  });

  it("activates the window itself when nothing inside it holds keyboard focus", () => {
    setPlatform("linux");
    delete process.env.XDG_SESSION_TYPE;
    const order: string[] = [];
    const focused = windowMock(order, "focused", [
      { webContents: webContentsMock(order, "projectView", false) },
      {},
    ]);
    electron.BrowserWindow.getFocusedWindow.mockReturnValue(focused);

    showWindowInactive(windowMock(order, "background") as never);

    expect(order).toEqual(["background.showInactive", "focused.focus"]);
  });

  it("activates nothing when no Daintree window has focus, or the mapped one does", () => {
    setPlatform("linux");
    process.env.XDG_SESSION_TYPE = "x11";
    const order: string[] = [];
    showWindowInactive(windowMock(order, "background") as never);

    const self = windowMock(order, "self");
    electron.BrowserWindow.getFocusedWindow.mockReturnValue(self);
    showWindowInactive(self as never);

    expect(order).toEqual(["background.showInactive", "self.showInactive"]);
  });

  it("leaves stacking to a Wayland compositor", () => {
    setPlatform("linux");
    process.env.XDG_SESSION_TYPE = "wayland";
    const order: string[] = [];
    electron.BrowserWindow.getFocusedWindow.mockReturnValue(windowMock(order, "focused"));

    showWindowInactive(windowMock(order, "background") as never);

    expect(order).toEqual(["background.showInactive"]);
  });

  it("leaves stacking to the OS on macOS and Windows", () => {
    for (const platform of ["darwin", "win32"] as const) {
      setPlatform(platform);
      const order: string[] = [];
      electron.BrowserWindow.getFocusedWindow.mockReturnValue(windowMock(order, "focused"));

      showWindowInactive(windowMock(order, "background") as never);

      expect(order).toEqual(["background.showInactive"]);
    }
  });
});
