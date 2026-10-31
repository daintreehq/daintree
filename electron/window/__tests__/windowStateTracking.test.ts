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

const SCRATCH = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const OTHER_SCRATCH = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const HOST_PROJECT = "a".repeat(64);
const ON_BUILD_BOX = `build-box:${HOST_PROJECT}`;
const ON_GPU_BOX = `gpu-box:${HOST_PROJECT}`;

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

  it("has no key for a picker or a project whose row is gone", () => {
    expect(resolveBoundsProjectPath(null, undefined)).toBeNull();
    expect(resolveBoundsProjectPath(undefined, "b".repeat(64))).toBeNull();
  });

  it("keys a scratch and a host's project apart from each other and from every folder", () => {
    const keys = [SCRATCH, OTHER_SCRATCH, ON_BUILD_BOX, ON_GPU_BOX].map((id) =>
      resolveBoundsProjectPath(undefined, id)
    );

    expect(keys.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((key) => Object.values(PATHS).includes(key!))).toBe(false);
  });

  it("never looks a scratch or a host's project up as a local project", () => {
    resolveBoundsProjectPath(undefined, SCRATCH);
    resolveBoundsProjectPath(undefined, ON_BUILD_BOX);

    expect(readProjectPathSync).not.toHaveBeenCalled();
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

  it("saves a scratch or host window under the key it is reopened with", () => {
    const windows = [appWindow(1, SCRATCH), appWindow(2, ON_BUILD_BOX), appWindow(3, ON_GPU_BOX)];
    useWindows(...windows);

    for (const w of windows) {
      const shown = appWindowStateTracking.getShownProjectPath(w.browserWindow as never);
      expect(shown).not.toBeNull();
      expect(shown).toBe(
        resolveBoundsProjectPath(
          undefined,
          w.services.projectViewManager.getActiveProjectId() ?? undefined
        )
      );
    }
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
