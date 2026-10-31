import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface InstalledItem {
  label: string;
  checked: boolean;
  visible: boolean;
}

const installed = vi.hoisted(() => new Map<string, InstalledItem>());
const getApplicationMenu = vi.hoisted(() => vi.fn<() => unknown>());

vi.mock("electron", () => ({
  Menu: { getApplicationMenu: () => getApplicationMenu() },
}));

const windowRefMock = vi.hoisted(() => ({
  getWindowRegistry: vi.fn<() => unknown>(() => null),
}));
vi.mock("../window/windowRef.js", () => windowRefMock);

const revealWindow = vi.hoisted(() => vi.fn());
vi.mock("../window/projectOwnership.js", () => ({ revealWindow }));

import {
  buildOpenWindowMenuItems,
  isOpenWindowMenuStale,
  noteWindowClosing,
  refreshOpenWindowMenu,
} from "../windowMenuState.js";

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

interface FakeWindow {
  id: number;
  title: string;
  destroyed: boolean;
  isDestroyed: () => boolean;
  getTitle: () => string;
}

function makeWindow(id: number, title: string): FakeWindow {
  const win: FakeWindow = {
    id,
    title,
    destroyed: false,
    isDestroyed: () => win.destroyed,
    getTitle: () => win.title,
  };
  return win;
}

/** Registration order, primary, and unregistering, as WindowRegistry keeps them. */
function useRegistry(windows: FakeWindow[], primary: FakeWindow | null = windows[0] ?? null) {
  const state = { windows: [...windows], primary };
  const ctxFor = (win: FakeWindow) => ({ windowId: win.id, browserWindow: win });
  windowRefMock.getWindowRegistry.mockReturnValue({
    all: () => state.windows.map(ctxFor),
    getPrimary: () => (state.primary ? ctxFor(state.primary) : undefined),
    getByWindowId: (id: number) => {
      const win = state.windows.find((w) => w.id === id);
      return win ? ctxFor(win) : undefined;
    },
  });
  return state;
}

/** Build the list and install it the way Menu.buildFromTemplate would. */
function buildAndInstall(): Electron.MenuItemConstructorOptions[] {
  const items = buildOpenWindowMenuItems();
  installed.clear();
  for (const item of items) {
    if (!item.id) continue;
    installed.set(item.id, {
      label: item.label ?? "",
      checked: item.checked ?? false,
      visible: item.visible ?? true,
    });
  }
  return items;
}

function windowItems(items: Electron.MenuItemConstructorOptions[]) {
  return items.filter((item) => item.type === "checkbox");
}

function visibleLabels(): string[] {
  return [...installed.values()].filter((item) => item.visible).map((item) => item.label);
}

function checkedLabels(): string[] {
  return [...installed.values()].filter((item) => item.checked).map((item) => item.label);
}

function clickItem(items: Electron.MenuItemConstructorOptions[], label: string): void {
  const item = windowItems(items).find((i) => i.label === label);
  if (!item?.click || !item.id) throw new Error(`No window item labelled "${label}"`);
  // Electron flips a checkbox item's mark before running its click handler.
  const live = installed.get(item.id)!;
  live.checked = !live.checked;
  item.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
}

beforeEach(() => {
  vi.clearAllMocks();
  setPlatform("win32");
  installed.clear();
  getApplicationMenu.mockReturnValue({
    getMenuItemById: (id: string) => installed.get(id) ?? null,
  });
  windowRefMock.getWindowRegistry.mockReturnValue(null);
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe("buildOpenWindowMenuItems", () => {
  it.each(["win32", "linux"] as const)(
    "on %s lists every window by its title in the order they opened, the current one checked",
    (platform) => {
      setPlatform(platform);
      const picker = makeWindow(4, "Daintree");
      const app = makeWindow(2, "(2) daintree — build-box");
      const site = makeWindow(9, "website");
      useRegistry([picker, app, site], app);

      const items = buildOpenWindowMenuItems();

      expect(items[0]?.type).toBe("separator");
      expect(windowItems(items).map((i) => [i.label, i.checked])).toEqual([
        ["Daintree", false],
        ["(2) daintree — build-box", true],
        ["website", false],
      ]);
      expect(items).toHaveLength(4);
    }
  );

  it("lists a lone window too", () => {
    useRegistry([makeWindow(1, "daintree")]);

    expect(windowItems(buildOpenWindowMenuItems()).map((i) => i.label)).toEqual(["daintree"]);
  });

  it("keeps a literal ampersand instead of letting it become a mnemonic", () => {
    useRegistry([makeWindow(1, "R&D & ops")]);

    expect(windowItems(buildOpenWindowMenuItems())[0]?.label).toBe("R&&D && ops");
  });

  it("adds nothing, not even a separator, when no window is open", () => {
    useRegistry([]);
    expect(buildOpenWindowMenuItems()).toEqual([]);

    windowRefMock.getWindowRegistry.mockReturnValue(null);
    expect(buildOpenWindowMenuItems()).toEqual([]);
  });

  it("leaves out a destroyed window and one that is closing", () => {
    const kept = makeWindow(1, "kept");
    const destroyed = makeWindow(2, "destroyed");
    const closing = makeWindow(3, "closing");
    destroyed.destroyed = true;
    useRegistry([kept, destroyed, closing]);
    noteWindowClosing(
      closing as unknown as Electron.BrowserWindow,
      { defaultPrevented: false } as Electron.Event
    );

    expect(windowItems(buildOpenWindowMenuItems()).map((i) => i.label)).toEqual(["kept"]);
  });

  it("lists nothing on macOS, where AppKit lists the windows itself", () => {
    setPlatform("darwin");
    useRegistry([makeWindow(1, "daintree"), makeWindow(2, "website")]);

    expect(buildOpenWindowMenuItems()).toEqual([]);
  });
});

describe("isOpenWindowMenuStale", () => {
  it("is stale once a window opens or closes, and not for a title or focus change", () => {
    const a = makeWindow(1, "a");
    const b = makeWindow(2, "b");
    const registry = useRegistry([a, b]);
    buildOpenWindowMenuItems();
    expect(isOpenWindowMenuStale()).toBe(false);

    a.title = "(1) a";
    registry.primary = b;
    expect(isOpenWindowMenuStale()).toBe(false);

    registry.windows.push(makeWindow(3, "c"));
    expect(isOpenWindowMenuStale()).toBe(true);
    buildOpenWindowMenuItems();
    expect(isOpenWindowMenuStale()).toBe(false);

    registry.windows = registry.windows.filter((w) => w !== b);
    expect(isOpenWindowMenuStale()).toBe(true);
  });

  it("is stale as soon as a listed window starts closing", () => {
    const a = makeWindow(1, "a");
    const b = makeWindow(2, "b");
    useRegistry([a, b]);
    buildOpenWindowMenuItems();

    noteWindowClosing(
      b as unknown as Electron.BrowserWindow,
      {
        defaultPrevented: false,
      } as Electron.Event
    );

    expect(isOpenWindowMenuStale()).toBe(true);
  });

  it("is never stale on macOS", () => {
    setPlatform("darwin");
    const registry = useRegistry([makeWindow(1, "a")]);
    buildOpenWindowMenuItems();
    registry.windows.push(makeWindow(2, "b"));

    expect(isOpenWindowMenuStale()).toBe(false);
  });
});

describe("refreshOpenWindowMenu", () => {
  it("renames items and moves the mark in place as titles and focus change", () => {
    const a = makeWindow(1, "a");
    const b = makeWindow(2, "b");
    const registry = useRegistry([a, b], a);
    buildAndInstall();

    a.title = "(3) a";
    b.title = "Tom & Jerry";
    registry.primary = b;
    refreshOpenWindowMenu();

    expect(visibleLabels()).toEqual(["(3) a", "Tom && Jerry"]);
    expect(checkedLabels()).toEqual(["Tom && Jerry"]);
  });

  it("hides a window that closed until the next rebuild drops it", () => {
    const a = makeWindow(1, "a");
    const b = makeWindow(2, "b");
    const registry = useRegistry([a, b], b);
    buildAndInstall();

    registry.windows = [a];
    registry.primary = a;
    refreshOpenWindowMenu();

    expect(visibleLabels()).toEqual(["a"]);
    expect(checkedLabels()).toEqual(["a"]);
  });

  it("never throws out of a title write or focus change", () => {
    useRegistry([makeWindow(1, "a")]);
    buildAndInstall();
    getApplicationMenu.mockImplementation(() => {
      throw new Error("menu torn down");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => refreshOpenWindowMenu()).not.toThrow();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does nothing on macOS", () => {
    setPlatform("darwin");
    useRegistry([makeWindow(1, "a")]);
    buildAndInstall();

    refreshOpenWindowMenu();

    expect(getApplicationMenu).not.toHaveBeenCalled();
  });
});

describe("noteWindowClosing", () => {
  it("hides the window from the moment it starts closing", () => {
    const a = makeWindow(1, "a");
    const b = makeWindow(2, "b");
    useRegistry([a, b], b);
    buildAndInstall();

    noteWindowClosing(
      b as unknown as Electron.BrowserWindow,
      {
        defaultPrevented: false,
      } as Electron.Event
    );

    expect(visibleLabels()).toEqual(["a"]);
    expect(checkedLabels()).toEqual([]);
  });

  it("puts a window back when another close listener vetoes the close", async () => {
    const a = makeWindow(1, "a");
    const b = makeWindow(2, "b");
    useRegistry([a, b], b);
    buildAndInstall();
    const event = { defaultPrevented: false };

    noteWindowClosing(b as unknown as Electron.BrowserWindow, event as Electron.Event);
    // A listener registered after this one calls preventDefault().
    event.defaultPrevented = true;
    expect(visibleLabels()).toEqual(["a"]);
    await Promise.resolve();

    expect(visibleLabels()).toEqual(["a", "b"]);
    expect(checkedLabels()).toEqual(["b"]);
    expect(isOpenWindowMenuStale()).toBe(false);
  });
});

describe("choosing a window", () => {
  it("reveals that window", () => {
    const a = makeWindow(1, "a");
    const b = makeWindow(2, "b");
    useRegistry([a, b], a);
    const items = buildAndInstall();

    clickItem(items, "b");

    expect(revealWindow).toHaveBeenCalledExactlyOnceWith(b);
  });

  it("keeps the current window checked when it is chosen again", () => {
    const a = makeWindow(1, "a");
    useRegistry([a, makeWindow(2, "b")], a);
    const items = buildAndInstall();

    clickItem(items, "a");

    expect(checkedLabels()).toEqual(["a"]);
  });

  it("does not reveal a window that closed after the menu was built", () => {
    const a = makeWindow(1, "a");
    const b = makeWindow(2, "b");
    const registry = useRegistry([a, b], a);
    const items = buildAndInstall();

    registry.windows = [a];
    clickItem(items, "b");

    expect(revealWindow).not.toHaveBeenCalled();
    expect(checkedLabels()).toEqual(["a"]);
  });
});
