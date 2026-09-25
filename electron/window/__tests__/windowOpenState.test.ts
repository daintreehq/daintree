import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { WindowRegistry } from "../WindowRegistry.js";

const logErrorMock = vi.hoisted(() => vi.fn());
vi.mock("../../utils/logger.js", () => ({ logError: logErrorMock }));

import {
  holdWindowForOpen,
  isWindowBound,
  isWindowReadyForOpens,
  markWindowReadyForOpens,
  reserveWindowForOpen,
  snapshotOpenWorld,
  _resetWindowOpenStateForTest,
} from "../windowOpenState.js";
import { getProjectHistory, resetProjectHistory } from "../../services/ProjectHistoryService.js";
import { claimProjectActivation } from "../projectActivationClaims.js";
import { decideProjectOpenTarget } from "../windowOpenPolicy.js";

interface FakePvm {
  getActiveProjectId: () => string | null;
  getOutgoingBridgeProjectId: () => string | null;
  getAllViews: () => Array<{
    projectId: string;
    view: { webContents: { isDestroyed(): boolean } };
  }>;
}

function pvm(
  active: string | null,
  views: Array<[string, boolean?]> = active ? [[active]] : [],
  bridge: string | null = null
): FakePvm {
  return {
    getActiveProjectId: () => active,
    getOutgoingBridgeProjectId: () => bridge,
    getAllViews: () =>
      views.map(([projectId, destroyed]) => ({
        projectId,
        view: { webContents: { isDestroyed: () => destroyed ?? false } },
      })),
  };
}

function ctx(windowId: number, manager: FakePvm | undefined, destroyed = false) {
  const browserWindow = { isDestroyed: () => destroyed } as unknown as BrowserWindow;
  return { windowId, browserWindow, services: { projectViewManager: manager } };
}

function registryOf(contexts: ReturnType<typeof ctx>[]): WindowRegistry {
  return { focusOrder: () => contexts } as unknown as WindowRegistry;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetWindowOpenStateForTest();
  for (let id = 1; id <= 5; id++) resetProjectHistory(id);
});

describe("snapshotOpenWorld", () => {
  it("reads each window from its own view manager, in focus order", () => {
    const a = ctx(3, pvm("p3", [["p3"], ["cached"], ["gone", true]], "leaving"));
    const b = ctx(1, pvm(null));
    markWindowReadyForOpens(a.browserWindow);

    expect(snapshotOpenWorld(registryOf([a, b]), "on")).toEqual({
      preference: "on",
      windows: [
        {
          windowId: 3,
          activeProjectId: "p3",
          bridgeProjectId: "leaving",
          viewProjectIds: ["p3", "cached"],
          ready: true,
          reservations: [],
          unboundOpens: [],
        },
        {
          windowId: 1,
          activeProjectId: null,
          bridgeProjectId: null,
          viewProjectIds: [],
          ready: false,
          reservations: [],
          unboundOpens: [],
        },
      ],
    });
  });

  it("skips destroyed windows and tolerates a missing registry", () => {
    expect(snapshotOpenWorld(registryOf([ctx(1, pvm(null), true)]), "default").windows).toEqual([]);
    expect(snapshotOpenWorld(undefined, "default").windows).toEqual([]);
  });

  it("reads a closed project in front as the picker, keeping its view as owned", () => {
    const closed = new Set(["closed-p"]);
    const w = ctx(1, pvm("closed-p", [["closed-p"]], "closed-p"));
    markWindowReadyForOpens(w.browserWindow);

    expect(
      snapshotOpenWorld(registryOf([w]), "default", (id) => closed.has(id)).windows[0]
    ).toMatchObject({ activeProjectId: null, bridgeProjectId: null, viewProjectIds: ["closed-p"] });
  });

  it("counts an in-app activation still in flight as an open into its window (#12596)", () => {
    const switching = ctx(1, pvm(null));
    const other = ctx(2, pvm(null));
    markWindowReadyForOpens(switching.browserWindow);
    markWindowReadyForOpens(other.browserWindow);
    const release = claimProjectActivation("p", 1);

    try {
      const world = snapshotOpenWorld(registryOf([other, switching]), "default");
      expect(world.windows.find((w) => w.windowId === 1)?.reservations).toEqual([
        { projectId: "p", projectPath: null },
      ]);
      expect(
        decideProjectOpenTarget(
          {
            projectId: "p",
            projectPath: "/p",
            source: "external",
            intent: "open",
            disposition: "default",
            initiatingWindowId: null,
          },
          world
        )
      ).toEqual({ kind: "focus", windowId: 1 });
    } finally {
      release();
    }

    expect(snapshotOpenWorld(registryOf([switching]), "default").windows[0]?.reservations).toEqual(
      []
    );
  });

  it("reports readiness only once a window has been marked", () => {
    const w = ctx(1, pvm(null));
    expect(isWindowReadyForOpens(w.browserWindow)).toBe(false);
    markWindowReadyForOpens(w.browserWindow);
    expect(isWindowReadyForOpens(w.browserWindow)).toBe(true);
  });

  it("never reports a window without a view manager as ready", () => {
    const bare = ctx(1, undefined);
    markWindowReadyForOpens(bare.browserWindow);
    expect(snapshotOpenWorld(registryOf([bare]), "default").windows[0]).toMatchObject({
      activeProjectId: null,
      ready: false,
    });
  });

  it("isolates a view manager that throws and reports that window as not ready", () => {
    const broken = ctx(1, {
      ...pvm(null),
      getActiveProjectId: () => {
        throw new Error("disposing");
      },
    });
    const healthy = ctx(2, pvm(null));
    markWindowReadyForOpens(broken.browserWindow);
    markWindowReadyForOpens(healthy.browserWindow);

    const { windows } = snapshotOpenWorld(registryOf([broken, healthy]), "default");

    expect(windows.map((w) => [w.windowId, w.ready])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(logErrorMock).toHaveBeenCalledOnce();
  });
});

describe("reserveWindowForOpen", () => {
  it("shows up in the snapshot until released, and release is idempotent", () => {
    const w = ctx(1, pvm(null));
    const first = reserveWindowForOpen(1, { projectId: "a", projectPath: "/a" });
    const second = reserveWindowForOpen(1, { projectId: null, projectPath: "/b" });

    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0].reservations).toEqual([
      { projectId: "a", projectPath: "/a" },
      { projectId: null, projectPath: "/b" },
    ]);

    first(true);
    first(true);
    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0].reservations).toEqual([
      { projectId: null, projectPath: "/b" },
    ]);

    second(true);
    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0]).toMatchObject({
      reservations: [],
      unboundOpens: [],
    });
  });

  it("keeps an open that settled unbound until the window binds a workspace", () => {
    let active: string | null = null;
    const w = ctx(1, { ...pvm(null), getActiveProjectId: () => active });
    reserveWindowForOpen(1, { projectId: null, projectPath: "/plain" })(false);

    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0]).toMatchObject({
      reservations: [],
      unboundOpens: [{ projectId: null, projectPath: "/plain" }],
    });

    active = "picked";
    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0].unboundOpens).toEqual([]);
    active = null;
    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0].unboundOpens).toEqual([]);
  });

  it("clears an unbound open when a later open into the window binds", () => {
    const w = ctx(1, pvm(null));
    reserveWindowForOpen(1, { projectId: null, projectPath: "/plain" })(false);
    reserveWindowForOpen(1, { projectId: "p", projectPath: "/p" })(true);

    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0].unboundOpens).toEqual([]);
  });

  it("drops an unbound open once the window has bound a workspace, even one it has left again", () => {
    const w = ctx(1, pvm(null));
    reserveWindowForOpen(1, { projectId: null, projectPath: "/plain" })(false);

    // The user picks a project in that window and closes it again before any
    // external open looks: only the history remembers the bind.
    getProjectHistory(1).record("picked");

    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0].unboundOpens).toEqual([]);
  });

  it("parks a new unbound open without reviving claims from before a bind", () => {
    const w = ctx(1, pvm(null));
    reserveWindowForOpen(1, { projectId: null, projectPath: "/old" })(false);
    getProjectHistory(1).record("picked");
    reserveWindowForOpen(1, { projectId: null, projectPath: "/new" })(false);

    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0].unboundOpens).toEqual([
      { projectId: null, projectPath: "/new" },
    ]);
  });

  it("forgets unbound opens of windows that have closed", () => {
    reserveWindowForOpen(1, { projectId: null, projectPath: "/plain" })(false);
    snapshotOpenWorld(registryOf([]), "default");

    expect(
      snapshotOpenWorld(registryOf([ctx(1, pvm(null))]), "default").windows[0].unboundOpens
    ).toEqual([]);
  });
});

describe("isWindowBound", () => {
  function registryWith(manager: FakePvm | undefined): WindowRegistry {
    return {
      getByWindowId: (id: number) => (id === 1 ? ctx(1, manager) : undefined),
    } as unknown as WindowRegistry;
  }

  it("is true only when the window has a workspace in front", () => {
    expect(isWindowBound(registryWith(pvm("p")), 1)).toBe(true);
    expect(isWindowBound(registryWith(pvm(null)), 1)).toBe(false);
    expect(isWindowBound(registryWith(pvm("p")), 2)).toBe(false);
    expect(isWindowBound(undefined, 1)).toBe(false);
  });

  it("reads a closed project in front as unbound", () => {
    expect(isWindowBound(registryWith(pvm("p")), 1, (id) => id === "p")).toBe(false);
  });

  it("reads a throwing view manager as unbound", () => {
    const broken = {
      ...pvm(null),
      getActiveProjectId: () => {
        throw new Error("disposing");
      },
    };
    expect(isWindowBound(registryWith(broken), 1)).toBe(false);
  });
});

describe("holdWindowForOpen", () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const reservationsOf = (w: ReturnType<typeof ctx>) =>
    snapshotOpenWorld(registryOf([w]), "default").windows[0];

  it("claims the window before the open starts and releases it once bound", async () => {
    const w = ctx(1, pvm(null));
    const open = deferred();
    let seenDuringOpen: unknown;
    const held = holdWindowForOpen(
      1,
      { projectId: null, projectPath: "/a" },
      () => {
        seenDuringOpen = reservationsOf(w).reservations;
        return open.promise;
      },
      () => true
    );

    expect(seenDuringOpen).toEqual([{ projectId: null, projectPath: "/a" }]);
    open.resolve();
    await held;

    expect(reservationsOf(w)).toMatchObject({ reservations: [], unboundOpens: [] });
  });

  it("parks the claim when the open settles without binding", async () => {
    const w = ctx(1, pvm(null));
    await holdWindowForOpen(
      1,
      { projectId: null, projectPath: "/plain" },
      async () => {},
      () => false
    );

    expect(reservationsOf(w)).toMatchObject({
      reservations: [],
      unboundOpens: [{ projectId: null, projectPath: "/plain" }],
    });
  });

  it("releases and rethrows when the open rejects", async () => {
    const w = ctx(1, pvm(null));
    const open = deferred();
    const held = holdWindowForOpen(
      1,
      { projectId: null, projectPath: "/a" },
      () => open.promise,
      () => false
    );
    open.reject(new Error("boom"));

    await expect(held).rejects.toThrow("boom");
    expect(reservationsOf(w)).toMatchObject({
      reservations: [],
      unboundOpens: [{ projectId: null, projectPath: "/a" }],
    });
  });

  it("treats a bind check that throws as unbound", async () => {
    const w = ctx(1, pvm(null));
    await holdWindowForOpen(
      1,
      { projectId: null, projectPath: "/a" },
      async () => {},
      () => {
        throw new Error("disposing");
      }
    );

    expect(reservationsOf(w).unboundOpens).toEqual([{ projectId: null, projectPath: "/a" }]);
  });
});
