import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { WindowRegistry } from "../WindowRegistry.js";

const logErrorMock = vi.hoisted(() => vi.fn());
vi.mock("../../utils/logger.js", () => ({ logError: logErrorMock }));

import {
  markWindowReadyForOpens,
  reserveWindowForOpen,
  snapshotOpenWorld,
  _resetWindowOpenStateForTest,
} from "../windowOpenState.js";

interface FakePvm {
  getActiveProjectId: () => string | null;
  getOutgoingBridgeProjectId: () => string | null;
  getAllViews: () => Array<{ projectId: string; view: { webContents: { isDestroyed(): boolean } } }>;
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
        },
        {
          windowId: 1,
          activeProjectId: null,
          bridgeProjectId: null,
          viewProjectIds: [],
          ready: false,
          reservations: [],
        },
      ],
    });
  });

  it("skips destroyed windows and tolerates a missing registry", () => {
    expect(snapshotOpenWorld(registryOf([ctx(1, pvm(null), true)]), "default").windows).toEqual(
      []
    );
    expect(snapshotOpenWorld(undefined, "default").windows).toEqual([]);
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

    first();
    first();
    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0].reservations).toEqual([
      { projectId: null, projectPath: "/b" },
    ]);

    second();
    expect(snapshotOpenWorld(registryOf([w]), "default").windows[0].reservations).toEqual([]);
  });
});
