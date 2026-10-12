import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowStateTracking } from "../windowState.js";

type Rect = { x: number; y: number; width: number; height: number };

const fakes = vi.hoisted(() => {
  const store = {
    state: {} as Record<string, unknown>,
    get: (_key: string) => store.state,
    set: (_key: string, value: Record<string, unknown>) => {
      store.state = value;
    },
  };

  const workArea = { x: 0, y: 0, width: 1920, height: 1200 };
  const display = { workArea, bounds: workArea };

  class FakeWindow {
    static created: FakeWindow[] = [];
    bounds: Rect;
    maximized = false;
    destroyed = false;
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(public readonly options: Record<string, unknown>) {
      this.bounds = {
        x: (options.x as number | undefined) ?? 0,
        y: (options.y as number | undefined) ?? 0,
        width: options.width as number,
        height: options.height as number,
      };
      FakeWindow.created.push(this);
    }

    getBounds = () => ({ ...this.bounds });
    getNormalBounds = () => ({ ...this.bounds });
    setBounds = vi.fn((next: Rect) => {
      this.bounds = { ...next };
    });
    setSize = vi.fn((width: number, height: number) => {
      this.bounds = { ...this.bounds, width, height };
    });
    center = vi.fn(() => {
      this.bounds = {
        ...this.bounds,
        x: Math.round((workArea.width - this.bounds.width) / 2),
        y: Math.round((workArea.height - this.bounds.height) / 2),
      };
    });
    maximize = vi.fn(() => {
      this.maximized = true;
    });
    setFullScreen = vi.fn();
    isMaximized = () => this.maximized;
    isFullScreen = () => false;
    isDestroyed = () => this.destroyed;

    on = (event: string, handler: (...args: unknown[]) => void) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    };
    once = (event: string, handler: (...args: unknown[]) => void) => {
      const wrapped = (...args: unknown[]) => {
        this.handlers.set(
          event,
          (this.handlers.get(event) ?? []).filter((h) => h !== wrapped)
        );
        handler(...args);
      };
      this.on(event, wrapped);
    };
    emit(event: string) {
      for (const handler of [...(this.handlers.get(event) ?? [])]) handler();
    }
  }

  return { store, workArea, display, FakeWindow };
});

vi.mock("../store.js", () => ({ windowStatesStore: fakes.store }));

vi.mock("electron", () => ({
  BrowserWindow: fakes.FakeWindow,
  screen: {
    getDisplayMatching: () => fakes.display,
    getPrimaryDisplay: () => fakes.display,
  },
}));

vi.mock("../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProjectId: () => "global-current",
    getProjectById: () => ({ path: "/projects/global-current" }),
  },
}));

type FakeWindow = InstanceType<typeof fakes.FakeWindow>;

let createWindowWithState: typeof import("../windowState.js").createWindowWithState;

const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

const DAINTREE = "/projects/daintree";
const HELLO_WEB = "/projects/hello-web";
const DAINTREE_BOUNDS = { x: 5, y: 56, width: 956, height: 1053, isMaximized: false };
const HELLO_WEB_BOUNDS = { x: 360, y: 153, width: 1200, height: 800, isMaximized: false };

function open(projectPath?: string, tracking?: WindowStateTracking): FakeWindow {
  return createWindowWithState({ show: false }, projectPath, tracking) as unknown as FakeWindow;
}

function occupiedBy(...windows: FakeWindow[]): WindowStateTracking {
  return {
    getShownProjectPath: () => null,
    getOccupiedBounds: () => windows.map((w) => w.getNormalBounds()),
  };
}

beforeEach(async () => {
  vi.resetModules();
  ({ createWindowWithState } = await import("../windowState.js"));
  fakes.FakeWindow.created.length = 0;
  fakes.store.state = {};
  Object.assign(fakes.workArea, { x: 0, y: 0, width: 1920, height: 1200 });
  setPlatform(originalPlatform);
});

afterEach(() => {
  vi.useRealTimers();
  setPlatform(originalPlatform);
});

describe("placing restored windows", () => {
  it("opens each restored window at its own project's saved bounds", () => {
    fakes.store.state = {
      [HELLO_WEB]: HELLO_WEB_BOUNDS,
      [DAINTREE]: DAINTREE_BOUNDS,
      __legacy__: DAINTREE_BOUNDS,
    };

    const daintree = open(DAINTREE, occupiedBy());
    const helloWeb = open(HELLO_WEB, occupiedBy(daintree));

    expect(daintree.getBounds()).toEqual({ x: 5, y: 56, width: 956, height: 1053 });
    expect(helloWeb.getBounds()).toEqual({ x: 360, y: 153, width: 1200, height: 800 });
  });

  it("keeps a window at its own saved spot even when another window sits there", () => {
    fakes.store.state = { [DAINTREE]: DAINTREE_BOUNDS, [HELLO_WEB]: DAINTREE_BOUNDS };

    const daintree = open(DAINTREE, occupiedBy());
    const helloWeb = open(HELLO_WEB, occupiedBy(daintree));

    expect(helloWeb.getBounds()).toEqual(daintree.getBounds());
  });

  it("cascades a window with no saved bounds off the window it borrowed them from", () => {
    fakes.store.state = { [DAINTREE]: DAINTREE_BOUNDS, __legacy__: DAINTREE_BOUNDS };

    const daintree = open(DAINTREE, occupiedBy());
    const helloWeb = open(HELLO_WEB, occupiedBy(daintree));
    const third = open("/projects/third", occupiedBy(daintree, helloWeb));

    expect(helloWeb.getBounds()).toMatchObject({ x: 35, y: 86 });
    expect(third.getBounds()).toMatchObject({ x: 65, y: 116 });
    // Each lands clear of every window already open.
    expect(new Set([daintree, helloWeb, third].map((w) => w.getBounds().x)).size).toBe(3);
  });

  it("cascades a picker window off the window holding the last saved bounds", () => {
    fakes.store.state = { [DAINTREE]: DAINTREE_BOUNDS, __legacy__: DAINTREE_BOUNDS };

    const daintree = open(DAINTREE, occupiedBy());
    const picker = open(undefined, occupiedBy(daintree));

    expect(picker.getBounds().x).toBe(daintree.getBounds().x + 30);
  });

  it("steps up and left off a window in the corner it was clamped into", () => {
    Object.assign(fakes.workArea, { width: 1920, height: 1080 });
    const corner = { x: 720, y: 280, width: 1200, height: 800, isMaximized: false };
    const offScreen = { x: 2500, y: 1500, width: 1200, height: 800, isMaximized: false };
    fakes.store.state = { [DAINTREE]: corner, [HELLO_WEB]: offScreen };

    const daintree = open(DAINTREE, occupiedBy());
    const helloWeb = open(HELLO_WEB, occupiedBy(daintree));

    // Clamping pins hello-web to (720,280), exactly over daintree, where a
    // down-right step has no room; the up-left one does.
    expect(daintree.getBounds()).toEqual({ x: 720, y: 280, width: 1200, height: 800 });
    expect(helloWeb.getBounds()).toEqual({ x: 690, y: 250, width: 1200, height: 800 });
  });

  it("keeps stepping up and left past every window already cascaded there", () => {
    Object.assign(fakes.workArea, { width: 1920, height: 1080 });
    const offScreen = { x: 2500, y: 1500, width: 1200, height: 800, isMaximized: false };
    fakes.store.state = { [DAINTREE]: offScreen, [HELLO_WEB]: offScreen, "/p/third": offScreen };

    const daintree = open(DAINTREE, occupiedBy());
    const helloWeb = open(HELLO_WEB, occupiedBy(daintree));
    const third = open("/p/third", occupiedBy(daintree, helloWeb));

    expect([daintree, helloWeb, third].map((w) => [w.getBounds().x, w.getBounds().y])).toEqual([
      [720, 280],
      [690, 250],
      [660, 220],
    ]);
  });

  it("stays put when the work area leaves no room to step either way", () => {
    Object.assign(fakes.workArea, { width: 1200, height: 800 });
    const full = { x: 0, y: 0, width: 1200, height: 800, isMaximized: false };
    fakes.store.state = { [DAINTREE]: full, [HELLO_WEB]: { ...full, x: 50 } };

    const daintree = open(DAINTREE, occupiedBy());
    const helloWeb = open(HELLO_WEB, occupiedBy(daintree));

    expect(helloWeb.getBounds()).toEqual(daintree.getBounds());
  });

  it("steps clear of a clamped window when there is room to", () => {
    const offLeft = { x: -900, y: 100, width: 1200, height: 800, isMaximized: false };
    fakes.store.state = { [DAINTREE]: offLeft, [HELLO_WEB]: offLeft };

    const daintree = open(DAINTREE, occupiedBy());
    const helloWeb = open(HELLO_WEB, occupiedBy(daintree));

    expect(daintree.getBounds()).toMatchObject({ x: 0, y: 100 });
    expect(helloWeb.getBounds()).toMatchObject({ x: 30, y: 130 });
  });
});

describe("saving under the project the window shows", () => {
  function tracking(shown: { path: string | null }, listeners: Array<() => void> = []) {
    return {
      getShownProjectPath: vi.fn(() => shown.path),
      onShownProjectChange: vi.fn((listener: () => void) => {
        listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      }),
    } satisfies WindowStateTracking;
  }

  it("saves a window's bounds under its own project, not the global current one", () => {
    fakes.store.state = { [HELLO_WEB]: HELLO_WEB_BOUNDS, [DAINTREE]: DAINTREE_BOUNDS };
    const helloWeb = open(HELLO_WEB, tracking({ path: HELLO_WEB }));
    helloWeb.bounds = { x: 400, y: 200, width: 1200, height: 800 };

    helloWeb.emit("close");

    expect(fakes.store.state[HELLO_WEB]).toMatchObject({ x: 400, y: 200 });
    expect(fakes.store.state[DAINTREE]).toEqual(DAINTREE_BOUNDS);
    expect(fakes.store.state["/projects/global-current"]).toBeUndefined();
  });

  it("saves under the project it opened on until it shows one", () => {
    const win = open(HELLO_WEB, tracking({ path: null }));

    win.emit("close");

    expect(fakes.store.state[HELLO_WEB]).toBeDefined();
  });

  it("saves only the last-window bounds once it shows no project any more", () => {
    const shown = { path: HELLO_WEB as string | null };
    const win = open(HELLO_WEB, tracking(shown));
    win.emit("close");
    fakes.store.state = {};

    shown.path = null;
    win.emit("close");

    expect(Object.keys(fakes.store.state)).toEqual(["__legacy__"]);
  });

  it("saves the bounds again under a project the window switches to", () => {
    vi.useFakeTimers();
    const shown = { path: DAINTREE as string | null };
    const listeners: Array<() => void> = [];
    fakes.store.state = { [DAINTREE]: DAINTREE_BOUNDS };
    open(DAINTREE, tracking(shown, listeners));

    // Re-reporting the project it opened on writes nothing.
    for (const listener of listeners) listener();
    vi.advanceTimersByTime(1000);
    expect(fakes.store.state[HELLO_WEB]).toBeUndefined();

    shown.path = HELLO_WEB;
    for (const listener of listeners) listener();
    vi.advanceTimersByTime(1000);

    expect(fakes.store.state[HELLO_WEB]).toMatchObject({ x: 5, y: 56, width: 956 });
  });

  it("saves a move made just before a switch under the project it was made in", () => {
    vi.useFakeTimers();
    const shown = { path: DAINTREE as string | null };
    const listeners: Array<() => void> = [];
    fakes.store.state = { [DAINTREE]: DAINTREE_BOUNDS, [HELLO_WEB]: HELLO_WEB_BOUNDS };
    const win = open(DAINTREE, tracking(shown, listeners));

    win.bounds = { x: 700, y: 100, width: 956, height: 1053 };
    win.emit("move");
    shown.path = HELLO_WEB;
    for (const listener of listeners) listener();

    expect(fakes.store.state[DAINTREE]).toMatchObject({ x: 700, y: 100 });
    vi.advanceTimersByTime(1000);
    expect(fakes.store.state[HELLO_WEB]).toMatchObject({ x: 700, y: 100 });
  });

  it("keeps a window coming up from being read as one that left its project", () => {
    vi.useFakeTimers();
    const shown = { path: null as string | null };
    const listeners: Array<() => void> = [];
    fakes.store.state = { [HELLO_WEB]: HELLO_WEB_BOUNDS };
    open(HELLO_WEB, tracking(shown, listeners));

    for (const listener of listeners) listener();
    shown.path = HELLO_WEB;
    for (const listener of listeners) listener();
    vi.advanceTimersByTime(1000);

    // Opened on hello-web and now showing it: nothing to write.
    expect(Object.keys(fakes.store.state)).toEqual([HELLO_WEB]);
  });

  it("stops listening for switches once the window is closed", () => {
    const listeners: Array<() => void> = [];
    const win = open(DAINTREE, tracking({ path: DAINTREE }, listeners));
    expect(listeners).toHaveLength(1);

    win.emit("closed");

    expect(listeners).toHaveLength(0);
  });
});

describe("restoring a maximized window", () => {
  const maximizedState = { [DAINTREE]: { ...DAINTREE_BOUNDS, isMaximized: true } };

  it("on Linux maximizes a hidden window only once it is revealed", () => {
    setPlatform("linux");
    fakes.store.state = { ...maximizedState };

    const win = open(DAINTREE);
    expect(win.maximize).not.toHaveBeenCalled();

    win.emit("show");
    expect(win.maximize).toHaveBeenCalledTimes(1);
  });

  it("on Linux keeps the saved maximized state while the reveal is pending", () => {
    setPlatform("linux");
    fakes.store.state = { ...maximizedState };

    const win = open(DAINTREE);
    win.emit("close");

    expect(fakes.store.state[DAINTREE]).toMatchObject({ isMaximized: true });
  });

  it("maximizes at once on macOS and Windows", () => {
    for (const platform of ["darwin", "win32"] as const) {
      setPlatform(platform);
      fakes.store.state = { ...maximizedState };

      expect(open(DAINTREE).maximize).toHaveBeenCalledTimes(1);
    }
  });
});
