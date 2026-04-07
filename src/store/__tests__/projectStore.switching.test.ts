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

let mockActiveWorktreeId: string | null = null;
vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: mockActiveWorktreeId,
    }),
  },
}));

vi.mock("../terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      terminals: [],
      terminalsById: {},
      terminalIds: [],
      tabGroups: new Map(),
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
  terminalToSnapshot: vi.fn((t: { id: string; kind: string }) => ({
    id: t.id,
    kind: t.kind,
  })),
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/utils/errorContext", () => ({
  logErrorWithContext: vi.fn(),
}));

vi.mock("@shared/utils/smokeTestTerminals", () => ({
  isSmokeTestTerminalId: vi.fn((id: string) => id.startsWith("smoke-test-")),
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
  mockActiveWorktreeId = null;
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

    expect(projectClientMock.switch).toHaveBeenCalledWith(
      projectB.id,
      expect.objectContaining({ draftInputs: {} })
    );
  });

  it("sends empty draftInputs when drafts were cleared before reopen", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { useTerminalInputStore } = await import("../terminalInputStore");

    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    useTerminalInputStore.getState().setDraftInput("terminal-1", "hello", projectA.id);
    useTerminalInputStore.getState().clearDraftInput("terminal-1", projectA.id);

    await useProjectStore.getState().reopenProject(projectB.id);
    await Promise.resolve();

    expect(projectClientMock.reopen).toHaveBeenCalledWith(
      projectB.id,
      expect.objectContaining({ draftInputs: {} })
    );
  });

  it("sends non-empty draftInputs when drafts exist", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { useTerminalInputStore } = await import("../terminalInputStore");

    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    useTerminalInputStore.getState().setDraftInput("terminal-1", "hello world", projectA.id);

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    expect(projectClientMock.switch).toHaveBeenCalledWith(
      projectB.id,
      expect.objectContaining({ draftInputs: { "terminal-1": "hello world" } })
    );
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

describe("buildOutgoingState terminal/tabGroup snapshot (#5001)", () => {
  it("includes browser panel snapshots in outgoing terminals", async () => {
    const { setTerminalStoreGetter } = await import("../projectStore");
    const browserPanel = {
      id: "browser-1",
      kind: "browser",
      title: "Browser",
      location: "grid",
      browserUrl: "https://example.com",
    };
    setTerminalStoreGetter(() => ({
      terminalsById: { "browser-1": browserPanel } as never,
      terminalIds: ["browser-1"],
      tabGroups: new Map(),
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0][1];
    expect(outgoing.terminals).toEqual([{ id: "browser-1", kind: "browser" }]);
  });

  it("includes dev-preview panel snapshots in outgoing terminals", async () => {
    const { setTerminalStoreGetter } = await import("../projectStore");
    const devPreview = {
      id: "dev-1",
      kind: "dev-preview",
      title: "Dev Preview",
      location: "grid",
    };
    setTerminalStoreGetter(() => ({
      terminalsById: { "dev-1": devPreview } as never,
      terminalIds: ["dev-1"],
      tabGroups: new Map(),
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0][1];
    expect(outgoing.terminals).toEqual([{ id: "dev-1", kind: "dev-preview" }]);
  });

  it("excludes trash, background, assistant, and smoke-test panels", async () => {
    const { setTerminalStoreGetter } = await import("../projectStore");
    const panels = {
      "t-trash": { id: "t-trash", kind: "terminal", location: "trash" },
      "t-bg": { id: "t-bg", kind: "terminal", location: "background" },
      "t-assistant": { id: "t-assistant", kind: "assistant", location: "grid" },
      "smoke-test-1": { id: "smoke-test-1", kind: "terminal", location: "grid" },
      "t-keep": { id: "t-keep", kind: "browser", location: "grid" },
    } as never;
    setTerminalStoreGetter(() => ({
      terminalsById: panels,
      terminalIds: Object.keys(panels),
      tabGroups: new Map(),
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0][1];
    expect(outgoing.terminals).toHaveLength(1);
    expect(outgoing.terminals[0].id).toBe("t-keep");
  });

  it("includes multi-panel tab groups, excludes single-panel groups", async () => {
    const { setTerminalStoreGetter } = await import("../projectStore");
    const tabGroups = new Map([
      ["g1", { id: "g1", location: "grid" as const, activeTabId: "a", panelIds: ["a", "b"] }],
      ["g2", { id: "g2", location: "grid" as const, activeTabId: "c", panelIds: ["c"] }],
    ]);
    setTerminalStoreGetter(() => ({
      terminalsById: {} as never,
      terminalIds: [],
      tabGroups,
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0][1];
    expect(outgoing.tabGroups).toEqual([
      { id: "g1", location: "grid", activeTabId: "a", panelIds: ["a", "b"] },
    ]);
  });

  it("sends empty tabGroups array to clear stale groups when none exist", async () => {
    const { setTerminalStoreGetter } = await import("../projectStore");
    setTerminalStoreGetter(() => ({
      terminalsById: {} as never,
      terminalIds: [],
      tabGroups: new Map(),
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0][1];
    expect(outgoing.tabGroups).toEqual([]);
  });

  it("includes terminals in reopen outgoing state", async () => {
    const { setTerminalStoreGetter } = await import("../projectStore");
    const panel = { id: "b-1", kind: "browser", location: "grid" };
    setTerminalStoreGetter(() => ({
      terminalsById: { "b-1": panel } as never,
      terminalIds: ["b-1"],
      tabGroups: new Map(),
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().reopenProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.reopen.mock.calls[0][1];
    expect(outgoing.terminals).toEqual([{ id: "b-1", kind: "browser" }]);
  });
});

describe("buildOutgoingState worktree selection (#5000)", () => {
  it("includes non-root activeWorktreeId in switchProject outgoing state", async () => {
    mockActiveWorktreeId = "wt-feature";

    const { useProjectStore, setWorktreeSelectionStoreGetter } = await import("../projectStore");
    setWorktreeSelectionStoreGetter(() => ({ activeWorktreeId: mockActiveWorktreeId }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0][1];
    expect(outgoing.activeWorktreeId).toBe("wt-feature");
  });

  it("includes non-root activeWorktreeId in reopenProject outgoing state", async () => {
    mockActiveWorktreeId = "wt-feature";

    const { useProjectStore, setWorktreeSelectionStoreGetter } = await import("../projectStore");
    setWorktreeSelectionStoreGetter(() => ({ activeWorktreeId: mockActiveWorktreeId }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().reopenProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.reopen.mock.calls[0][1];
    expect(outgoing.activeWorktreeId).toBe("wt-feature");
  });

  it("converts null activeWorktreeId to undefined in outgoing state", async () => {
    mockActiveWorktreeId = null;

    const { useProjectStore, setWorktreeSelectionStoreGetter } = await import("../projectStore");
    setWorktreeSelectionStoreGetter(() => ({ activeWorktreeId: mockActiveWorktreeId }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0][1];
    expect(outgoing.activeWorktreeId).toBeUndefined();
    expect("activeWorktreeId" in outgoing).toBe(true);
  });

  it("includes activeWorktreeId even when terminal store getter is null (early return)", async () => {
    mockActiveWorktreeId = "wt-early";

    // Don't call setTerminalStoreGetter — forces the early return path
    const { useProjectStore, setWorktreeSelectionStoreGetter } = await import("../projectStore");
    setWorktreeSelectionStoreGetter(() => ({ activeWorktreeId: mockActiveWorktreeId }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0][1];
    expect(outgoing.activeWorktreeId).toBe("wt-early");
  });
});
