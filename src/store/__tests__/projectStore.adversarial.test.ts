// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProjectShape = {
  id: string;
  name: string;
  path: string;
  emoji: string;
  lastOpened: number;
};

type StorageMock = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

type ProjectApi = {
  onUpdated?: (callback: (project: ProjectShape) => void) => () => void;
  onRemoved?: (callback: (projectId: string) => void) => () => void;
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
}));

const notifyMock = vi.hoisted(() => vi.fn());
const logErrorWithContextMock = vi.hoisted(() => vi.fn());
const setProjectIdGetterMock = vi.hoisted(() => vi.fn());

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
    clearListenerState();
    restoreLocalStorage();
    projectClientMock.getAll.mockResolvedValue([]);
    projectClientMock.getCurrent.mockResolvedValue(null);
    projectClientMock.switch.mockResolvedValue(undefined);
    projectClientMock.reopen.mockResolvedValue(undefined);
    projectClientMock.checkMissing.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreLocalStorage();
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

    updatedCallbacks[0](projectB);
    expect(useProjectStore.getState().projects).toEqual([projectB]);
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

    updatedCallbacks[0]({ ...projectA, name: "Updated A" });
    removedCallbacks[0](projectA.id);
    expect(useProjectStore.getState().projects).toEqual([]);
    expect(useProjectStore.getState().currentProject).toBeNull();

    useProjectStore.setState({ projects: [projectA], currentProject: projectA });
    removedCallbacks[0](projectA.id);
    updatedCallbacks[0]({ ...projectA, name: "Updated A" });
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
});
