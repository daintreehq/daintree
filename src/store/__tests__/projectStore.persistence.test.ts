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

vi.mock("../worktreeDataStore", () => ({
  forceReinitializeWorktreeDataStore: vi.fn(),
  prePopulateWorktreeSnapshot: vi.fn(),
  snapshotProjectWorktrees: vi.fn(),
}));

vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: null,
    }),
  },
}));

vi.mock("../terminalStore", () => ({
  useTerminalStore: {
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
  flushTerminalPersistence: vi.fn(),
}));

vi.mock("../persistence/terminalPersistence", () => ({
  terminalPersistence: {
    setProjectIdGetter: vi.fn(),
  },
  terminalToSnapshot: vi.fn(),
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
});

afterEach(() => {
  restoreLocalStorage();
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
