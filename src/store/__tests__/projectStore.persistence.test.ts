// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const projectClientMock = {
  getAll: vi.fn().mockResolvedValue([]),
  getCurrent: vi.fn().mockResolvedValue(null),
  add: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  switch: vi.fn(),
  reopen: vi.fn(),
  openDialog: vi.fn(),
  onSwitch: vi.fn(() => () => {}),
  onWorktreeLoadStatus: vi.fn(() => () => {}),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  detectRunners: vi.fn(),
  close: vi.fn(),
  getStats: vi.fn(),
  setTerminals: vi.fn(),
  setTerminalSizes: vi.fn(),
  createFolder: vi.fn(),
};

vi.mock("@/clients", () => ({
  projectClient: projectClientMock,
}));

vi.mock("../resetStores", () => ({
  resetAllStoresForProjectSwitch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: null,
    }),
  },
}));

vi.mock("../panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      terminals: [],
    }),
  },
}));

vi.mock("../projectSettingsStore", () => ({
  useProjectSettingsStore: {
    getState: () => ({
      reset: vi.fn(),
      loadSettings: vi.fn().mockResolvedValue(undefined),
    }),
  },
  snapshotProjectSettings: vi.fn(),
  prePopulateProjectSettings: vi.fn(),
}));

vi.mock("../slices", () => ({
  flushPanelPersistence: vi.fn(),
}));

vi.mock("../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    cancel: vi.fn(),
  },
  panelToSnapshot: vi.fn(),
}));

const { viewWorkspaceIdMock } = vi.hoisted(() => ({
  viewWorkspaceIdMock: vi.fn<() => string | null>(() => null),
}));

vi.mock("../viewWorkspaceId", () => ({
  getViewWorkspaceId: viewWorkspaceIdMock,
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/utils/errorContext", () => ({
  logErrorWithContext: vi.fn(),
}));

vi.mock("@/services/projectSwitchRendererCache", () => ({
  prepareProjectSwitchRendererCache: vi.fn().mockReturnValue(null),
  cancelPreparedProjectSwitchRendererCache: vi.fn(),
}));

type StorageMock = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installLocalStorage(value: StorageMock): void {
  Object.defineProperty(globalThis, "localStorage", {
    value,
    configurable: true,
    writable: true,
  });
}

function createStorageMock(overrides: Partial<StorageMock> = {}): StorageMock {
  const storage = new Map<string, string>();

  return {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
    removeItem: (key) => {
      storage.delete(key);
    },
    ...overrides,
  };
}

function restoreLocalStorage(): void {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    return;
  }

  delete (globalThis as Partial<typeof globalThis>).localStorage;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  viewWorkspaceIdMock.mockReturnValue(null);
});

afterEach(() => {
  restoreLocalStorage();
});

describe("panel persistence workspace id (#11484)", () => {
  async function loadPersistenceGetter() {
    const { panelPersistence } = await import("../persistence/panelPersistence");
    await import("../projectStore");
    const getter = vi.mocked(panelPersistence.setProjectIdGetter).mock.calls[0]?.[0];
    if (!getter) throw new Error("panelPersistence.setProjectIdGetter was never wired");
    return getter;
  }

  it("falls back to the view's own workspace id when there is no project", async () => {
    // A scratch view has no Project row, so `currentProject` is null. Before the
    // fix the getter returned undefined and every save silently no-opped,
    // leaving the grid to die with the view.
    installLocalStorage(createStorageMock());
    viewWorkspaceIdMock.mockReturnValue("b3d1f2a4-5c6e-4a8b-9d0f-1e2a3b4c5d6e");

    const getter = await loadPersistenceGetter();

    expect(getter()).toBe("b3d1f2a4-5c6e-4a8b-9d0f-1e2a3b4c5d6e");
  });

  it("prefers the current project over the view id", async () => {
    installLocalStorage(createStorageMock());
    viewWorkspaceIdMock.mockReturnValue("b3d1f2a4-5c6e-4a8b-9d0f-1e2a3b4c5d6e");

    const getter = await loadPersistenceGetter();
    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({
      currentProject: {
        id: "project-1",
        name: "Project 1",
        path: "/tmp/project-1",
        emoji: "folder",
        lastOpened: Date.now(),
      } as unknown as NonNullable<ReturnType<typeof useProjectStore.getState>["currentProject"]>,
    });

    expect(getter()).toBe("project-1");
  });

  it("stays undefined when the view owns no workspace at all", async () => {
    // Persistence must still no-op for a view with no identity — a null
    // workspace is an identity, never a wildcard that writes somewhere else.
    installLocalStorage(createStorageMock());
    viewWorkspaceIdMock.mockReturnValue(null);

    const getter = await loadPersistenceGetter();

    expect(getter()).toBeUndefined();
  });

  it("refuses to persist into a closed project's state", async () => {
    // `currentProject` is null for a closed project too. Treating that as a
    // scratch would let a view that restored nothing overwrite the closed
    // project's saved grid with an empty one.
    installLocalStorage(createStorageMock());
    viewWorkspaceIdMock.mockReturnValue("project-closed");

    const getter = await loadPersistenceGetter();
    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({
      currentProject: null,
      projects: [
        {
          id: "project-closed",
          name: "Closed",
          path: "/tmp/closed",
          status: "closed",
        },
      ] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
    });

    expect(getter()).toBeUndefined();
  });
});

describe("projectStore persistence boundary hardening", () => {
  it("allows state updates when project persistence writes fail", async () => {
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })
    );

    const { useProjectStore } = await import("../projectStore");

    const project = {
      id: "project-1",
      name: "Project 1",
      path: "/tmp/project-1",
      emoji: "folder",
      lastOpened: Date.now(),
    };

    expect(() => {
      useProjectStore.setState({
        projects: [project],
        currentProject: project,
      });
    }).not.toThrow();

    expect(useProjectStore.getState().currentProject?.id).toBe("project-1");
    expect(useProjectStore.getState().projects).toHaveLength(1);
  });
});
