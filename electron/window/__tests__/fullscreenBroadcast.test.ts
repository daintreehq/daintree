import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";

const registryMock = vi.hoisted(() => ({ views: [] as WebContents[] }));
const utilsMock = vi.hoisted(() => ({ withheld: new Set<number>() }));

vi.mock("../webContentsRegistry.js", () => ({
  getWindowAppWebContents: () => registryMock.views,
}));

vi.mock("../../ipc/utils.js", () => ({
  isWithheldFromView: (id: number) => utilsMock.withheld.has(id),
}));

import { sendFullscreenChange } from "../fullscreenBroadcast.js";
import { CHANNELS } from "../../ipc/channels.js";

function view(id: number, send = vi.fn()): WebContents {
  return { id, send } as unknown as WebContents;
}

function windowWith(destroyed = false): BrowserWindow {
  return { isDestroyed: () => destroyed } as unknown as BrowserWindow;
}

beforeEach(() => {
  registryMock.views = [];
  utilsMock.withheld.clear();
});

describe("sendFullscreenChange", () => {
  it("tells every view in the window, the cached ones as well as the one in front", () => {
    const shown = view(1);
    const cached = view(2);
    registryMock.views = [shown, cached];

    sendFullscreenChange(windowWith(), true);

    for (const wc of [shown, cached]) {
      expect(wc.send).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
        name: "window:fullscreen-change",
        payload: true,
      });
    }
  });

  it("keeps the push from a view bound to another host", () => {
    const local = view(1);
    const remote = view(2);
    registryMock.views = [local, remote];
    utilsMock.withheld.add(2);

    sendFullscreenChange(windowWith(), false);

    expect(local.send).toHaveBeenCalledOnce();
    expect(remote.send).not.toHaveBeenCalled();
  });

  it("still reaches the rest when one view's send throws", () => {
    const closing = view(
      1,
      vi.fn(() => {
        throw new Error("disposed");
      })
    );
    const next = view(2);
    registryMock.views = [closing, next];

    expect(() => sendFullscreenChange(windowWith(), true)).not.toThrow();
    expect(next.send).toHaveBeenCalledOnce();
  });

  it("sends nothing for a destroyed window", () => {
    const only = view(1);
    registryMock.views = [only];

    sendFullscreenChange(windowWith(true), true);

    expect(only.send).not.toHaveBeenCalled();
  });
});
