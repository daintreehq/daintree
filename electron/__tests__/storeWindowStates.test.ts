import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRawStoreValue } from "../utils/storeValues.js";

const fakes = vi.hoisted(() => {
  class FakeWindow {
    private handlers = new Map<string, Array<() => void>>();
    constructor(private bounds: { x: number; y: number; width: number; height: number }) {}
    getBounds = () => ({ ...this.bounds });
    getNormalBounds = () => ({ ...this.bounds });
    setBounds = (next: typeof this.bounds) => {
      this.bounds = { ...next };
    };
    setSize = (width: number, height: number) => {
      this.bounds = { ...this.bounds, width, height };
    };
    center = () => {};
    maximize = () => {};
    setFullScreen = () => {};
    isDestroyed = () => false;
    isMaximized = () => false;
    isFullScreen = () => false;
    on = (event: string, handler: () => void) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    };
    once = this.on;
    emit = (event: string) => {
      for (const handler of this.handlers.get(event) ?? []) handler();
    };
  }
  const area = { x: 0, y: 0, width: 4000, height: 3000 };
  return {
    FakeWindow,
    display: { workArea: area, bounds: area },
    refuseStore: { name: null as string | null },
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => "/fake/userData" },
  BrowserWindow: class extends fakes.FakeWindow {
    constructor(options: { x?: number; y?: number; width: number; height: number }) {
      super({ x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height });
    }
  },
  screen: {
    getDisplayMatching: () => fakes.display,
    getPrimaryDisplay: () => fakes.display,
  },
}));

// electron-store names its file with `name`; conf calls the same option `configName`.
vi.mock("electron-store", async () => {
  const { default: Conf } = await import("conf");
  class Store extends Conf {
    constructor(options: Record<string, unknown> = {}) {
      const { name, ...rest } = options;
      if (name === fakes.refuseStore.name) throw new Error("unusable store path");
      super({ ...rest, configName: (name as string | undefined) ?? "config" });
    }
  }
  return { default: Store };
});

type StoreModule = typeof import("../store.js");
type WindowStates = Record<string, Record<string, unknown>>;

const bounds = (x: number) => ({ x, y: 40, width: 1000, height: 700, isMaximized: false });

let userData: string;
let previousUserData: string | undefined;
let mod: StoreModule;

const statesFile = () => path.join(userData, "window-states.json");
const onDisk = () => JSON.parse(fs.readFileSync(statesFile(), "utf8")).windowStates as WindowStates;
const seedFile = (windowStates: WindowStates) =>
  fs.writeFileSync(statesFile(), JSON.stringify({ windowStates }));
const read = () => mod.windowStatesStore.get("windowStates");
const write = (windowStates: WindowStates) =>
  setRawStoreValue(mod.windowStatesStore, "windowStates", windowStates);

function fileReadsDuring(run: () => void): number {
  const spy = vi.spyOn(fs, "readFileSync");
  try {
    run();
    return spy.mock.calls.filter(([file]) => file === statesFile()).length;
  } finally {
    spy.mockRestore();
  }
}

// store.ts captures DAINTREE_USER_DATA when it loads, so each load is a fresh start.
async function loadStore(): Promise<void> {
  vi.resetModules();
  mod = await import("../store.js");
}

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-window-states-"));
  previousUserData = process.env.DAINTREE_USER_DATA;
  process.env.DAINTREE_USER_DATA = userData;
  fakes.refuseStore.name = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await loadStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  mod._resetStoreInstance();
  process.env.DAINTREE_USER_DATA = previousUserData;
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("windowStatesStore reads", () => {
  it("loads the file once, then answers from memory", () => {
    seedFile({ "/project": bounds(10) });
    expect(read()).toEqual({ "/project": bounds(10) });

    expect(
      fileReadsDuring(() => {
        for (let i = 0; i < 5; i++) expect(read()).toEqual({ "/project": bounds(10) });
      })
    ).toBe(0);
  });

  it("answers from memory right after a save", () => {
    expect(read()).toEqual({});
    write({ "/project": bounds(20) });

    expect(
      fileReadsDuring(() => {
        expect(read()).toEqual({ "/project": bounds(20) });
      })
    ).toBe(0);
  });

  it("reads the file at most once for a save, inside conf's own write", () => {
    expect(read()).toEqual({});
    expect(fileReadsDuring(() => write({ "/project": bounds(30) }))).toBeLessThanOrEqual(1);
  });

  it("does not see a file changed behind it", () => {
    seedFile({ "/project": bounds(10) });
    expect(read()).toEqual({ "/project": bounds(10) });

    seedFile({ "/elsewhere": bounds(99) });
    expect(read()).toEqual({ "/project": bounds(10) });
  });
});

describe("windowStatesStore isolation", () => {
  it("keeps a caller's edit of what it read out of later reads and the file", () => {
    seedFile({ "/project": bounds(10) });

    const held = read();
    held["/project"]!.x = 999;
    delete held["/project"];
    held["/added"] = bounds(1) as never;

    expect(read()).toEqual({ "/project": bounds(10) });
    write(read());
    expect(onDisk()).toEqual({ "/project": bounds(10) });
  });

  it("keeps a caller's later edit of what it saved out of later reads", () => {
    const saved = { "/project": bounds(10) };
    write(saved);

    saved["/project"]!.x = 999;

    expect(read()).toEqual({ "/project": bounds(10) });
    expect(onDisk()).toEqual({ "/project": bounds(10) });
  });

  it("hands every reader its own copy", () => {
    write({ "/project": bounds(10) });
    expect(read()).not.toBe(read());
    expect(read()["/project"]).not.toBe(read()["/project"]);
  });
});

describe("windowStatesStore persistence", () => {
  it("comes back the same after a restart, in the same key order", async () => {
    const saved = { "/z": bounds(1), "/a": bounds(2), __legacy__: bounds(3) };
    write(saved);

    await loadStore();

    expect(read()).toEqual(saved);
    expect(Object.keys(read())).toEqual(["/z", "/a", "__legacy__"]);
  });

  it("answers a save with what the next load will read", async () => {
    write({ "/project": { ...bounds(1), x: undefined } });
    const fromMemory = read();

    await loadStore();

    expect(fromMemory).toStrictEqual(read());
    expect(Object.hasOwn(fromMemory["/project"]!, "x")).toBe(false);
  });

  it("opens a damaged file as empty and repairs it", () => {
    fs.writeFileSync(statesFile(), "{oops");
    expect(read()).toEqual({});

    write({ "/project": bounds(10) });
    expect(onDisk()).toEqual({ "/project": bounds(10) });
  });

  it("opens a missing file as empty", () => {
    expect(read()).toEqual({});
  });

  it("does not claim a save that never reached the file", () => {
    seedFile({ "/project": bounds(10) });
    expect(read()).toEqual({ "/project": bounds(10) });

    const refused = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => write({ "/project": bounds(20) })).toThrow("disk full");
    refused.mockRestore();

    expect(read()).toEqual({ "/project": bounds(10) });
    expect(onDisk()).toEqual({ "/project": bounds(10) });
  });

  it("keeps a whole-store replacement, a delete and a reset in step with the file", () => {
    write({ "/project": bounds(10) });

    mod.windowStatesStore.store = { windowStates: { "/replaced": bounds(11) } } as never;
    expect(read()).toEqual({ "/replaced": bounds(11) });

    mod.windowStatesStore.reset("windowStates");
    expect(read()).toEqual({});
    expect(onDisk()).toEqual({});

    write({ "/again": bounds(12) });
    mod.windowStatesStore.delete("windowStates");
    expect(onDisk()).toEqual({});
    expect(read()).toEqual({});

    write({ "/again": bounds(13) });
    mod.windowStatesStore.clear();
    expect(onDisk()).toEqual({});
    expect(read()).toEqual({});
  });

  it.skipIf(process.platform === "win32")("keeps the file private across a save", () => {
    write({ "/project": bounds(10) });
    expect(fs.statSync(statesFile()).mode & 0o777).toBe(0o600);
  });
});

describe("migration 020 over the real store", () => {
  it("merges the main store's states in, with the file and later reads agreeing", async () => {
    seedFile({ "/kept": bounds(1) });
    const { migration020 } = await import("../services/migrations/020-window-states-store.js");
    const main: Record<string, unknown> = {
      windowStates: { "/kept": bounds(50), "/moved": bounds(2) },
    };
    migration020.up({
      get: (key: string) => main[key],
      delete: (key: string) => delete main[key],
    } as never);

    const merged = { "/kept": bounds(1), "/moved": bounds(2) };
    expect(onDisk()).toEqual(merged);
    expect(read()).toEqual(merged);
    expect(main).toEqual({});
  });
});

describe("the in-memory fallback", () => {
  beforeEach(async () => {
    fakes.refuseStore.name = "window-states";
    await loadStore();
  });

  it("holds saved states without sharing them with callers", () => {
    expect(read()).toBeUndefined();

    const saved = { "/project": bounds(10) };
    write(saved);
    saved["/project"]!.x = 999;
    expect(read()).toEqual({ "/project": bounds(10) });

    const held = read();
    held["/project"]!.x = 999;
    expect(read()).toEqual({ "/project": bounds(10) });
  });
});

describe("a window over the real store", () => {
  const load = () => import("../windowState.js");

  it("opens and saves without loading the file again", async () => {
    seedFile({ "/project": bounds(100) });
    const { createWindowWithState } = await load();
    expect(read()).toEqual({ "/project": bounds(100) });

    let win: InstanceType<typeof fakes.FakeWindow> | undefined;
    // No saved entry for this project, so it borrows the most recent bounds too.
    expect(
      fileReadsDuring(() => {
        win = createWindowWithState({}, "/new") as unknown as typeof win;
      })
    ).toBe(0);

    expect(fileReadsDuring(() => win!.emit("close"))).toBeLessThanOrEqual(1);

    const expected = {
      ...bounds(130),
      y: 70,
      isFullScreen: false,
    };
    expect(onDisk()["/new"]).toEqual(expected);
    expect(onDisk()["/project"]).toEqual(bounds(100));
    expect(read()).toEqual(onDisk());
  });

  it("keeps recency order and the prune and rekey edits through the cache", async () => {
    const { createWindowWithState, pruneWindowStateForPath, rekeyWindowStateForPath } =
      await load();
    const closeOn = (key: string) => {
      const win = createWindowWithState({}, key) as unknown as InstanceType<
        typeof fakes.FakeWindow
      >;
      win.emit("close");
    };

    closeOn("/a");
    closeOn("/b");
    closeOn("/a");
    expect(Object.keys(onDisk())).toEqual(["__legacy__", "/b", "/a"]);
    expect(Object.keys(read())).toEqual(Object.keys(onDisk()));

    pruneWindowStateForPath("/b");
    rekeyWindowStateForPath("/a", "/c");
    expect(Object.keys(onDisk())).toEqual(["__legacy__", "/c"]);
    expect(read()).toEqual(onDisk());

    await loadStore();
    expect(Object.keys(read())).toEqual(["__legacy__", "/c"]);
  });
});
