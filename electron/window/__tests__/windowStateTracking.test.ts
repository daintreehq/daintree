import { beforeEach, describe, expect, it, vi } from "vitest";

const readProjectPathSync = vi.hoisted(() => vi.fn<(id: string) => string | null>());
vi.mock("../../services/persistence/readLastProjectId.js", () => ({ readProjectPathSync }));

const registry = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../windowRef.js", () => ({ getWindowRegistry: () => registry.current }));

vi.mock("../projectPresenceChanges.js", () => ({ onProjectPresenceChanged: vi.fn() }));

import { appWindowStateTracking, resolveBoundsProjectPath } from "../windowStateTracking.js";

const PATHS: Record<string, string> = {
  daintree: "/home/u/projects/daintree",
  "hello-web": "/home/u/projects/hello-web",
};

function appWindow(id: number, activeProjectId: string | null, bounds = { x: 0, y: 0 }) {
  return {
    windowId: id,
    browserWindow: {
      id,
      isDestroyed: () => false,
      getNormalBounds: () => ({ ...bounds, width: 1200, height: 800 }),
    },
    services: { projectViewManager: { getActiveProjectId: () => activeProjectId } },
  };
}

function useWindows(...windows: ReturnType<typeof appWindow>[]) {
  registry.current = {
    getByWindowId: (id: number) => windows.find((w) => w.windowId === id),
    all: () => windows,
  };
}

beforeEach(() => {
  readProjectPathSync.mockReset();
  readProjectPathSync.mockImplementation((id) => PATHS[id] ?? null);
  registry.current = null;
});

describe("resolveBoundsProjectPath", () => {
  it("finds the folder of a window restored by project id", () => {
    expect(resolveBoundsProjectPath(undefined, "hello-web")).toBe(PATHS["hello-web"]);
  });

  it("prefers a folder the window was opened for", () => {
    expect(resolveBoundsProjectPath("/opened/folder", "hello-web")).toBe("/opened/folder");
    expect(readProjectPathSync).not.toHaveBeenCalled();
  });

  it("has no folder for a picker or a workspace without a project row", () => {
    expect(resolveBoundsProjectPath(null, undefined)).toBeNull();
    expect(resolveBoundsProjectPath(undefined, "scratch-1")).toBeNull();
  });
});

describe("appWindowStateTracking", () => {
  it("names the project each window shows, not one shared answer", () => {
    const daintree = appWindow(1, "daintree");
    const helloWeb = appWindow(2, "hello-web");
    useWindows(daintree, helloWeb);

    const shown = (w: ReturnType<typeof appWindow>) =>
      appWindowStateTracking.getShownProjectPath(w.browserWindow as never);

    expect(shown(daintree)).toBe(PATHS.daintree);
    expect(shown(helloWeb)).toBe(PATHS["hello-web"]);
  });

  it("names no project for a window without one on screen or not yet registered", () => {
    const picker = appWindow(1, null);
    useWindows(picker);

    expect(appWindowStateTracking.getShownProjectPath(picker.browserWindow as never)).toBeNull();
    expect(
      appWindowStateTracking.getShownProjectPath(appWindow(9, "daintree").browserWindow as never)
    ).toBeNull();
  });

  it("reports where the other open windows sit, skipping destroyed ones", () => {
    const open = appWindow(1, "daintree", { x: 5, y: 56 });
    const closing = appWindow(2, "hello-web", { x: 360, y: 153 });
    closing.browserWindow.isDestroyed = () => true;
    useWindows(open, closing);

    expect(appWindowStateTracking.getOccupiedBounds?.()).toEqual([
      { x: 5, y: 56, width: 1200, height: 800 },
    ]);
  });
});
