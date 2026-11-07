import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: class {} }));

import {
  closeCanopyWindow,
  focusCanopyWindow,
  openCanopyWindow,
  setCanopyBrowserWindowFactory,
} from "../canopyWindow.js";
import { WindowRegistry } from "../WindowRegistry.js";
import { snapshotOpenWorld } from "../windowOpenState.js";
import { decideProjectOpenTarget } from "../windowOpenPolicy.js";
import { isProjectlessAppView, markProjectlessView } from "../projectlessViews.js";
import { getProjectForWebContents } from "../webContentsRegistry.js";
import { captureWindowRecord } from "../openWindowsTracker.js";

type FakeWindow = EventEmitter & {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  isMinimized: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
  webContents: EventEmitter & { id: number };
};

let nextId = 1;
let made: FakeWindow[] = [];
const loadRenderer = vi.fn();

function makeWindow(): FakeWindow {
  let destroyed = false;
  const id = nextId++;
  const win = new EventEmitter() as FakeWindow;
  win.id = id;
  win.isDestroyed = vi.fn(() => destroyed);
  win.isMinimized = vi.fn(() => false);
  win.restore = vi.fn();
  win.show = vi.fn();
  win.focus = vi.fn();
  win.setTitle = vi.fn();
  win.webContents = Object.assign(new EventEmitter(), { id: 1000 + id });
  win.close = vi.fn(() => {
    destroyed = true;
    win.emit("closed");
    win.webContents.emit("destroyed");
  });
  return win;
}

const noWatch = () => () => {};

beforeEach(() => {
  made = [];
  loadRenderer.mockClear();
  setCanopyBrowserWindowFactory(() => {
    const win = makeWindow();
    made.push(win);
    markProjectlessView(win.webContents as unknown as WebContents, win as unknown as BrowserWindow);
    return { win: win as unknown as BrowserWindow, loadRenderer };
  });
});

afterEach(() => closeCanopyWindow());

describe("the Canopy window", () => {
  it("has nothing to focus until it is opened", () => {
    expect(focusCanopyWindow()).toBe(false);
  });

  it("opens once, and a second open brings the same window forward", () => {
    openCanopyWindow(noWatch);
    openCanopyWindow(noWatch);

    expect(made).toHaveLength(1);
    expect(loadRenderer).toHaveBeenCalledTimes(1);
    expect(made[0]!.focus).toHaveBeenCalledTimes(1);
  });

  it("comes back from the Dock when focused minimized", () => {
    openCanopyWindow(noWatch);
    made[0]!.isMinimized.mockReturnValue(true);

    expect(focusCanopyWindow()).toBe(true);
    expect(made[0]!.restore).toHaveBeenCalledTimes(1);
    expect(made[0]!.show).toHaveBeenCalledTimes(1);
    expect(made[0]!.focus).toHaveBeenCalledTimes(1);
  });

  it("is gone once closed: entry points get false, and an open makes a new one", () => {
    openCanopyWindow(noWatch);
    closeCanopyWindow();

    expect(focusCanopyWindow()).toBe(false);

    openCanopyWindow(noWatch);
    expect(made).toHaveLength(2);
    expect(focusCanopyWindow()).toBe(true);
    expect(made[0]!.focus).not.toHaveBeenCalled();
  });

  it("keeps its own title against the page's", () => {
    openCanopyWindow(noWatch);
    const preventDefault = vi.fn();
    made[0]!.emit("page-title-updated", { preventDefault });

    expect(made[0]!.setTitle).toHaveBeenCalledWith("Canopy");
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("watches Canopy's mode only while it stands, and closes when told to", () => {
    const stop = vi.fn();
    let closeWindow: () => void = () => {};
    const watch = vi.fn((close: () => void) => {
      closeWindow = close;
      return stop;
    });

    openCanopyWindow(watch);
    openCanopyWindow(watch);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    closeWindow();
    expect(made[0]!.close).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(focusCanopyWindow()).toBe(false);
  });

  it("refuses to open before boot has set it up", async () => {
    vi.resetModules();
    const fresh = await import("../canopyWindow.js");

    expect(() => fresh.openCanopyWindow(noWatch)).toThrow(/before the app set it up/);
  });
});

describe("the Canopy window beside project targeting", () => {
  it("is never listed, so a folder opened with only it up makes a project window", () => {
    const registry = new WindowRegistry();
    openCanopyWindow(noWatch);

    expect(registry.size).toBe(0);
    expect(registry.getPrimary()).toBeUndefined();

    const world = snapshotOpenWorld(registry, "default");
    expect(world.windows).toEqual([]);
    expect(
      decideProjectOpenTarget(
        {
          projectId: "p1",
          projectPath: "/repo/p1",
          source: "restore",
          intent: "open",
          disposition: "default",
          initiatingWindowId: null,
        },
        world
      )
    ).toEqual({ kind: "create" });
    // Nothing to write down, so a launch has nothing to restore it as.
    expect(captureWindowRecord(registry, made[0]!.id)).toBeNull();
  });

  it("marks its view as holding no project until the view is destroyed", () => {
    openCanopyWindow(noWatch);
    const viewId = made[0]!.webContents.id;

    expect(isProjectlessAppView(viewId)).toBe(true);
    expect(getProjectForWebContents(viewId)).toBeNull();

    closeCanopyWindow();
    expect(isProjectlessAppView(viewId)).toBe(false);
  });
});
