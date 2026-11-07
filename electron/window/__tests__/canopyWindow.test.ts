import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents, WebContentsView } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: class {} }));

const detachWebContents = vi.hoisted(() => vi.fn());
vi.mock("../../services/globalAssistant.js", () => ({
  peekGlobalAssistantService: () => ({ detachWebContents }),
}));
const setCanopyWindowOpen = vi.hoisted(() => vi.fn());
vi.mock("../openWindowsTracker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../openWindowsTracker.js")>()),
  setCanopyWindowOpen,
}));

import {
  closeCanopyWindow,
  focusCanopyWindow,
  openCanopyWindow,
  setCanopyBrowserWindowFactory,
} from "../canopyWindow.js";
import { WindowRegistry } from "../WindowRegistry.js";
import { setWindowRegistry } from "../windowRef.js";
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
  getContentBounds: ReturnType<typeof vi.fn>;
  contentView: EventEmitter;
  webContents: EventEmitter & { id: number };
  view: {
    webContents: EventEmitter & { id: number };
    setBounds: ReturnType<typeof vi.fn>;
    getBounds: ReturnType<typeof vi.fn>;
  };
};

let nextId = 1;
let made: FakeWindow[] = [];
/** The reveal mode each window was built with, in order. */
let reveals: string[] = [];
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
  win.getContentBounds = vi.fn(() => ({ x: 40, y: 40, width: 900, height: 700 }));
  win.contentView = new EventEmitter();
  win.webContents = Object.assign(new EventEmitter(), { id: 500 + id });
  win.view = {
    webContents: Object.assign(new EventEmitter(), { id: 1000 + id }),
    setBounds: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 900, height: 700 })),
  };
  win.close = vi.fn(() => {
    destroyed = true;
    win.emit("closed");
    win.view.webContents.emit("destroyed");
  });
  return win;
}

const noWatch = () => () => {};

beforeEach(() => {
  made = [];
  reveals = [];
  loadRenderer.mockClear();
  detachWebContents.mockClear();
  setCanopyWindowOpen.mockClear();
  setCanopyBrowserWindowFactory((revealMode) => {
    const win = makeWindow();
    made.push(win);
    reveals.push(revealMode);
    markProjectlessView(
      win.view.webContents as unknown as WebContents,
      win as unknown as BrowserWindow
    );
    return {
      win: win as unknown as BrowserWindow,
      appView: win.view as unknown as WebContentsView,
      loadRenderer,
    };
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

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each([
    "resize",
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
    "restore",
  ])("fills the window again on %s, with no view manager to do it", (event) => {
    openCanopyWindow(noWatch);
    made[0]!.getContentBounds.mockReturnValue({ x: 40, y: 40, width: 1400, height: 1000 });

    made[0]!.emit(event);

    expect(made[0]!.view.setBounds).toHaveBeenCalledTimes(1);
    expect(made[0]!.view.setBounds).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 1400,
      height: 1000,
    });
  });

  it.each([
    ["height", { width: 900, height: 670 }],
    ["width", { width: 870, height: 700 }],
  ])("grows back into %s the content area regains with no resize", (_label, size) => {
    openCanopyWindow(noWatch);
    made[0]!.view.getBounds.mockReturnValue({ x: 0, y: 0, ...size });

    made[0]!.contentView.emit("bounds-changed");

    expect(made[0]!.view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 900, height: 700 });
  });

  it.each([
    ["height", { width: 900, height: 670 }],
    ["width", { width: 870, height: 700 }],
  ])("stays full size while the content area loses %s, so the PTY keeps its size", (_l, size) => {
    openCanopyWindow(noWatch);
    made[0]!.getContentBounds.mockReturnValue({ x: 40, y: 40, ...size });

    made[0]!.contentView.emit("bounds-changed");

    expect(made[0]!.view.setBounds).not.toHaveBeenCalled();
  });

  it.each([
    ["closes", "destroyed", undefined],
    ["crashes", "render-process-gone", undefined],
    ["reloads", "did-start-navigation", { isMainFrame: true, isSameDocument: false }],
  ])("lets go of a docked global assistant when its view %s", async (_label, event, details) => {
    openCanopyWindow(noWatch);
    const view = made[0]!.view.webContents;

    view.emit(event, details);

    await vi.waitFor(() => expect(detachWebContents).toHaveBeenCalledWith(view.id));
  });

  it("keeps the global assistant through a navigation that isn't a new document", async () => {
    openCanopyWindow(noWatch);
    const view = made[0]!.view.webContents;

    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    view.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(detachWebContents).not.toHaveBeenCalled();
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

describe("the Canopy window across launches (#16336)", () => {
  it("is built to show and take focus when asked for", () => {
    openCanopyWindow(noWatch);
    expect(reveals).toEqual(["show"]);
  });

  it("is built behind the focused window when a launch restores it", () => {
    openCanopyWindow(noWatch, { revealMode: "showInactive" });
    expect(reveals).toEqual(["showInactive"]);
  });

  it("leaves a standing window where it is when a launch restores it", () => {
    openCanopyWindow(noWatch);
    openCanopyWindow(noWatch, { revealMode: "showInactive" });

    expect(made).toHaveLength(1);
    expect(made[0]!.show).not.toHaveBeenCalled();
    expect(made[0]!.focus).not.toHaveBeenCalled();
  });

  it("tells the manifest as it opens and as it closes, and not when brought forward", () => {
    openCanopyWindow(noWatch);
    openCanopyWindow(noWatch);
    expect(setCanopyWindowOpen.mock.calls).toEqual([[true]]);

    closeCanopyWindow();
    expect(setCanopyWindowOpen.mock.calls).toEqual([[true], [false]]);
  });

  it("is known to have stood this session once opened, closed or not", async () => {
    vi.resetModules();
    const fresh = await import("../canopyWindow.js");
    fresh.setCanopyBrowserWindowFactory(() => {
      const win = makeWindow();
      made.push(win);
      return {
        win: win as unknown as BrowserWindow,
        appView: win.view as unknown as WebContentsView,
        loadRenderer,
      };
    });

    expect(fresh.hasCanopyWindowOpenedThisSession()).toBe(false);
    fresh.openCanopyWindow(noWatch);
    expect(fresh.hasCanopyWindowOpenedThisSession()).toBe(true);
    fresh.closeCanopyWindow();
    expect(fresh.hasCanopyWindowOpenedThisSession()).toBe(true);
  });
});

describe("the Canopy window beside project targeting", () => {
  const openRequest = {
    projectId: "p1",
    projectPath: "/repo/p1",
    source: "restore",
    intent: "open",
    disposition: "default",
    initiatingWindowId: null,
  } as const;

  let registry: WindowRegistry;

  beforeEach(() => {
    registry = new WindowRegistry();
    setWindowRegistry(registry);
  });

  it("stays unlisted, so a folder opened with only it up makes a project window", () => {
    openCanopyWindow(noWatch);

    expect(registry.size).toBe(0);
    expect(registry.getPrimary()).toBeUndefined();
    const world = snapshotOpenWorld(registry, "default");
    expect(world.windows).toEqual([]);
    expect(decideProjectOpenTarget(openRequest, world)).toEqual({ kind: "create" });
    // Nothing to write down, so a launch has nothing to restore it as.
    expect(captureWindowRecord(registry, made[0]!.id)).toBeNull();
  });

  it("takes nothing from the project window open beside it", () => {
    const projectWindow = makeWindow();
    Object.assign(projectWindow, { isFocused: () => true });
    registry.register(projectWindow as unknown as BrowserWindow);

    openCanopyWindow(noWatch);
    openCanopyWindow(noWatch);

    expect(registry.getPrimary()?.windowId).toBe(projectWindow.id);
    expect(registry.all().map((ctx) => ctx.windowId)).toEqual([projectWindow.id]);
    expect(snapshotOpenWorld(registry, "default").windows.map((w) => w.windowId)).toEqual([
      projectWindow.id,
    ]);
  });

  it("holds no project binding, and forgets its view once the view is destroyed", () => {
    openCanopyWindow(noWatch);
    const viewId = made[0]!.view.webContents.id;

    expect(isProjectlessAppView(viewId)).toBe(true);
    expect(getProjectForWebContents(viewId)).toBeNull();

    closeCanopyWindow();
    expect(isProjectlessAppView(viewId)).toBe(false);
  });
});
