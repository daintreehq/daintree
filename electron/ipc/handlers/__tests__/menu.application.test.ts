import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getApplicationMenu = vi.fn();

vi.mock("electron", () => ({
  Menu: {
    getApplicationMenu: () => getApplicationMenu(),
    buildFromTemplate: vi.fn(),
  },
}));

const getAppWebContents = vi.fn();
const isCachedViewWebContents = vi.fn();

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getAppWebContents: (...args: unknown[]) => getAppWebContents(...args),
  isCachedViewWebContents: (...args: unknown[]) => isCachedViewWebContents(...args),
}));

const { menuNamespace, resolveApplicationMenuAnchor } = await import("../menu.js");

const showApplication = menuNamespace.ops.showApplication.handler as (
  ctx: unknown,
  payload?: { x?: number; y?: number }
) => Promise<void>;

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

interface MenuStub {
  popup: ReturnType<typeof vi.fn>;
}

function makeMenu(): MenuStub {
  return { popup: vi.fn() };
}

function makeWindow(bounds = { x: 0, y: 0, width: 1000, height: 800 }) {
  return {
    isDestroyed: () => false,
    getContentBounds: () => bounds,
  };
}

function makeCtx(win: unknown, webContentsId = 7) {
  return { event: {}, webContentsId, senderWindow: win, projectId: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  setPlatform("win32");
  isCachedViewWebContents.mockReturnValue(false);
  getAppWebContents.mockReturnValue({ isDestroyed: () => false, getZoomFactor: () => 1 });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("resolveApplicationMenuAnchor", () => {
  const bounds = { width: 1000, height: 800 };

  it("scales the CSS-pixel anchor by the view's zoom factor", () => {
    expect(resolveApplicationMenuAnchor({ x: 100, y: 40 }, bounds, 1.5)).toEqual({
      x: 150,
      y: 60,
    });
  });

  it("clamps an anchor beyond the content area back inside it", () => {
    const anchor = resolveApplicationMenuAnchor({ x: 900, y: 700 }, bounds, 2);
    expect(anchor).toEqual({ x: bounds.width, y: bounds.height });
  });

  it("clamps a negative anchor to the content origin", () => {
    expect(resolveApplicationMenuAnchor({ x: -50, y: -10 }, bounds, 1)).toEqual({ x: 0, y: 0 });
  });

  it("rounds fractional device coordinates to integers", () => {
    const anchor = resolveApplicationMenuAnchor({ x: 10.4, y: 20.6 }, bounds, 1.1);
    expect(Number.isInteger(anchor!.x)).toBe(true);
    expect(Number.isInteger(anchor!.y)).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "treats an unusable zoom factor (%s) as 1x rather than collapsing the anchor",
    (zoom) => {
      expect(resolveApplicationMenuAnchor({ x: 120, y: 48 }, bounds, zoom)).toEqual({
        x: 120,
        y: 48,
      });
    }
  );

  it.each([
    ["a missing payload", undefined],
    ["a payload with no coordinates", {}],
    ["a partial payload", { x: 10 }],
    ["non-finite coordinates", { x: Number.NaN, y: 10 }],
    ["infinite coordinates", { x: 10, y: Number.POSITIVE_INFINITY }],
  ])("returns null for %s so main falls back to the cursor default", (_label, payload) => {
    expect(resolveApplicationMenuAnchor(payload, bounds, 1)).toBeNull();
  });
});

describe("menu:show-application", () => {
  it("pops up the exact installed menu object rather than a rebuilt template", async () => {
    const menu = makeMenu();
    getApplicationMenu.mockReturnValue(menu);
    const win = makeWindow();

    await showApplication(makeCtx(win), { x: 12, y: 48 });

    expect(menu.popup).toHaveBeenCalledTimes(1);
    expect(menu.popup.mock.calls[0]![0]).toMatchObject({ window: win });
  });

  it("re-resolves the current menu on every call, so a rebuild is picked up", async () => {
    const first = makeMenu();
    const second = makeMenu();
    const win = makeWindow();

    getApplicationMenu.mockReturnValue(first);
    await showApplication(makeCtx(win), { x: 0, y: 0 });

    // createApplicationMenu() installs a fresh Menu on project open, CLI
    // install, and recent-project removal.
    getApplicationMenu.mockReturnValue(second);
    await showApplication(makeCtx(win), { x: 0, y: 0 });

    expect(first.popup).toHaveBeenCalledTimes(1);
    expect(second.popup).toHaveBeenCalledTimes(1);
  });

  it("forwards the zoom-corrected anchor to popup", async () => {
    const menu = makeMenu();
    getApplicationMenu.mockReturnValue(menu);
    getAppWebContents.mockReturnValue({ isDestroyed: () => false, getZoomFactor: () => 2 });

    await showApplication(makeCtx(makeWindow()), { x: 30, y: 50 });

    expect(menu.popup.mock.calls[0]![0]).toMatchObject({ x: 60, y: 100 });
  });

  it("still opens the menu at the cursor when the anchor cannot be resolved", async () => {
    const menu = makeMenu();
    getApplicationMenu.mockReturnValue(menu);
    getAppWebContents.mockImplementation(() => {
      throw new Error("view detached");
    });

    await showApplication(makeCtx(makeWindow()), { x: 30, y: 50 });

    expect(menu.popup).toHaveBeenCalledTimes(1);
    const options = menu.popup.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).not.toHaveProperty("x");
    expect(options).not.toHaveProperty("y");
  });

  it("does nothing on macOS, which keeps its native system menu bar", async () => {
    setPlatform("darwin");
    const menu = makeMenu();
    getApplicationMenu.mockReturnValue(menu);

    await showApplication(makeCtx(makeWindow()), { x: 12, y: 48 });

    expect(menu.popup).not.toHaveBeenCalled();
  });

  it("does nothing for a backgrounded project view", async () => {
    const menu = makeMenu();
    getApplicationMenu.mockReturnValue(menu);
    isCachedViewWebContents.mockReturnValue(true);

    await showApplication(makeCtx(makeWindow()), { x: 12, y: 48 });

    expect(menu.popup).not.toHaveBeenCalled();
  });

  it("scopes the cached-view check to the calling view", async () => {
    getApplicationMenu.mockReturnValue(makeMenu());

    await showApplication(makeCtx(makeWindow(), 42), { x: 1, y: 1 });

    expect(isCachedViewWebContents).toHaveBeenCalledWith(42);
  });

  it.each([
    ["no owning window", null],
    ["a destroyed window", { isDestroyed: () => true, getContentBounds: () => ({}) }],
  ])("does nothing when the sender has %s", async (_label, win) => {
    const menu = makeMenu();
    getApplicationMenu.mockReturnValue(menu);

    await expect(showApplication(makeCtx(win), { x: 1, y: 1 })).resolves.toBeUndefined();
    expect(menu.popup).not.toHaveBeenCalled();
  });

  it("resolves without throwing when no application menu is installed", async () => {
    getApplicationMenu.mockReturnValue(null);

    await expect(showApplication(makeCtx(makeWindow()), { x: 1, y: 1 })).resolves.toBeUndefined();
  });
});
