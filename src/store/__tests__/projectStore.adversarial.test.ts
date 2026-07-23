// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProjectShape = {
  id: string;
  name: string;
  path: string;
  emoji: string;
  lastOpened: number;
  status?: "active" | "background" | "closed";
};

type StorageMock = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

type ProjectApi = {
  onUpdated?: (callback: (project: ProjectShape) => void) => () => void;
  onRemoved?: (callback: (projectId: string) => void) => () => void;
  onOpenGitInitDialog?: (callback: (payload: { directoryPath: string }) => void) => () => void;
};

const projectClientMock = vi.hoisted(() => ({
  getAll: vi.fn<() => Promise<ProjectShape[]>>(),
  getCurrent: vi.fn<() => Promise<ProjectShape | null>>(),
  add: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  switch: vi.fn<(projectId: string, outgoingState?: unknown) => Promise<void>>(),
  reopen: vi.fn<(projectId: string, outgoingState?: unknown) => Promise<void>>(),
  openDialog: vi.fn(),
  enableInRepoSettings: vi.fn(),
  disableInRepoSettings: vi.fn(),
  checkMissing: vi.fn<() => Promise<void>>(),
  locate: vi.fn(),
  close: vi.fn(),
  createFolder: vi.fn(),
  onWorktreeLoadStatus: vi.fn(() => () => {}),
  onSwitch: vi.fn<
    (cb: (payload: { project: ProjectShape; switchId?: unknown }) => void) => () => void
  >(() => () => {}),
}));

const notifyMock = vi.hoisted(() => vi.fn());
const clearHibernateSessionMock = vi.hoisted(() => vi.fn());
const setHibernateSessionMock = vi.hoisted(() => vi.fn());
const hibernateSessionsMock = vi.hoisted(
  () => ({}) as Record<string, { sessionId: string; cwd: string; agentId: string }>
);
const logErrorWithContextMock = vi.hoisted(() => vi.fn());
const setProjectIdGetterMock = vi.hoisted(() => vi.fn());
const panelPersistenceCancelMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  projectClient: projectClientMock,
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

vi.mock("@/utils/errorContext", () => ({
  logErrorWithContext: logErrorWithContextMock,
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
}));

vi.mock("../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: setProjectIdGetterMock,
    cancel: panelPersistenceCancelMock,
  },
  panelToSnapshot: vi.fn((panel: { id: string; kind: string }) => ({
    id: panel.id,
    kind: panel.kind,
  })),
}));

vi.mock("../urlHistoryStore", () => ({
  useUrlHistoryStore: {
    getState: () => ({
      removeProjectHistory: vi.fn(),
    }),
  },
}));

vi.mock("../helpPanelStore", () => ({
  useHelpPanelStore: {
    getState: () => ({
      hibernateSessions: hibernateSessionsMock,
      setHibernateSession: setHibernateSessionMock,
      clearHibernateSession: clearHibernateSessionMock,
    }),
  },
}));

vi.mock("../terminalInputStore", () => ({
  useTerminalInputStore: {
    getState: () => ({
      getProjectDraftInputs: vi.fn(() => ({})),
    }),
  },
}));

vi.mock("@shared/utils/smokeTestTerminals", () => ({
  isSmokeTestTerminalId: vi.fn(() => false),
}));

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindowElectron = window.electron;
const LISTENER_STATE_KEY = "__daintreeProjectStoreListenerState";

const projectA: ProjectShape = {
  id: "project-a",
  name: "Project A",
  path: "/tmp/project-a",
  emoji: "folder",
  lastOpened: 1,
};

const projectB: ProjectShape = {
  id: "project-b",
  name: "Project B",
  path: "/tmp/project-b",
  emoji: "folder",
  lastOpened: 2,
};

const projectC: ProjectShape = {
  id: "project-c",
  name: "Project C",
  path: "/tmp/project-c",
  emoji: "folder",
  lastOpened: 3,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installLocalStorage(value: StorageMock): void {
  Object.defineProperty(globalThis, "localStorage", {
    value,
    configurable: true,
    writable: true,
  });
}

function restoreLocalStorage(): void {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    return;
  }
  delete (globalThis as Partial<typeof globalThis>).localStorage;
}

function createStorageMock(
  initial: Record<string, string> = {},
  throwOnFirstSet = false
): StorageMock {
  const storage = new Map<string, string>(Object.entries(initial));
  let firstSet = throwOnFirstSet;
  return {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      if (firstSet) {
        firstSet = false;
        throw new Error("QuotaExceededError");
      }
      storage.set(key, value);
    },
    removeItem: (key) => {
      storage.delete(key);
    },
  };
}

function installProjectApi(projectApi: ProjectApi): void {
  Object.defineProperty(window, "electron", {
    value: {
      ...(originalWindowElectron ?? {}),
      project: projectApi,
    },
    configurable: true,
    writable: true,
  });
}

function clearListenerState(): void {
  delete (globalThis as typeof globalThis & { [LISTENER_STATE_KEY]?: unknown })[LISTENER_STATE_KEY];
}

describe("projectStore adversarial", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    for (const key of Object.keys(hibernateSessionsMock)) {
      delete hibernateSessionsMock[key];
    }
    clearListenerState();
    restoreLocalStorage();
    projectClientMock.getAll.mockResolvedValue([]);
    projectClientMock.getCurrent.mockResolvedValue(null);
    projectClientMock.switch.mockResolvedValue(undefined);
    projectClientMock.reopen.mockResolvedValue(undefined);
    projectClientMock.close.mockResolvedValue({ processesKilled: 0, terminalsKilled: 0 });
    projectClientMock.checkMissing.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreLocalStorage();
    window.history.replaceState(null, "", "/");
    Object.defineProperty(window, "electron", {
      value: originalWindowElectron,
      configurable: true,
      writable: true,
    });
    clearListenerState();
    vi.restoreAllMocks();
  });

  it("hydrates safely from invalid JSON and structurally valid junk", async () => {
    installProjectApi({});
    installLocalStorage(
      createStorageMock({
        "project-storage": "{not valid json",
      })
    );

    let module = await import("../projectStore");
    expect(module.useProjectStore.getState().projects).toEqual([]);
    expect(module.useProjectStore.getState().currentProject).toBeNull();

    vi.resetModules();
    clearListenerState();
    installProjectApi({});
    installLocalStorage(
      createStorageMock({
        "project-storage": JSON.stringify({
          state: {
            projects: ["bad", { id: 1 }, projectA],
          },
          version: 0,
        }),
      })
    );

    module = await import("../projectStore");
    expect(module.useProjectStore.getState().projects).toEqual([projectA]);
    expect(module.useProjectStore.getState().currentProject).toBeNull();
  });

  it("avoids duplicate project event listeners across module reloads", async () => {
    const updatedCallbacks: Array<(project: ProjectShape) => void> = [];
    const removedCallbacks: Array<(projectId: string) => void> = [];
    const onUpdated = vi.fn((callback: (project: ProjectShape) => void) => {
      updatedCallbacks.push(callback);
      return vi.fn();
    });
    const onRemoved = vi.fn((callback: (projectId: string) => void) => {
      removedCallbacks.push(callback);
      return vi.fn();
    });
    installProjectApi({ onUpdated, onRemoved });
    installLocalStorage(createStorageMock());

    await import("../projectStore");
    vi.resetModules();
    await import("../projectStore");
    vi.resetModules();
    const { useProjectStore } = await import("../projectStore");

    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledTimes(1);

    updatedCallbacks[0]!(projectB);
    expect(useProjectStore.getState().projects).toEqual([projectB]);
  });

  // #11281: main pushes this when a folder opened via the Dock/Cmd+O/Recent
  // isn't a repo yet. Registration lives at module scope so it is wired before
  // the renderer finishes loading, which is when the cold-launch send arrives.
  it("opens the git-init dialog when main pushes a non-repository folder", async () => {
    const callbacks: Array<(payload: { directoryPath: string }) => void> = [];
    const onOpenGitInitDialog = vi.fn((callback: (payload: { directoryPath: string }) => void) => {
      callbacks.push(callback);
      return vi.fn();
    });
    installProjectApi({ onOpenGitInitDialog });
    installLocalStorage(createStorageMock());

    await import("../projectStore");
    vi.resetModules();
    const { useProjectStore } = await import("../projectStore");

    expect(onOpenGitInitDialog).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().gitInitDialogOpen).toBe(false);

    callbacks[0]!({ directoryPath: "/repos/not-a-repo" });

    expect(useProjectStore.getState().gitInitDialogOpen).toBe(true);
    expect(useProjectStore.getState().gitInitDirectoryPath).toBe("/repos/not-a-repo");
    // Nothing is written until the user confirms in-dialog.
    expect(projectClientMock.add).not.toHaveBeenCalled();

    // Dropping a second folder must not swap the path under the open dialog:
    // mid-initialization that would init the first folder and then add the
    // second, since the success handler rereads the store.
    callbacks[0]!({ directoryPath: "/repos/second-folder" });
    expect(useProjectStore.getState().gitInitDirectoryPath).toBe("/repos/not-a-repo");

    useProjectStore.getState().closeGitInitDialog();
    expect(useProjectStore.getState().gitInitDialogOpen).toBe(false);
    expect(useProjectStore.getState().gitInitDirectoryPath).toBeNull();
    expect(projectClientMock.add).not.toHaveBeenCalled();
  });

  it("ignores stale switch rejections once a newer switch has started", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    const firstSwitch = deferred<void>();
    const secondSwitch = deferred<void>();
    projectClientMock.switch
      .mockReturnValueOnce(firstSwitch.promise)
      .mockReturnValueOnce(secondSwitch.promise);

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({
      currentProject: projectA,
      projects: [projectA, projectB, projectC],
    });

    await useProjectStore.getState().switchProject(projectB.id);
    await useProjectStore.getState().switchProject(projectC.id);

    secondSwitch.resolve(undefined);
    await Promise.resolve();
    firstSwitch.reject(new Error("stale switch failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(useProjectStore.getState().error).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("prevents an older checkMissing refresh from overwriting a newer loadProjects result", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    const checkMissingGate = deferred<void>();
    projectClientMock.getAll
      .mockResolvedValueOnce([projectA])
      .mockResolvedValueOnce([projectB])
      .mockResolvedValueOnce([projectA])
      .mockResolvedValueOnce([projectB]);
    projectClientMock.checkMissing.mockReturnValue(checkMissingGate.promise);

    const { useProjectStore } = await import("../projectStore");

    await useProjectStore.getState().loadProjects();
    await useProjectStore.getState().loadProjects();

    expect(useProjectStore.getState().projects).toEqual([projectB]);

    checkMissingGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(useProjectStore.getState().projects).toEqual([projectB]);
  });

  it("seeds the current project from the project-view URL when the project list loads", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    window.history.replaceState(null, "", "/?projectId=project-a");
    projectClientMock.getAll.mockResolvedValueOnce([projectA]);

    const { useProjectStore } = await import("../projectStore");

    await useProjectStore.getState().loadProjects();

    expect(useProjectStore.getState().currentProject).toEqual(projectA);
  });

  it("keeps the URL project when getCurrentProject races before main reports it current", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    window.history.replaceState(null, "", "/?projectId=project-a");
    projectClientMock.getCurrent.mockResolvedValueOnce(null);

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA], currentProject: null });

    await useProjectStore.getState().getCurrentProject();

    expect(useProjectStore.getState().currentProject).toEqual(projectA);
  });

  it("retries the current project lookup while the project-view URL is still active", async () => {
    vi.useFakeTimers();
    installProjectApi({});
    installLocalStorage(createStorageMock());
    window.history.replaceState(null, "", "/?projectId=project-a");
    projectClientMock.getCurrent.mockResolvedValueOnce(null).mockResolvedValueOnce(projectA);

    const { useProjectStore } = await import("../projectStore");
    const currentProjectPromise = useProjectStore.getState().getCurrentProject();

    await vi.advanceTimersByTimeAsync(100);
    await currentProjectPromise;

    expect(projectClientMock.getCurrent).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().currentProject).toEqual(projectA);
    expect(useProjectStore.getState().isLoading).toBe(false);
  });

  it("applies onUpdated and onRemoved deterministically in either order", async () => {
    const updatedCallbacks: Array<(project: ProjectShape) => void> = [];
    const removedCallbacks: Array<(projectId: string) => void> = [];
    installProjectApi({
      onUpdated: (callback) => {
        updatedCallbacks.push(callback);
        return vi.fn();
      },
      onRemoved: (callback) => {
        removedCallbacks.push(callback);
        return vi.fn();
      },
    });
    installLocalStorage(createStorageMock());

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA], currentProject: projectA });

    updatedCallbacks[0]!({ ...projectA, name: "Updated A" });
    removedCallbacks[0]!(projectA.id);
    expect(useProjectStore.getState().projects).toEqual([]);
    expect(useProjectStore.getState().currentProject).toBeNull();

    useProjectStore.setState({ projects: [projectA], currentProject: projectA });
    removedCallbacks[0]!(projectA.id);
    updatedCallbacks[0]!({ ...projectA, name: "Updated A" });
    expect(useProjectStore.getState().projects).toEqual([{ ...projectA, name: "Updated A" }]);
    expect(useProjectStore.getState().currentProject).toBeNull();
  });

  it("keeps the store writable after persistence falls back to in-memory storage", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock({}, true));

    const { useProjectStore } = await import("../projectStore");

    expect(() => {
      useProjectStore.setState({ projects: [projectA], currentProject: projectA });
      useProjectStore.setState({ projects: [projectB], currentProject: projectB });
    }).not.toThrow();

    expect(useProjectStore.getState().projects).toEqual([projectB]);
    expect(useProjectStore.getState().currentProject).toEqual(projectB);
  });

  it("clears active project renderer state without resurrecting persisted panels", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    const closeResult = { processesKilled: 2, terminalsKilled: 2 };
    const clearPanelStoreForSwitch = vi.fn();
    projectClientMock.close.mockResolvedValueOnce(closeResult);

    const { useProjectStore } = await import("../projectStore");
    const { setPanelStoreClearForSwitchAccessor } = await import("../storeAccessors");
    setPanelStoreClearForSwitchAccessor(clearPanelStoreForSwitch);

    useProjectStore.setState({
      projects: [projectA],
      currentProject: projectA,
      worktreeLoadError: "stale worktree error",
    });

    await expect(useProjectStore.getState().closeActiveProject(projectA.id)).resolves.toEqual(
      closeResult
    );

    expect(projectClientMock.close).toHaveBeenCalledWith(projectA.id, { killTerminals: true });
    expect(panelPersistenceCancelMock).toHaveBeenCalledTimes(2);
    expect(clearPanelStoreForSwitch).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().currentProject).toBeNull();
    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
    expect(projectClientMock.getAll).toHaveBeenCalled();
  });

  it("ignores stale project reads that finish after active project close", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    window.history.replaceState(null, "", "/?projectId=project-a");

    const staleProjects = deferred<ProjectShape[]>();
    const staleCurrent = deferred<ProjectShape | null>();
    const closeResult = { processesKilled: 2, terminalsKilled: 2 };
    const closedProjectA = { ...projectA, status: "closed" as const };

    projectClientMock.getAll.mockReset();
    projectClientMock.getAll.mockResolvedValue([closedProjectA]);
    projectClientMock.getAll
      .mockImplementationOnce(() => staleProjects.promise)
      .mockResolvedValueOnce([closedProjectA]);
    projectClientMock.getCurrent.mockReset();
    projectClientMock.getCurrent.mockImplementationOnce(() => staleCurrent.promise);
    projectClientMock.close.mockResolvedValueOnce(closeResult);

    const { useProjectStore } = await import("../projectStore");

    useProjectStore.setState({
      projects: [projectA],
      currentProject: projectA,
    });

    const pendingLoad = useProjectStore.getState().loadProjects();
    const pendingCurrent = useProjectStore.getState().getCurrentProject();

    await expect(useProjectStore.getState().closeActiveProject(projectA.id)).resolves.toEqual(
      closeResult
    );

    staleProjects.resolve([projectA]);
    staleCurrent.resolve(projectA);
    await Promise.all([pendingLoad, pendingCurrent]);

    expect(useProjectStore.getState().projects).toEqual([closedProjectA]);
    expect(useProjectStore.getState().currentProject).toBeNull();
  });

  it("garbage-collects the hibernate session when a project is removed", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    projectClientMock.remove.mockResolvedValueOnce(undefined);
    projectClientMock.getAll.mockResolvedValue([]);

    const { useProjectStore } = await import("../projectStore");
    await useProjectStore.getState().removeProject(projectA.id);

    expect(clearHibernateSessionMock).toHaveBeenCalledTimes(1);
    expect(clearHibernateSessionMock).toHaveBeenCalledWith(projectA.id);
  });

  it("does not GC the hibernate session when project removal fails", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    projectClientMock.remove.mockRejectedValueOnce(new Error("remove failed"));

    const { useProjectStore } = await import("../projectStore");
    await useProjectStore.getState().removeProject(projectA.id);

    expect(clearHibernateSessionMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().error).toBe("Failed to remove project");
  });

  it("carries the hibernate session over if locating still changes the id", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    hibernateSessionsMock[projectA.id] = {
      sessionId: "session-1",
      cwd: "/tmp/project-a",
      agentId: "claude",
    };
    const relocated = { ...projectA, id: "project-a-relocated", path: "/tmp/project-a-moved" };
    projectClientMock.locate.mockResolvedValueOnce(relocated);
    projectClientMock.getAll.mockResolvedValue([relocated]);

    const { useProjectStore } = await import("../projectStore");
    await useProjectStore.getState().locateProject(projectA.id);

    // Preserved under the new id and repointed at the new folder — the whole
    // point of #11282 is that relocating never costs the user a conversation.
    expect(setHibernateSessionMock).toHaveBeenCalledWith("project-a-relocated", {
      sessionId: "session-1",
      cwd: "/tmp/project-a-moved",
      agentId: "claude",
    });
    expect(clearHibernateSessionMock).toHaveBeenCalledWith(projectA.id);
  });

  it("still refreshes the project list when hibernate migration fails", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    setHibernateSessionMock.mockImplementationOnce(() => {
      throw new Error("store unavailable");
    });
    hibernateSessionsMock[projectA.id] = {
      sessionId: "session-1",
      cwd: "/tmp/project-a",
      agentId: "claude",
    };
    const relocated = { ...projectA, id: "project-a-relocated", path: "/tmp/project-a-moved" };
    projectClientMock.locate.mockResolvedValueOnce(relocated);
    projectClientMock.getAll.mockResolvedValue([relocated]);

    const { useProjectStore } = await import("../projectStore");
    await useProjectStore.getState().locateProject(projectA.id);

    // The throwing setter must actually have been reached, and its failure must
    // not cost the caller its list refresh or drop the surviving old entry.
    expect(setHibernateSessionMock).toHaveBeenCalledTimes(1);
    expect(clearHibernateSessionMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects).toEqual([relocated]);
  });

  it("does not GC the hibernate session when locating returns the same id", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    projectClientMock.locate.mockResolvedValueOnce({ ...projectA });
    projectClientMock.getAll.mockResolvedValue([projectA]);

    const { useProjectStore } = await import("../projectStore");
    await useProjectStore.getState().locateProject(projectA.id);

    expect(clearHibernateSessionMock).not.toHaveBeenCalled();
  });

  it("does not GC the hibernate session when locate returns null", async () => {
    installProjectApi({});
    installLocalStorage(createStorageMock());
    projectClientMock.locate.mockResolvedValueOnce(null);

    const { useProjectStore } = await import("../projectStore");
    await useProjectStore.getState().locateProject(projectA.id);

    expect(clearHibernateSessionMock).not.toHaveBeenCalled();
  });

  it("rebases the hibernated Assistant cwd when onUpdated changes the path (same id, #11282)", async () => {
    const updatedCallbacks: Array<(project: ProjectShape) => void> = [];
    installProjectApi({
      onUpdated: (callback) => {
        updatedCallbacks.push(callback);
        return vi.fn();
      },
    });
    installLocalStorage(createStorageMock());
    hibernateSessionsMock[projectA.id] = {
      sessionId: "session-1",
      cwd: `${projectA.path}/sub`,
      agentId: "claude",
    };

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA], currentProject: projectA });

    updatedCallbacks[0]!({ ...projectA, path: "/tmp/project-a-moved" });

    // Same id, new folder: the resume pointer is repointed in place, never GC'd.
    expect(setHibernateSessionMock).toHaveBeenCalledWith(projectA.id, {
      sessionId: "session-1",
      cwd: "/tmp/project-a-moved/sub",
      agentId: "claude",
    });
    expect(clearHibernateSessionMock).not.toHaveBeenCalled();
  });

  it("leaves the hibernated cwd untouched when onUpdated does not change the path", async () => {
    const updatedCallbacks: Array<(project: ProjectShape) => void> = [];
    installProjectApi({
      onUpdated: (callback) => {
        updatedCallbacks.push(callback);
        return vi.fn();
      },
    });
    installLocalStorage(createStorageMock());
    hibernateSessionsMock[projectA.id] = {
      sessionId: "session-1",
      cwd: projectA.path,
      agentId: "claude",
    };

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA], currentProject: projectA });

    updatedCallbacks[0]!({ ...projectA, name: "Renamed only" });

    expect(setHibernateSessionMock).not.toHaveBeenCalled();
  });
});
