import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANOPY_BOUNDS_KEY } from "../window/windowBoundsKeys.js";

type Rect = { x: number; y: number; width: number; height: number };
type Display = { id: number; bounds: Rect; workArea: Rect };

const fakes = vi.hoisted(() => {
  const store = {
    state: {} as Record<string, unknown>,
    // electron-store hands out a copy: only what goes back through `set` is stored.
    get: (_key: string) => structuredClone(store.state),
    set: (_key: string, value: Record<string, unknown>) => {
      store.state = structuredClone(value);
    },
  };

  const overlap = (a: Rect, b: Rect) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const distance = (a: Rect, b: Rect) =>
    Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));

  const screen = {
    displays: [] as Display[],
    getAllDisplays: () => structuredClone(screen.displays),
    getPrimaryDisplay: () => structuredClone(screen.displays[0]),
    // Electron's: the display the rectangle overlaps most, else the nearest one.
    getDisplayMatching: (rect: Rect) => {
      let best = screen.displays[0];
      let bestOverlap = -1;
      for (const display of screen.displays) {
        const area = overlap(rect, display.bounds);
        if (area > bestOverlap) {
          best = display;
          bestOverlap = area;
        }
      }
      if (bestOverlap > 0) return structuredClone(best);
      const nearest = [...screen.displays].sort(
        (a, b) => distance(rect, a.bounds) - distance(rect, b.bounds)
      )[0];
      return structuredClone(nearest);
    },
  };

  /**
   * A window with a normal frame and, when maximized or full screen, the frame
   * it actually has. As on macOS, a zoom can put that frame on another display
   * than the normal one ("Move to iPad").
   */
  class FakeWindow {
    static created: FakeWindow[] = [];
    normal: Rect;
    frame: Rect | null = null;
    maximized = false;
    fullScreen = false;
    destroyed = false;
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(public readonly options: Record<string, unknown>) {
      this.normal = {
        x: (options.x as number | undefined) ?? 0,
        y: (options.y as number | undefined) ?? 0,
        width: options.width as number,
        height: options.height as number,
      };
      FakeWindow.created.push(this);
    }

    getBounds = () => ({ ...(this.frame ?? this.normal) });
    getNormalBounds = () => ({ ...this.normal });
    setBounds = vi.fn((next: Rect) => {
      this.normal = { ...next };
    });
    setSize = vi.fn((width: number, height: number) => {
      this.normal = { ...this.normal, width, height };
    });
    center = vi.fn(() => {
      const { workArea } = screen.getDisplayMatching(this.normal);
      this.normal = {
        ...this.normal,
        x: Math.round(workArea.x + (workArea.width - this.normal.width) / 2),
        y: Math.round(workArea.y + (workArea.height - this.normal.height) / 2),
      };
    });
    // Both land on the display the normal frame sits on, as Electron's do.
    maximize = vi.fn(() => {
      this.maximized = true;
      this.frame = { ...screen.getDisplayMatching(this.normal).workArea };
      this.emit("maximize");
      this.emit("resize");
    });
    unmaximize = () => {
      this.maximized = false;
      this.frame = null;
      this.emit("unmaximize");
      this.emit("resize");
    };
    setFullScreen = vi.fn((flag: boolean) => {
      this.fullScreen = flag;
      this.frame = flag ? { ...screen.getDisplayMatching(this.normal).bounds } : null;
      this.emit(flag ? "enter-full-screen" : "leave-full-screen");
      this.emit("resize");
    });
    isMaximized = () => this.maximized;
    isFullScreen = () => this.fullScreen;
    isDestroyed = () => this.destroyed;

    /** macOS "Move to iPad": zoomed on the iPad, normal frame left where it was. */
    zoomOnto(display: Display) {
      this.maximized = true;
      this.frame = { ...display.workArea };
      this.emit("maximize");
      this.emit("move");
      this.emit("resize");
    }
    fullScreenOnto(display: Display) {
      this.fullScreen = true;
      this.frame = { ...display.bounds };
      this.emit("enter-full-screen");
      this.emit("resize");
    }
    /** A drag or resize by the user. */
    moveTo(next: Rect) {
      this.normal = { ...next };
      this.emit("move");
      this.emit("resize");
    }

    on = (event: string, handler: (...args: unknown[]) => void) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    };
    once = (event: string, handler: (...args: unknown[]) => void) => {
      const wrapped = (...args: unknown[]) => {
        this.removeListener(event, wrapped);
        handler(...args);
      };
      return this.on(event, wrapped);
    };
    removeListener = (event: string, handler: (...args: unknown[]) => void) => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((h) => h !== handler)
      );
      return this;
    };
    emit(event: string) {
      for (const handler of [...(this.handlers.get(event) ?? [])]) handler();
    }
  }

  return { store, screen, FakeWindow };
});

vi.mock("../store.js", () => ({ windowStatesStore: fakes.store }));

vi.mock("electron", () => ({ BrowserWindow: fakes.FakeWindow, screen: fakes.screen }));

vi.mock("../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProjectId: () => null,
    getProjectById: () => null,
  },
}));

type FakeWindow = InstanceType<typeof fakes.FakeWindow>;

// The displays from #16579: the Mac's own, and a Sidecar iPad to its left.
const MAC: Display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 3008, height: 1692 },
  workArea: { x: 0, y: 25, width: 3008, height: 1667 },
};
const IPAD: Display = {
  id: 2,
  bounds: { x: -1366, y: 0, width: 1366, height: 1024 },
  workArea: { x: -1366, y: 25, width: 1366, height: 999 },
};

const PROJECT = "/projects/daintree";
const CANOPY_SIZE = { width: 1280, height: 860 };

let windowState: typeof import("../windowState.js");

const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function connect(...displays: Display[]) {
  fakes.screen.displays = structuredClone(displays);
}

/** A launch: a fresh main process opening the window and revealing it. */
async function launch(kind: "canopy" | "project" = "canopy"): Promise<FakeWindow> {
  vi.resetModules();
  windowState = await import("../windowState.js");
  const win =
    kind === "canopy"
      ? windowState.createSeparateWindowWithState({ show: false }, CANOPY_BOUNDS_KEY, CANOPY_SIZE)
      : windowState.createWindowWithState({ show: false }, PROJECT);
  const fake = win as unknown as FakeWindow;
  fake.emit("show");
  vi.runOnlyPendingTimers();
  return fake;
}

function quit(win: FakeWindow) {
  vi.runOnlyPendingTimers();
  win.emit("close");
  win.destroyed = true;
}

const displayOf = (rect: Rect) => fakes.screen.getDisplayMatching(rect).id;

function within(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  setPlatform("darwin");
  fakes.store.state = {};
  fakes.FakeWindow.created.length = 0;
  connect(MAC, IPAD);
});

afterEach(() => {
  vi.useRealTimers();
  setPlatform(originalPlatform);
});

/** First launch: the window opens on the Mac and the user moves it to the iPad. */
async function leftOnIpad(how: "maximized" | "full screen", kind: "canopy" | "project" = "canopy") {
  const win = await launch(kind);
  expect(displayOf(win.getNormalBounds())).toBe(MAC.id);
  if (how === "maximized") win.zoomOnto(IPAD);
  else win.fullScreenOnto(IPAD);
  quit(win);
}

describe("a window maximized or full screen on another display than its normal bounds", () => {
  it("reopens maximized on the display it was maximized on", async () => {
    await leftOnIpad("maximized");

    const win = await launch();

    expect(win.isMaximized()).toBe(true);
    expect(displayOf(win.getBounds())).toBe(IPAD.id);
  });

  it("stays on that display when un-maximized afterwards", async () => {
    await leftOnIpad("maximized");

    const win = await launch();
    win.unmaximize();

    expect(displayOf(win.getBounds())).toBe(IPAD.id);
    expect(within(win.getBounds(), IPAD.workArea)).toBe(true);
  });

  it("reopens full screen on the display it was full screen on", async () => {
    await leftOnIpad("full screen");

    const win = await launch();

    expect(win.isFullScreen()).toBe(true);
    expect(displayOf(win.getBounds())).toBe(IPAD.id);
  });

  it("brings a project window back the same way", async () => {
    await leftOnIpad("maximized", "project");

    const win = await launch("project");

    expect(win.isMaximized()).toBe(true);
    expect(displayOf(win.getBounds())).toBe(IPAD.id);
  });

  it("finds the display again after it reconnects under another id", async () => {
    await leftOnIpad("maximized");
    connect(MAC, { ...IPAD, id: 77 });

    const win = await launch();

    expect(displayOf(win.getBounds())).toBe(77);
  });

  it("follows the display to where it was rearranged", async () => {
    await leftOnIpad("maximized");
    const moved: Display = {
      ...IPAD,
      bounds: { x: 3008, y: 0, width: 1366, height: 1024 },
      workArea: { x: 3008, y: 25, width: 1366, height: 999 },
    };
    connect(MAC, moved);

    const win = await launch();

    expect(displayOf(win.getBounds())).toBe(IPAD.id);
    expect(within(win.getBounds(), moved.workArea)).toBe(true);
  });

  it("on Linux still maximizes a hidden window only once it is revealed", async () => {
    await leftOnIpad("maximized");
    setPlatform("linux");
    vi.resetModules();
    windowState = await import("../windowState.js");

    const win = windowState.createSeparateWindowWithState(
      { show: false },
      CANOPY_BOUNDS_KEY,
      CANOPY_SIZE
    ) as unknown as FakeWindow;
    expect(win.maximize).not.toHaveBeenCalled();
    expect(displayOf(win.getNormalBounds())).toBe(IPAD.id);

    win.emit("show");
    expect(displayOf(win.getBounds())).toBe(IPAD.id);
  });
});

describe("when that display is absent at launch", () => {
  it("opens maximized on a remaining display, fully reachable", async () => {
    await leftOnIpad("maximized");
    connect(MAC);

    const win = await launch();

    expect(win.isMaximized()).toBe(true);
    expect(within(win.getBounds(), MAC.workArea)).toBe(true);
    win.unmaximize();
    expect(within(win.getBounds(), MAC.workArea)).toBe(true);
  });

  it("puts it back there at the next launch with the display, if the user left it alone", async () => {
    await leftOnIpad("maximized");
    connect(MAC);
    quit(await launch());
    connect(MAC, IPAD);

    const win = await launch();

    expect(win.isMaximized()).toBe(true);
    expect(displayOf(win.getBounds())).toBe(IPAD.id);
  });

  it("keeps the placement through full screen too", async () => {
    await leftOnIpad("full screen");
    connect(MAC);
    quit(await launch());
    connect(MAC, IPAD);

    const win = await launch();

    expect(win.isFullScreen()).toBe(true);
    expect(displayOf(win.getBounds())).toBe(IPAD.id);
  });

  it("keeps the placement through several launches without it", async () => {
    await leftOnIpad("maximized");
    connect(MAC);
    quit(await launch());
    quit(await launch());
    connect(MAC, IPAD);

    const win = await launch();

    expect(displayOf(win.getBounds())).toBe(IPAD.id);
  });

  it("lets go of it once the user moves the window", async () => {
    await leftOnIpad("maximized");
    connect(MAC);
    const win = await launch();
    win.unmaximize();
    win.moveTo({ x: 400, y: 300, width: 1200, height: 800 });
    win.maximize();
    quit(win);
    connect(MAC, IPAD);

    const next = await launch();

    expect(next.isMaximized()).toBe(true);
    expect(displayOf(next.getBounds())).toBe(MAC.id);
  });

  it("never moves the open window when the display connects", async () => {
    await leftOnIpad("maximized");
    connect(MAC);
    const win = await launch();
    const frame = win.getBounds();
    const setBoundsCalls = win.setBounds.mock.calls.length;

    connect(MAC, IPAD);
    vi.runOnlyPendingTimers();

    expect(win.getBounds()).toEqual(frame);
    expect(win.setBounds).toHaveBeenCalledTimes(setBoundsCalls);

    quit(win);
    const next = await launch();
    expect(displayOf(next.getBounds())).toBe(IPAD.id);
  });
});

describe("state saved before displays were recorded", () => {
  it("restores as it did: maximized where its normal bounds sit", async () => {
    // Verbatim from #16579.
    fakes.store.state = {
      [CANOPY_BOUNDS_KEY]: {
        x: 862,
        y: 477,
        width: 1376,
        height: 974,
        isMaximized: true,
        isFullScreen: false,
      },
    };

    const win = await launch();

    expect(win.getNormalBounds()).toEqual({ x: 862, y: 477, width: 1376, height: 974 });
    expect(win.isMaximized()).toBe(true);
    expect(displayOf(win.getBounds())).toBe(MAC.id);
  });

  it("records no display for a window that isn't maximized or full screen", async () => {
    const win = await launch();
    quit(win);

    expect(fakes.store.state[CANOPY_BOUNDS_KEY]).toEqual({
      ...win.getNormalBounds(),
      isMaximized: false,
      isFullScreen: false,
    });
  });
});
