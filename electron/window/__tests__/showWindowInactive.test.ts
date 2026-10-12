import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  BrowserWindow: { getFocusedWindow: vi.fn<() => unknown>(() => null) },
}));
vi.mock("electron", () => electron);

import { showWindowInactive } from "../showWindowInactive.js";

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function windowMock(order: string[], name: string) {
  return {
    showInactive: vi.fn(() => order.push(`${name}.showInactive`)),
    moveTop: vi.fn(() => order.push(`${name}.moveTop`)),
    isDestroyed: vi.fn(() => false),
  };
}

afterEach(() => {
  setPlatform(originalPlatform);
  electron.BrowserWindow.getFocusedWindow.mockReset();
});

describe("showWindowInactive", () => {
  it("on Linux puts the window the user is in back above the one it just mapped", () => {
    setPlatform("linux");
    const order: string[] = [];
    const focused = windowMock(order, "focused");
    const background = windowMock(order, "background");
    electron.BrowserWindow.getFocusedWindow.mockReturnValue(focused);

    showWindowInactive(background as never);

    expect(order).toEqual(["background.showInactive", "focused.moveTop"]);
  });

  it("restacks nothing when no Daintree window has focus", () => {
    setPlatform("linux");
    const order: string[] = [];
    const background = windowMock(order, "background");

    showWindowInactive(background as never);

    expect(order).toEqual(["background.showInactive"]);
  });

  it("leaves stacking to the OS on macOS and Windows", () => {
    for (const platform of ["darwin", "win32"] as const) {
      setPlatform(platform);
      const order: string[] = [];
      const focused = windowMock(order, "focused");
      electron.BrowserWindow.getFocusedWindow.mockReturnValue(focused);

      showWindowInactive(windowMock(order, "background") as never);

      expect(focused.moveTop).not.toHaveBeenCalled();
    }
  });
});
