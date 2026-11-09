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
  acknowledgePopOut,
  CANOPY_POP_OUT_TIMEOUT_MS,
  closeCanopyWindow,
  focusCanopyWindow,
  focusLastProjectWindow,
  isCanopyWindowView,
  openCanopyWindow,
  peekPendingPopOut,
  popOutToCanopyWindow,
  setCanopyBrowserWindowFactory,
} from "../canopyWindow.js";
import type { CanopyPopOut } from "../../../shared/types/ipc/canopy.js";
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
    webContents: EventEmitter & {
      id: number;
      send: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
    };
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
    webContents: Object.assign(new EventEmitter(), {
      id: 1000 + id,
      send: vi.fn(),
      isDestroyed: vi.fn(() => destroyed),
    }),
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

  it("knows its own view, and nothing else, as long as it stands", () => {
    expect(isCanopyWindowView(1001)).toBe(false);
    openCanopyWindow(noWatch);
    const win = made[0]!;

    expect(isCanopyWindowView(win.view.webContents.id)).toBe(true);
    expect(isCanopyWindowView(win.webContents.id)).toBe(false);

    closeCanopyWindow();
    expect(isCanopyWindowView(win.view.webContents.id)).toBe(false);
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

  describe("going back to a project window (#16578)", () => {
    /** A registered project window, focused as the user would focus it. */
    function projectWindow(focusing: EventEmitter): FakeWindow {
      const win = makeWindow();
      registry.register(win as unknown as BrowserWindow);
      focusing.emit("browser-window-focus", {}, win);
      return win;
    }

    it("brings forward the project window the user was last in, and leaves Canopy as it stands", () => {
      const app = new EventEmitter();
      registry.wireFocusTracking(app);
      const first = projectWindow(app);
      const second = projectWindow(app);
      openCanopyWindow(noWatch);
      const canopy = made.at(-1)!;
      // Back to the first before going to Canopy: the first is where the user was.
      app.emit("browser-window-focus", {}, first);
      canopy.focus.mockClear();
      canopy.show.mockClear();

      expect(focusLastProjectWindow()).toBe(true);

      expect(first.focus).toHaveBeenCalled();
      expect(second.focus).not.toHaveBeenCalled();
      expect(canopy.close).not.toHaveBeenCalled();
      expect(canopy.focus).not.toHaveBeenCalled();
      expect(canopy.show).not.toHaveBeenCalled();
      expect(focusCanopyWindow()).toBe(true);
    });

    it("restores a minimized project window as it brings it forward", () => {
      const app = new EventEmitter();
      registry.wireFocusTracking(app);
      const win = projectWindow(app);
      win.isMinimized.mockReturnValue(true);

      expect(focusLastProjectWindow()).toBe(true);

      expect(win.restore).toHaveBeenCalledTimes(1);
      expect(win.show).toHaveBeenCalledTimes(1);
      expect(win.focus).toHaveBeenCalledTimes(1);
    });

    it("takes a project window never focused when it is the only one open", () => {
      const win = makeWindow();
      registry.register(win as unknown as BrowserWindow);

      expect(focusLastProjectWindow()).toBe(true);
      expect(win.focus).toHaveBeenCalledTimes(1);
    });

    it("moves nothing with no project window open", () => {
      openCanopyWindow(noWatch);
      const canopy = made[0]!;

      expect(focusLastProjectWindow()).toBe(false);
      expect(canopy.close).not.toHaveBeenCalled();
      expect(focusCanopyWindow()).toBe(true);
    });

    it("moves nothing before the app has a window registry", () => {
      setWindowRegistry(null as unknown as WindowRegistry);
      expect(focusLastProjectWindow()).toBe(false);
    });
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

describe("popping a dialog out into the window (#16338)", () => {
  const place: CanopyPopOut = {
    hostId: "local",
    query: "deploy",
    selection: { kind: "worker", runId: "run-2" },
    roleFilter: "workers",
    unreadOnly: true,
    keptUnread: ["run-2"],
    archivedExpanded: true,
    trashExpanded: false,
    workOf: null,
  };

  /** Settles to "taken" or the refusal's words, without awaiting a pending one. */
  function outcome(promise: Promise<void>): { value: string | null } {
    const seen: { value: string | null } = { value: null };
    promise.then(
      () => (seen.value = "taken"),
      (error: { userMessage?: string }) => (seen.value = error.userMessage ?? "refused")
    );
    return seen;
  }

  afterEach(() => vi.useRealTimers());

  it("opens a new window with the place waiting, and settles once the window says it has it", async () => {
    const seen = outcome(popOutToCanopyWindow(place, noWatch));

    expect(made).toHaveLength(1);
    expect(loadRenderer).toHaveBeenCalledTimes(1);
    // A new window asks as it boots: nothing is pushed to a page not yet there.
    expect(made[0]!.view.webContents.send).not.toHaveBeenCalled();
    const pending = peekPendingPopOut();
    expect(pending?.popOut).toEqual(place);
    // Asking doesn't take it: a reload, or a second ask, still finds it.
    expect(peekPendingPopOut()?.id).toBe(pending!.id);
    // Another pop-out's answer settles nothing.
    expect(acknowledgePopOut(pending!.id + 1)).toBe(false);
    await Promise.resolve();
    expect(seen.value).toBeNull();
    expect(peekPendingPopOut()?.id).toBe(pending!.id);

    expect(acknowledgePopOut(pending!.id)).toBe(true);
    await Promise.resolve();
    expect(seen.value).toBe("taken");
    expect(peekPendingPopOut()).toBeNull();
    expect(acknowledgePopOut(pending!.id)).toBe(false);
  });

  it("brings a window already open forward and tells it, rather than opening another", async () => {
    openCanopyWindow(noWatch);
    const win = made[0]!;

    const seen = outcome(popOutToCanopyWindow(place, noWatch));

    expect(made).toHaveLength(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.view.webContents.send).toHaveBeenCalledWith("canopy-window:pop-out-waiting");
    acknowledgePopOut(peekPendingPopOut()!.id);
    await Promise.resolve();
    expect(seen.value).toBe("taken");
  });

  it("fails when the window closes before taking it, and nothing waits on", async () => {
    const seen = outcome(popOutToCanopyWindow(place, noWatch));

    closeCanopyWindow();
    await Promise.resolve();

    expect(seen.value).toMatch(/closed/);
    expect(peekPendingPopOut()).toBeNull();
  });

  it("fails when the window's page is gone before taking it", async () => {
    const seen = outcome(popOutToCanopyWindow(place, noWatch));

    made[0]!.view.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    await Promise.resolve();

    expect(seen.value).toMatch(/stopped/);
    expect(peekPendingPopOut()).toBeNull();
  });

  it("fails when the window never takes it up in time, and a late answer changes nothing", async () => {
    vi.useFakeTimers();
    const seen = outcome(popOutToCanopyWindow(place, noWatch));
    const id = peekPendingPopOut()!.id;

    await vi.advanceTimersByTimeAsync(CANOPY_POP_OUT_TIMEOUT_MS - 1);
    expect(seen.value).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(seen.value).toMatch(/in time/);
    expect(peekPendingPopOut()).toBeNull();
    expect(acknowledgePopOut(id)).toBe(false);
  });

  it("refuses a second pop-out while one is under way, keeping the first", async () => {
    const first = outcome(popOutToCanopyWindow(place, noWatch));
    const id = peekPendingPopOut()!.id;

    const second = outcome(popOutToCanopyWindow({ ...place, query: "other" }, noWatch));
    await Promise.resolve();

    expect(second.value).toMatch(/already/);
    expect(peekPendingPopOut()).toEqual({ id, popOut: place });
    acknowledgePopOut(id);
    await Promise.resolve();
    expect(first.value).toBe("taken");
  });
});

describe("a popped-out place across the window's own changes (#16338)", () => {
  const place: CanopyPopOut = {
    hostId: "local",
    query: "",
    selection: null,
    roleFilter: "all",
    unreadOnly: false,
    keptUnread: [],
    archivedExpanded: false,
    trashExpanded: false,
    workOf: null,
  };

  afterEach(() => vi.useRealTimers());

  it("lets no earlier pop-out's deadline fail the next", async () => {
    vi.useFakeTimers();
    const first = popOutToCanopyWindow(place, noWatch);
    acknowledgePopOut(peekPendingPopOut()!.id);
    await first;
    await vi.advanceTimersByTimeAsync(CANOPY_POP_OUT_TIMEOUT_MS / 2);
    let failed = false;
    popOutToCanopyWindow(place, noWatch).catch(() => (failed = true));

    await vi.advanceTimersByTimeAsync(CANOPY_POP_OUT_TIMEOUT_MS / 2 + 1);

    expect(failed).toBe(false);
    expect(peekPendingPopOut()).not.toBeNull();
  });

  /** A main-frame navigation to a new document: a reload. */
  const reload = (view: EventEmitter) =>
    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });

  it("takes no answer from a page reloaded since it took the place up: the new page asks again", async () => {
    let taken = false;
    void popOutToCanopyWindow(place, noWatch).then(() => (taken = true));
    const view = made[0]!.view.webContents;
    // The window's own first load is done before its page asks.
    reload(view);
    view.emit("did-stop-loading");
    const { id } = peekPendingPopOut()!;

    // The page that took it up is replaced before its answer lands, and while
    // it leaves it can't take the place up again either.
    reload(view);
    expect(peekPendingPopOut()).toBeNull();
    expect(acknowledgePopOut(id)).toBe(false);
    await Promise.resolve();
    expect(taken).toBe(false);

    // The new page is told once loading stops, and its answer counts.
    view.send.mockClear();
    view.emit("did-stop-loading");
    expect(view.send).toHaveBeenCalledWith("canopy-window:pop-out-waiting");
    expect(peekPendingPopOut()?.id).toBe(id);
    // A navigation within the page changes nothing.
    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(acknowledgePopOut(id)).toBe(true);
    await Promise.resolve();
    expect(taken).toBe(true);
  });

  it("keeps a page whose commit a second reload is queued behind from taking the place up", () => {
    void popOutToCanopyWindow(place, noWatch).catch(() => {});
    const view = made[0]!.view.webContents;

    reload(view);
    reload(view);
    // The first reload commits, or fails; the second still replaces that page.
    view.emit("did-navigate");
    view.emit("did-fail-load", {}, -3, "ERR_ABORTED", "app://", true);
    expect(peekPendingPopOut()).toBeNull();

    view.emit("did-stop-loading");
    expect(peekPendingPopOut()).not.toBeNull();
  });

  it("lets the page a cancelled reload left in place take the place up again", async () => {
    let taken = false;
    void popOutToCanopyWindow(place, noWatch).then(() => (taken = true));
    const view = made[0]!.view.webContents;
    const { id } = peekPendingPopOut()!;

    reload(view);
    expect(acknowledgePopOut(id)).toBe(false);
    view.send.mockClear();
    // Cancelled before it committed: loading stops with no failure reported.
    view.emit("did-stop-loading");

    expect(view.send).toHaveBeenCalledWith("canopy-window:pop-out-waiting");
    expect(peekPendingPopOut()?.id).toBe(id);
    expect(acknowledgePopOut(id)).toBe(true);
    await Promise.resolve();
    expect(taken).toBe(true);
  });

  it("lets a window replaced before its close was told fail nothing of the next one's", async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const watch = () => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    };
    openCanopyWindow(watch);
    const old = made[0]!;
    // Gone, but its closed event not yet delivered.
    old.isDestroyed.mockReturnValue(true);
    let failed = false;
    popOutToCanopyWindow(place, watch).catch(() => (failed = true));
    expect(made).toHaveLength(2);

    old.emit("closed");
    old.view.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    await Promise.resolve();

    expect(failed).toBe(false);
    expect(peekPendingPopOut()).not.toBeNull();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();
    expect(isCanopyWindowView(made[1]!.view.webContents.id)).toBe(true);
  });
});
