import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({ get: vi.fn(() => ({}) as unknown) }));
vi.mock("../../store.js", () => ({ store: storeMock }));

import type { WebContents } from "electron";
import { CHANNELS } from "../../ipc/channels.js";
import { resetRendererOwnedAccelerators } from "../../services/menuAccelerators.js";
import { gateAppViewKey } from "../appViewKeyGate.js";

const realPlatform = process.platform;

function setProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function input(overrides: Partial<Electron.Input>): Electron.Input {
  return {
    type: "keyDown",
    key: "",
    code: "",
    alt: false,
    control: false,
    meta: false,
    shift: false,
    isAutoRepeat: false,
    isComposing: false,
    location: 0,
    modifiers: [],
    ...overrides,
  } as unknown as Electron.Input;
}

function view() {
  const setIgnoreMenuShortcuts = vi.fn();
  const send = vi.fn();
  return {
    webContents: { setIgnoreMenuShortcuts, send } as unknown as WebContents,
    setIgnoreMenuShortcuts,
    send,
  };
}

function press(webContents: WebContents, overrides: Partial<Electron.Input>) {
  const event = { preventDefault: vi.fn() } as unknown as Electron.Event;
  gateAppViewKey(webContents, event, input(overrides));
  return event;
}

beforeEach(() => {
  storeMock.get.mockReturnValue({});
  resetRendererOwnedAccelerators();
});

afterEach(() => {
  setProcessPlatform(realPlatform);
});

// The Canopy window's app view goes through this gate like every other, so its
// renderer hears Cmd+W: the agent pane's terminal takes it, or the list closes
// the window (#16618). The menu item and the OS control still close it.
describe("gateAppViewKey", () => {
  it("hands Cmd+W to the renderer for that keystroke only, on macOS", () => {
    setProcessPlatform("darwin");
    const app = view();

    const close = press(app.webContents, { key: "w", meta: true });
    press(app.webContents, { type: "keyUp", key: "w", meta: true });
    press(app.webContents, { key: "c", meta: true });

    expect(app.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false], [false]]);
    expect(close.preventDefault).not.toHaveBeenCalled();
    expect(app.send).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"] as const)("hands Ctrl+W to the renderer on %s", (os) => {
    setProcessPlatform(os);
    const app = view();

    press(app.webContents, { key: "w", control: true });
    press(app.webContents, { key: "w", meta: true });

    expect(app.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
  });

  it("sends the terminal cycle keys to the renderer as menu actions, leaving the menu be", () => {
    setProcessPlatform("darwin");
    const app = view();

    const cycle = press(app.webContents, { key: "Tab", code: "Tab", control: true });

    expect(cycle.preventDefault).toHaveBeenCalledTimes(1);
    expect(app.send).toHaveBeenCalledWith(
      CHANNELS.MENU_ACTION,
      expect.objectContaining({ actionId: "terminal.focusNext" })
    );
    expect(app.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });
});
