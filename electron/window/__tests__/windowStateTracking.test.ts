import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  readProjectPathSync: vi.fn<(id: string) => string | null>(),
  isLiveScratchSync: vi.fn<(id: string) => boolean>(),
}));
vi.mock("../../services/persistence/readLastProjectId.js", () => db);

const getPendingRemoteRestore = vi.hoisted(() => vi.fn<(windowId: number) => string | null>());
const pendingListeners = vi.hoisted(() => new Set<() => void>());
vi.mock("../openWindowsTracker.js", () => ({
  getPendingRemoteRestore,
  onPendingRemoteRestoreChanged: (listener: () => void) => {
    pendingListeners.add(listener);
    return () => pendingListeners.delete(listener);
  },
}));

const registry = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../windowRef.js", () => ({ getWindowRegistry: () => registry.current }));

const presenceListeners = vi.hoisted(() => new Set<() => void>());
vi.mock("../projectPresenceChanges.js", () => ({
  onProjectPresenceChanged: (listener: () => void) => {
    presenceListeners.add(listener);
    return () => presenceListeners.delete(listener);
  },
}));

import { appWindowStateTracking, resolveBoundsKey } from "../windowStateTracking.js";

const PATHS: Record<string, string> = {
  daintree: "/home/u/projects/daintree",
  "hello-web": "/home/u/projects/hello-web",
};

const SCRATCH = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const OTHER_SCRATCH = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const HOST_PROJECT = "a".repeat(64);
const ON_BUILD_BOX = `build-box:${HOST_PROJECT}`;
const ON_GPU_BOX = `gpu-box:${HOST_PROJECT}`;

let deletedScratches: Set<string>;

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

const shownKey = (w: ReturnType<typeof appWindow>) =>
  appWindowStateTracking.getShownBoundsKey(w.browserWindow as never);

beforeEach(() => {
  deletedScratches = new Set();
  db.readProjectPathSync.mockReset();
  db.readProjectPathSync.mockImplementation((id) => PATHS[id] ?? null);
  db.isLiveScratchSync.mockReset();
  db.isLiveScratchSync.mockImplementation((id) => !deletedScratches.has(id));
  getPendingRemoteRestore.mockReset();
  getPendingRemoteRestore.mockReturnValue(null);
  registry.current = null;
});

describe("resolveBoundsKey", () => {
  it("finds the folder of a window restored by project id", () => {
    expect(resolveBoundsKey(undefined, "hello-web")).toBe(PATHS["hello-web"]);
  });

  it("prefers a folder the window was opened for", () => {
    expect(resolveBoundsKey("/opened/folder", "hello-web")).toBe("/opened/folder");
    expect(db.readProjectPathSync).not.toHaveBeenCalled();
  });

  it("has no key for a picker or a project whose row is gone", () => {
    expect(resolveBoundsKey(null, undefined)).toBeNull();
    expect(resolveBoundsKey(undefined, "b".repeat(64))).toBeNull();
  });

  it("keys a scratch and a host's project apart from each other and from every folder", () => {
    const folders = [...Object.values(PATHS), "/", "C:\\Users\\u\\project", "\\\\server\\share"];
    const keys = [SCRATCH, OTHER_SCRATCH, ON_BUILD_BOX, ON_GPU_BOX].map((id) =>
      resolveBoundsKey(undefined, id)
    );

    expect(keys.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((key) => folders.includes(key!))).toBe(false);
  });

  it("never looks a scratch or a host's project up as a local project", () => {
    resolveBoundsKey(undefined, SCRATCH);
    resolveBoundsKey(undefined, ON_BUILD_BOX);

    expect(db.readProjectPathSync).not.toHaveBeenCalled();
  });

  it("has no key for a deleted scratch", () => {
    deletedScratches.add(SCRATCH);

    expect(resolveBoundsKey(undefined, SCRATCH)).toBeNull();
    expect(resolveBoundsKey(undefined, OTHER_SCRATCH)).not.toBeNull();
  });
});

describe("appWindowStateTracking", () => {
  it("names the project each window shows, not one shared answer", () => {
    const daintree = appWindow(1, "daintree");
    const helloWeb = appWindow(2, "hello-web");
    useWindows(daintree, helloWeb);

    expect(shownKey(daintree)).toBe(PATHS.daintree);
    expect(shownKey(helloWeb)).toBe(PATHS["hello-web"]);
  });

  it("names no project for a window without one on screen or not yet registered", () => {
    const picker = appWindow(1, null);
    useWindows(picker);

    expect(shownKey(picker)).toBeNull();
    expect(shownKey(appWindow(9, "daintree"))).toBeNull();
  });

  it("saves a scratch or host window under the key it is reopened with", () => {
    const windows = [appWindow(1, SCRATCH), appWindow(2, ON_BUILD_BOX), appWindow(3, ON_GPU_BOX)];
    useWindows(...windows);

    for (const w of windows) {
      const shown = shownKey(w);
      expect(shown).not.toBeNull();
      expect(shown).toBe(
        resolveBoundsKey(undefined, w.services.projectViewManager.getActiveProjectId() ?? undefined)
      );
    }
  });

  it("keeps a picker restored for a host's project on that project's key while it waits", () => {
    const waiting = appWindow(4, null);
    useWindows(waiting);
    getPendingRemoteRestore.mockImplementation((id) => (id === 4 ? ON_BUILD_BOX : null));

    expect(shownKey(waiting)).toBe(resolveBoundsKey(undefined, ON_BUILD_BOX));

    // The restore was given up (the host was removed, or the window was put to use).
    getPendingRemoteRestore.mockReturnValue(null);

    expect(shownKey(waiting)).toBeNull();
  });

  it("follows what a waiting window shows over the host's project it was waiting for", () => {
    const opened = appWindow(4, "hello-web");
    useWindows(opened);
    getPendingRemoteRestore.mockReturnValue(ON_BUILD_BOX);

    expect(shownKey(opened)).toBe(PATHS["hello-web"]);
  });

  it("stops keying a window on a scratch once the scratch is deleted", () => {
    const win = appWindow(1, SCRATCH);
    useWindows(win);
    expect(shownKey(win)).not.toBeNull();

    deletedScratches.add(SCRATCH);

    expect(shownKey(win)).toBeNull();
  });

  it("hears a window start or stop waiting for a host's project, as well as switches", () => {
    const listener = vi.fn();
    const unsubscribe = appWindowStateTracking.onShownProjectChange!(listener);

    for (const notify of [...presenceListeners, ...pendingListeners]) notify();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(presenceListeners.size + pendingListeners.size).toBe(0);
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
