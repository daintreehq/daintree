import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpenWindowRecord } from "../../services/persistence/windowManifest.js";

const writeOpenWindowsManifest = vi.fn<(records: OpenWindowRecord[]) => void>();

vi.mock("electron", () => ({
  app: { quit: vi.fn(), emit: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

// Explicit factories: the store reaches better-sqlite3 and the coordinator
// reaches electron's lifecycle, neither of which this suite should load.
vi.mock("../../services/persistence/windowManifestStore.js", () => ({
  writeOpenWindowsManifest: (records: OpenWindowRecord[]) => writeOpenWindowsManifest(records),
}));
vi.mock("../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => null,
}));
vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => ({ recordRendererGone: vi.fn() }),
}));
vi.mock("../../ipc/errorHandlers.js", () => ({ notifyError: vi.fn() }));
vi.mock("../../utils/systemMemory.js", () => ({ readAvailableSystemMemoryMb: () => null }));
vi.mock("../../utils/logger.js", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { attachAppViewRendererGoneHandler } from "../appViewRendererGone.js";
import { createWindowRecreation, type WindowRecreationDeps } from "../windowRecreation.js";
import {
  buildOpenWindowRecords,
  initOpenWindowsTracker,
  resetOpenWindowsTrackerForTests,
  saveOpenWindowsNow,
  setPendingBackgroundRestores,
  setPendingRemoteRestore,
} from "../openWindowsTracker.js";
import type { ProjectViewManager } from "../ProjectViewManager.js";
import type { WindowContext, WindowRegistry } from "../WindowRegistry.js";
import { isScratchWorkspaceId } from "../../../shared/utils/workspaceIds.js";

interface FakeWindow {
  windowId: number;
  activeProjectId: string | null;
  views: Array<{ projectId: string; lastUsed: number; webContentsId?: number }>;
  focused: boolean;
  destroyed: boolean;
}

/**
 * A registry that behaves like the real one at teardown: destroying a window
 * unregisters it and disposes its manager, so anything read after `destroy()`
 * finds nothing.
 */
function createFleet() {
  const windows = new Map<number, FakeWindow>();
  const contexts = new Map<number, WindowContext>();

  const managerFor = (win: FakeWindow) => ({
    getActiveProjectId: () => win.activeProjectId,
    getAllViews: () => win.views.map(({ projectId, lastUsed }) => ({ projectId, lastUsed })),
    getProjectIdForWebContents: (id: number) =>
      win.views.find((view) => view.webContentsId === id)?.projectId ?? null,
    notifyViewRendererGone: () => {},
    notifyActiveViewCrashed: () => false,
    evictCrashedCachedView: () => false,
    getLowMemoryFreeThresholdMb: () => null,
  });

  const registry = {
    focusOrder: () => [...contexts.values()],
    all: () => [...contexts.values()],
    getByWindowId: (id: number) => contexts.get(id),
  } as unknown as WindowRegistry;

  function open(init: Partial<FakeWindow> & { windowId: number }): FakeWindow {
    const win: FakeWindow = {
      activeProjectId: null,
      views: [],
      focused: true,
      destroyed: false,
      ...init,
    };
    windows.set(win.windowId, win);
    contexts.set(win.windowId, {
      windowId: win.windowId,
      browserWindow: {
        isDestroyed: () => win.destroyed,
        isFocused: () => win.focused,
      },
      services: { projectViewManager: managerFor(win) },
    } as unknown as WindowContext);
    return win;
  }

  function destroy(windowId: number): void {
    const win = windows.get(windowId);
    if (!win) return;
    win.destroyed = true;
    win.activeProjectId = null;
    win.views = [];
    contexts.delete(windowId);
  }

  return { registry, open, destroy, managerFor };
}

type CreateWindowSpy = ReturnType<typeof vi.fn<WindowRecreationDeps["createWindow"]>>;

/**
 * Wires a window the way main.ts's `createWindow` does: one recreation for the
 * window, handed to the real app-view crash handler, rebuilding through a
 * `createWindow` that registers the replacement.
 */
function wireWindow(
  fleet: ReturnType<typeof createFleet>,
  win: FakeWindow,
  opts: { appWebContentsId?: number; setup?: (replacement: FakeWindow) => Promise<void> } = {}
) {
  let nextId = 100;
  const createWindow: CreateWindowSpy = vi.fn(async (_projectId, createOpts) => {
    const replacement = fleet.open({ windowId: nextId++ });
    createOpts.onRegistered(replacement.windowId);
    await opts.setup?.(replacement);
    return "ok" as const;
  });
  const recreation = createWindowRecreation({
    windowRegistry: fleet.registry,
    getWindowId: () => win.windowId,
    createWindow,
  });

  type Handler = (event: unknown, details: { reason: string; exitCode: number }) => void;
  const handlers: Handler[] = [];
  const appWebContents = {
    id: opts.appWebContentsId ?? 1,
    on: (event: string, handler: Handler) => {
      if (event === "render-process-gone") handlers.push(handler);
    },
    reload: vi.fn(),
    loadURL: vi.fn(),
  };
  attachAppViewRendererGoneHandler({
    win: {
      get id() {
        return win.windowId;
      },
      isDestroyed: () => win.destroyed,
      destroy: () => fleet.destroy(win.windowId),
    } as never,
    appWebContents: appWebContents as never,
    getProjectViewManager: () =>
      (win.destroyed ? null : fleet.managerFor(win)) as unknown as ProjectViewManager | null,
    getRecoveryUrl: () => "app://daintree/recovery.html",
    prepareWindowRecreation: recreation.prepare,
  });
  const crashOom = () => {
    for (const handler of handlers) handler({}, { reason: "oom", exitCode: 1 });
  };
  return { createWindow, recreation, crashOom };
}

function lastWritten(): OpenWindowRecord[] {
  const calls = writeOpenWindowsManifest.mock.calls;
  return calls[calls.length - 1]![0];
}

describe("OOM window recreation (#15564)", () => {
  let fleet: ReturnType<typeof createFleet>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeOpenWindowsManifest.mockClear();
    resetOpenWindowsTrackerForTests();
    fleet = createFleet();
    initOpenWindowsTracker({ registry: fleet.registry, readOnly: false });
  });

  afterEach(() => {
    resetOpenWindowsTrackerForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rebuilds onto the project the window switched to, not the one it launched on", async () => {
    const win = fleet.open({
      windowId: 1,
      activeProjectId: "proj-a",
      views: [{ projectId: "proj-a", lastUsed: 1 }],
    });
    const { createWindow, crashOom } = wireWindow(fleet, win);
    win.activeProjectId = "proj-b";
    win.views = [
      { projectId: "proj-a", lastUsed: 1 },
      { projectId: "proj-b", lastUsed: 2 },
    ];

    crashOom();
    await vi.runAllTimersAsync();

    expect(win.destroyed).toBe(true);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledWith(
      "proj-b",
      expect.objectContaining({ backgroundProjectIds: ["proj-a"], revealMode: "show" })
    );
    expect(createWindow.mock.calls[0]![1].remoteWorkspaceKey).toBeUndefined();
  });

  it("brings back an unbound window on the project it opened since", async () => {
    const win = fleet.open({ windowId: 1 });
    const { createWindow, crashOom } = wireWindow(fleet, win);
    win.activeProjectId = "proj-b";
    win.views = [{ projectId: "proj-b", lastUsed: 1 }];

    crashOom();
    await vi.runAllTimersAsync();

    expect(createWindow).toHaveBeenCalledWith("proj-b", expect.anything());
  });

  it("brings back a window still on the picker as a picker", async () => {
    const win = fleet.open({ windowId: 1 });
    const { createWindow, crashOom } = wireWindow(fleet, win);

    crashOom();
    await vi.runAllTimersAsync();

    expect(createWindow).toHaveBeenCalledWith(undefined, expect.anything());
    expect(createWindow.mock.calls[0]![1].remoteWorkspaceKey).toBeUndefined();
  });

  it("brings back a scratch under its own id", async () => {
    const scratchId = "4b1d6f3e-2c8a-4e5b-9f7d-0a1b2c3d4e5f";
    expect(isScratchWorkspaceId(scratchId)).toBe(true);
    const win = fleet.open({ windowId: 1, activeProjectId: "proj-a" });
    const { createWindow, crashOom } = wireWindow(fleet, win);
    win.activeProjectId = scratchId;

    crashOom();
    await vi.runAllTimersAsync();

    expect(createWindow).toHaveBeenCalledWith(scratchId, expect.anything());
    expect(createWindow.mock.calls[0]![1].remoteWorkspaceKey).toBeUndefined();
  });

  it("sends a host-scoped workspace back to its host, never to a local project with its id", async () => {
    const projectB = "b".repeat(64);
    const win = fleet.open({ windowId: 1, activeProjectId: projectB });
    const { createWindow, crashOom } = wireWindow(fleet, win);
    win.activeProjectId = `devbox:${projectB}`;

    crashOom();
    await vi.runAllTimersAsync();

    expect(createWindow).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ remoteWorkspaceKey: `devbox:${projectB}` })
    );
  });

  it("keeps a restored window's host when it is still waiting to move there", async () => {
    const win = fleet.open({ windowId: 1 });
    setPendingRemoteRestore(1, "devbox:proj-b");
    const { createWindow, crashOom } = wireWindow(fleet, win);

    crashOom();
    await vi.runAllTimersAsync();

    expect(createWindow).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ remoteWorkspaceKey: "devbox:proj-b" })
    );
  });

  it("brings the window's warm workspaces back with it, most recent first", async () => {
    const win = fleet.open({
      windowId: 1,
      activeProjectId: "proj-b",
      views: [
        { projectId: "proj-b", lastUsed: 30 },
        { projectId: "proj-c", lastUsed: 10 },
        { projectId: "devbox:proj-h", lastUsed: 25 },
        { projectId: "proj-d", lastUsed: 20 },
      ],
    });
    setPendingBackgroundRestores(1, ["proj-e"]);
    const { createWindow, crashOom } = wireWindow(fleet, win);

    crashOom();
    await vi.runAllTimersAsync();

    // The manifest's own ordering: this machine's projects, then the hosts'.
    expect(createWindow.mock.calls[0]![1].backgroundProjectIds).toEqual([
      "proj-d",
      "proj-c",
      "proj-e",
      "devbox:proj-h",
    ]);
  });

  it("keeps the foreground when the view that died was cached behind it", async () => {
    const win = fleet.open({
      windowId: 1,
      activeProjectId: "proj-b",
      views: [
        { projectId: "proj-a", lastUsed: 1, webContentsId: 1 },
        { projectId: "proj-b", lastUsed: 2 },
      ],
    });
    const { createWindow, crashOom } = wireWindow(fleet, win, { appWebContentsId: 1 });

    crashOom();
    await vi.runAllTimersAsync();

    expect(createWindow).toHaveBeenCalledWith(
      "proj-b",
      expect.objectContaining({ backgroundProjectIds: ["proj-a"] })
    );
  });

  it("does not hand a workspace another window holds to the replacement", async () => {
    fleet.open({
      windowId: 2,
      activeProjectId: "proj-x",
      views: [
        { projectId: "proj-x", lastUsed: 5 },
        { projectId: "proj-c", lastUsed: 4 },
      ],
    });
    const win = fleet.open({ windowId: 1, activeProjectId: "proj-b" });
    setPendingBackgroundRestores(1, ["proj-c", "proj-x", "proj-d"]);
    const { createWindow, crashOom } = wireWindow(fleet, win);

    crashOom();
    await vi.runAllTimersAsync();

    expect(createWindow.mock.calls[0]![1].backgroundProjectIds).toEqual(["proj-d"]);
  });

  it("brings a window that was behind another back without taking focus", async () => {
    const win = fleet.open({ windowId: 1, activeProjectId: "proj-b", focused: false });
    const { createWindow, crashOom } = wireWindow(fleet, win);

    crashOom();
    await vi.runAllTimersAsync();

    expect(createWindow.mock.calls[0]![1].revealMode).toBe("showInactive");
  });

  it("rebuilds once when a second view dies before the first rebuild runs", async () => {
    const win = fleet.open({ windowId: 1, activeProjectId: "proj-b" });
    const { createWindow, recreation } = wireWindow(fleet, win);

    const first = recreation.prepare();
    win.activeProjectId = "proj-c";
    const second = recreation.prepare();
    fleet.destroy(1);
    await Promise.all([first!(), second!()]);

    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledWith("proj-b", expect.anything());
  });

  it("keeps the captured workspace in the manifest while the replacement sets up, then saves its own", async () => {
    const win = fleet.open({
      windowId: 1,
      activeProjectId: "proj-b",
      views: [
        { projectId: "proj-b", lastUsed: 2 },
        { projectId: "proj-c", lastUsed: 1 },
      ],
    });
    let replacement: FakeWindow | undefined;
    let finishSetup: (() => void) | undefined;
    const { recreation, crashOom } = wireWindow(fleet, win, {
      setup: (created) => {
        replacement = created;
        return new Promise<void>((resolve) => {
          finishSetup = resolve;
        });
      },
    });
    expect(recreation.isRecreating()).toBe(false);

    crashOom();
    expect(recreation.isRecreating()).toBe(true);
    await vi.runAllTimersAsync();

    // Setup is still running and has bound nothing: a save now (a focus
    // change, the window's own registration) still names what it was showing.
    saveOpenWindowsNow();
    expect(lastWritten()).toEqual([{ projectId: "proj-b", backgroundProjectIds: ["proj-c"] }]);

    replacement!.activeProjectId = "proj-b";
    replacement!.views = [{ projectId: "proj-b", lastUsed: 1 }];
    finishSetup!();
    await vi.runAllTimersAsync();

    // The held record is gone: the captured background list no longer rides
    // along, and the manifest reads the replacement's own state.
    expect(lastWritten()).toEqual([{ projectId: "proj-b" }]);
  });

  it("saves a picker once setup finds the captured workspace gone", async () => {
    const win = fleet.open({ windowId: 1, activeProjectId: "proj-gone" });
    const { createWindow, crashOom } = wireWindow(fleet, win);

    crashOom();
    await vi.runAllTimersAsync();

    expect(createWindow).toHaveBeenCalledWith("proj-gone", expect.anything());
    // The replacement's setup bound nothing, and the record it carried is let
    // go, so neither the save nor a later one names the missing workspace.
    expect(lastWritten()).toEqual([{ projectId: null }]);
    expect(buildOpenWindowRecords(fleet.registry)).toEqual([{ projectId: null }]);
  });

  it("keeps naming the captured workspace when the replacement's setup throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const win = fleet.open({
      windowId: 1,
      activeProjectId: "proj-b",
      views: [
        { projectId: "proj-b", lastUsed: 2 },
        { projectId: "proj-c", lastUsed: 1 },
      ],
    });
    let replacement: FakeWindow | undefined;
    const { crashOom } = wireWindow(fleet, win, {
      setup: (created) => {
        replacement = created;
        return Promise.reject(new Error("project store threw"));
      },
    });

    crashOom();
    await vi.runAllTimersAsync();

    // A throwing lookup is a failed boot, not a missing workspace.
    expect(lastWritten()).toEqual([{ projectId: "proj-b", backgroundProjectIds: ["proj-c"] }]);

    // The person opens another project there: the record, and the background
    // list it carried, are spent rather than following the window around.
    replacement!.activeProjectId = "proj-x";
    replacement!.views = [{ projectId: "proj-x", lastUsed: 1 }];
    expect(buildOpenWindowRecords(fleet.registry)).toEqual([{ projectId: "proj-x" }]);
    replacement!.activeProjectId = null;
    replacement!.views = [];
    expect(buildOpenWindowRecords(fleet.registry)).toEqual([{ projectId: null }]);
  });
});
