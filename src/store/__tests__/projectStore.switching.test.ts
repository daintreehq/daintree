// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const projectClientMock = {
  getAll: vi.fn().mockResolvedValue([]),
  getCurrent: vi.fn().mockResolvedValue(null),
  add: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  switch: vi.fn().mockResolvedValue(undefined),
  reopen: vi.fn().mockResolvedValue(undefined),
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

const projectA = {
  id: "project-a",
  name: "Project A",
  path: "/tmp/project-a",
  emoji: "folder",
  lastOpened: Date.now(),
};

const projectB = {
  id: "project-b",
  name: "Project B",
  path: "/tmp/project-b",
  emoji: "folder",
  lastOpened: Date.now(),
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildOutgoingState draft propagation (#4985)", () => {
  it("sends empty draftInputs when drafts were cleared before switch", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { useTerminalInputStore } = await import("../terminalInputStore");

    // Set up current project
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    // Set a draft then clear it (simulates typing + submitting)
    useTerminalInputStore.getState().setDraftInput("terminal-1", "hello", projectA.id);
    useTerminalInputStore.getState().clearDraftInput("terminal-1", projectA.id);

    // Switch away — the cleared draft state should still be sent as {}
    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    expect(projectClientMock.switch).toHaveBeenCalledWith(projectB.id, { draftInputs: {} });
  });

  it("sends empty draftInputs when drafts were cleared before reopen", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { useTerminalInputStore } = await import("../terminalInputStore");

    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    useTerminalInputStore.getState().setDraftInput("terminal-1", "hello", projectA.id);
    useTerminalInputStore.getState().clearDraftInput("terminal-1", projectA.id);

    await useProjectStore.getState().reopenProject(projectB.id);
    await Promise.resolve();

    expect(projectClientMock.reopen).toHaveBeenCalledWith(projectB.id, { draftInputs: {} });
  });

  it("sends non-empty draftInputs when drafts exist", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { useTerminalInputStore } = await import("../terminalInputStore");

    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    useTerminalInputStore.getState().setDraftInput("terminal-1", "hello world", projectA.id);

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    expect(projectClientMock.switch).toHaveBeenCalledWith(projectB.id, {
      draftInputs: { "terminal-1": "hello world" },
    });
  });

  it("sends undefined outgoingState when no current project", async () => {
    const { useProjectStore } = await import("../projectStore");

    // No currentProject set
    useProjectStore.setState({ projects: [projectB], currentProject: null });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    expect(projectClientMock.switch).toHaveBeenCalledWith(projectB.id, undefined);
  });
});
