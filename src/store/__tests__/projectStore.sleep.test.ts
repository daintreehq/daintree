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

import { useProjectStore } from "../projectStore";

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

    it("returns main's result to the caller", async () => {
      const result = await useProjectStore.getState().sleepProject("proj-1");

      expect(result).toEqual({
        terminalsKilled: 1,
        rendererViewsEvicted: 0,
        workspaceEvicted: true,
      });
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
});
