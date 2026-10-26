// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted: vi.mock factories are lifted above module-scope consts, so a
// plain `const` referenced inside one is still in its temporal dead zone.
const { projectClientMock, panelPersistenceMock } = vi.hoisted(() => ({
  projectClientMock: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    onSwitch: vi.fn(() => () => {}),
    onWorktreeLoadStatus: vi.fn(() => () => {}),
    sleepProject: vi.fn(),
    switch: vi.fn(),
    setTerminals: vi.fn(),
    setTerminalSizes: vi.fn(),
  },
  panelPersistenceMock: {
    setProjectIdGetter: vi.fn(),
    cancel: vi.fn(),
    flush: vi.fn(),
    whenIdle: vi.fn<() => Promise<void>>(),
  },
}));

// Both exports: projectStore imports worktreeClient too, and a partial module
// mock would leave that one undefined at call time rather than failing loudly.
vi.mock("@/clients", () => ({
  projectClient: projectClientMock,
  worktreeClient: { retryProjectLoad: vi.fn() },
}));
vi.mock("../persistence/panelPersistence", () => ({
  panelPersistence: panelPersistenceMock,
  panelToSnapshot: vi.fn(),
}));

vi.mock("../resetStores", () => ({
  resetAllStoresForProjectSwitch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({ activeWorktreeId: null }) },
}));
vi.mock("../panelStore", () => ({
  usePanelStore: { getState: () => ({ terminals: [] }) },
}));
vi.mock("../projectSettingsStore", () => ({
  useProjectSettingsStore: {
    getState: () => ({ reset: vi.fn(), loadSettings: vi.fn().mockResolvedValue(undefined) }),
  },
  snapshotProjectSettings: vi.fn(),
  prePopulateProjectSettings: vi.fn(),
}));
vi.mock("../slices", () => ({ flushPanelPersistence: vi.fn() }));
vi.mock("../viewWorkspaceId", () => ({ getViewWorkspaceId: vi.fn(() => null) }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/errorContext", () => ({ logErrorWithContext: vi.fn() }));
vi.mock("@/services/projectSwitchRendererCache", () => ({
  prepareProjectSwitchRendererCache: vi.fn().mockReturnValue(null),
  cancelPreparedProjectSwitchRendererCache: vi.fn(),
}));

import {
  claimDroppedViewRestore,
  isDroppedViewLayoutPending,
  isDroppedViewRestorePending,
  onDroppedViewRestored,
  runDroppedViewRestore,
  useProjectStore,
} from "../projectStore";

const PROJECT = { id: "proj-1", name: "One", path: "/repo/one" };

/** A promise plus its resolver, so a test can hold a step open mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setCurrentProject(project: typeof PROJECT | null) {
  useProjectStore.setState({ currentProject: project as never });
}

describe("projectStore.sleepProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    panelPersistenceMock.whenIdle.mockResolvedValue(undefined);
    projectClientMock.sleepProject.mockResolvedValue({
      terminalsKilled: 1,
      rendererViewsEvicted: 0,
      workspaceEvicted: true,
    });
    projectClientMock.getAll.mockResolvedValue([]);
    setCurrentProject(null);
  });

  describe("the active project", () => {
    beforeEach(() => setCurrentProject(PROJECT));

    it("lands the pending layout BEFORE main captures session ids into it", async () => {
      // Main writes each captured agentSessionId into the saved panel
      // snapshots. agentSessionId is the only field the renderer's save delta
      // tracks, so a queued save landing after that write would clobber exactly
      // what sleeping the project exists to capture.
      const idle = deferred<void>();
      panelPersistenceMock.whenIdle.mockReturnValue(idle.promise);

      const pending = useProjectStore.getState().sleepProject("proj-1");

      // Still waiting on the flush — main must not have been asked yet.
      await Promise.resolve();
      expect(panelPersistenceMock.flush).toHaveBeenCalled();
      expect(projectClientMock.sleepProject).not.toHaveBeenCalled();

      idle.resolve();
      await pending;

      expect(projectClientMock.sleepProject).toHaveBeenCalledWith("proj-1");
    });

    it("stops further saves only after main has written the ids back", async () => {
      // Cancelling before the IPC resolves would be pointless; cancelling after
      // is what stops a post-writeback save from reverting the ids.
      const ipc = deferred<{
        terminalsKilled: number;
        rendererViewsEvicted: number;
        workspaceEvicted: boolean;
      }>();
      projectClientMock.sleepProject.mockReturnValue(ipc.promise);

      const pending = useProjectStore.getState().sleepProject("proj-1");
      await Promise.resolve();
      await Promise.resolve();

      expect(panelPersistenceMock.cancel).not.toHaveBeenCalled();

      ipc.resolve({ terminalsKilled: 0, rendererViewsEvicted: 0, workspaceEvicted: false });
      await pending;

      expect(panelPersistenceMock.cancel).toHaveBeenCalled();
    });

    it("drops the window to the no-project state", async () => {
      await useProjectStore.getState().sleepProject("proj-1");

      expect(useProjectStore.getState().currentProject).toBeNull();
    });

    it("keeps the project on screen when the teardown fails", async () => {
      // A failed sleep must not leave the window showing nothing while its
      // terminals are still alive.
      projectClientMock.sleepProject.mockRejectedValue(new Error("host gone"));

      await expect(useProjectStore.getState().sleepProject("proj-1")).rejects.toThrow("host gone");

      expect(useProjectStore.getState().currentProject).toEqual(PROJECT);
      expect(panelPersistenceMock.cancel).not.toHaveBeenCalled();
    });
  });

  describe("a background project", () => {
    it("does not touch this window's pending saves or its current project", async () => {
      // The renderer only ever queues saves for the project it is showing, so
      // there is nothing of the background project's to flush — and flushing
      // would push THIS project's layout for no reason.
      const other = { id: "proj-2", name: "Two", path: "/repo/two" };
      setCurrentProject(other);

      await useProjectStore.getState().sleepProject("proj-1");

      expect(panelPersistenceMock.flush).not.toHaveBeenCalled();
      expect(panelPersistenceMock.whenIdle).not.toHaveBeenCalled();
      expect(panelPersistenceMock.cancel).not.toHaveBeenCalled();
      expect(useProjectStore.getState().currentProject).toEqual(other);
    });
  });

  // Main reuses the dropped view when the project is reopened in it, so the
  // layout has to be restored here, once, and nothing may save the empty store
  // over it in the meantime (#14179).
  describe("the dropped view", () => {
    beforeEach(() => setCurrentProject(PROJECT));

    it("holds the layout as pending until one claimed restore finishes", async () => {
      await useProjectStore.getState().sleepProject("proj-1");
      expect(isDroppedViewLayoutPending("proj-1")).toBe(true);

      expect(claimDroppedViewRestore("other")).toBe(false);
      expect(claimDroppedViewRestore("proj-1")).toBe(true);
      expect(claimDroppedViewRestore("proj-1")).toBe(false);
      // Claimed is not restored: the store still lacks the layout.
      expect(isDroppedViewLayoutPending("proj-1")).toBe(true);

      await runDroppedViewRestore("proj-1", async () => {});
      expect(isDroppedViewLayoutPending("proj-1")).toBe(false);
      expect(claimDroppedViewRestore("proj-1")).toBe(false);
    });

    it("tells whoever waits on the layout once it is back, and not for a failed restore", async () => {
      await useProjectStore.getState().sleepProject("proj-1");
      const heard = vi.fn();
      const off = onDroppedViewRestored(heard);
      expect(isDroppedViewRestorePending()).toBe(true);

      expect(claimDroppedViewRestore("proj-1")).toBe(true);
      await expect(
        runDroppedViewRestore("proj-1", () => Promise.reject(new Error("hydrate failed")))
      ).rejects.toThrow("hydrate failed");
      expect(heard).not.toHaveBeenCalled();
      expect(isDroppedViewRestorePending()).toBe(true);

      expect(claimDroppedViewRestore("proj-1")).toBe(true);
      await runDroppedViewRestore("proj-1", async () => {});
      expect(heard).toHaveBeenCalledTimes(1);
      expect(isDroppedViewRestorePending()).toBe(false);
      off();
    });

    it("hands a failed restore back for the next reopen", async () => {
      await useProjectStore.getState().sleepProject("proj-1");
      expect(claimDroppedViewRestore("proj-1")).toBe(true);

      await expect(
        runDroppedViewRestore("proj-1", () => Promise.reject(new Error("hydrate failed")))
      ).rejects.toThrow("hydrate failed");

      expect(isDroppedViewLayoutPending("proj-1")).toBe(true);
      expect(claimDroppedViewRestore("proj-1")).toBe(true);
      await runDroppedViewRestore("proj-1", async () => {});
    });

    it("sends no outgoing snapshot when switching away before the restore", async () => {
      await useProjectStore.getState().sleepProject("proj-1");
      // Toolbar's switch listener re-reads the current project as soon as the
      // reopen lands, before the restore has put any panels back.
      setCurrentProject(PROJECT);
      projectClientMock.switch.mockResolvedValue({ outcome: "switched", project: {} });

      await useProjectStore.getState().switchProject("proj-2");

      expect(projectClientMock.switch).toHaveBeenCalledWith("proj-2", undefined, expect.anything());
      expect(claimDroppedViewRestore("proj-1")).toBe(true);
      await runDroppedViewRestore("proj-1", async () => {});
    });

    it("keeps a newer drop pending when an older restore finishes after it", async () => {
      // Another window can sleep the project while this one is still restoring.
      await useProjectStore.getState().sleepProject("proj-1");
      expect(claimDroppedViewRestore("proj-1")).toBe(true);
      const restore = deferred<void>();
      const restoring = runDroppedViewRestore("proj-1", () => restore.promise);
      setCurrentProject(PROJECT);
      useProjectStore.getState().dropToNoProject();

      restore.resolve();
      await restoring;

      expect(isDroppedViewLayoutPending("proj-1")).toBe(true);
      expect(claimDroppedViewRestore("proj-1")).toBe(true);
      await runDroppedViewRestore("proj-1", async () => {});
    });

    it("waits for a restore still in flight before sleeping again", async () => {
      await useProjectStore.getState().sleepProject("proj-1");
      expect(claimDroppedViewRestore("proj-1")).toBe(true);
      const restore = deferred<void>();
      const restoring = runDroppedViewRestore("proj-1", () => restore.promise);
      setCurrentProject(PROJECT);
      projectClientMock.sleepProject.mockClear();

      const sleeping = useProjectStore.getState().sleepProject("proj-1");
      await Promise.resolve();
      await Promise.resolve();
      expect(projectClientMock.sleepProject).not.toHaveBeenCalled();

      restore.resolve();
      await restoring;
      await sleeping;
      expect(projectClientMock.sleepProject).toHaveBeenCalledWith("proj-1");
    });
  });
});
