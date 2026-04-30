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

vi.mock("../panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      terminals: [],
      panelsById: {},
      panelIds: [],
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
  flushPanelPersistence: vi.fn(),
}));

vi.mock("../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    getPreviousSnapshotMap: vi.fn(() => undefined),
  },
  panelToSnapshot: vi.fn((t: { id: string; kind: string }) => ({
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
    const { setPanelStoreGetter } = await import("../projectStore");
    const browserPanel = {
      id: "browser-1",
      kind: "browser",
      title: "Browser",
      location: "grid",
      browserUrl: "https://example.com",
    };
    setPanelStoreGetter(() => ({
      panelsById: { "browser-1": browserPanel } as never,
      panelIds: ["browser-1"],
      tabGroups: new Map(),
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.terminals).toEqual([{ id: "browser-1", kind: "browser" }]);
  });

  it("includes dev-preview panel snapshots in outgoing terminals", async () => {
    const { setPanelStoreGetter } = await import("../projectStore");
    const devPreview = {
      id: "dev-1",
      kind: "dev-preview",
      title: "Dev Preview",
      location: "grid",
    };
    setPanelStoreGetter(() => ({
      panelsById: { "dev-1": devPreview } as never,
      panelIds: ["dev-1"],
      tabGroups: new Map(),
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.terminals).toEqual([{ id: "dev-1", kind: "dev-preview" }]);
  });

  it("excludes trash, background, assistant, and smoke-test panels", async () => {
    const { setPanelStoreGetter } = await import("../projectStore");
    const panels = {
      "t-trash": { id: "t-trash", kind: "terminal", location: "trash" },
      "t-bg": { id: "t-bg", kind: "terminal", location: "background" },
      "t-assistant": { id: "t-assistant", kind: "assistant", location: "grid" },
      "smoke-test-1": { id: "smoke-test-1", kind: "terminal", location: "grid" },
      "t-keep": { id: "t-keep", kind: "browser", location: "grid" },
    } as never;
    setPanelStoreGetter(() => ({
      panelsById: panels,
      panelIds: Object.keys(panels),
      tabGroups: new Map(),
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.terminals).toHaveLength(1);
    expect(outgoing.terminals[0].id).toBe("t-keep");
  });

  it("includes multi-panel tab groups, excludes single-panel groups", async () => {
    const { setPanelStoreGetter } = await import("../projectStore");
    const tabGroups = new Map([
      ["g1", { id: "g1", location: "grid" as const, activeTabId: "a", panelIds: ["a", "b"] }],
      ["g2", { id: "g2", location: "grid" as const, activeTabId: "c", panelIds: ["c"] }],
    ]);
    setPanelStoreGetter(() => ({
      panelsById: {} as never,
      panelIds: [],
      tabGroups,
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.tabGroups).toEqual([
      { id: "g1", location: "grid", activeTabId: "a", panelIds: ["a", "b"] },
    ]);
  });

  it("threads previousSnapshot into panelToSnapshot for unknown-kind preservation (#5201)", async () => {
    const { setPanelStoreGetter } = await import("../projectStore");
    const { panelPersistence, panelToSnapshot } = await import("../persistence/panelPersistence");

    const extPanel = {
      id: "ext-1",
      kind: "custom-widget",
      title: "Custom",
      location: "grid",
    };
    setPanelStoreGetter(() => ({
      panelsById: { "ext-1": extPanel } as never,
      panelIds: ["ext-1"],
      tabGroups: new Map(),
    }));

    const previousSnapshot = {
      id: "ext-1",
      kind: "custom-widget",
      title: "Custom",
      location: "grid",
      browserUrl: "https://example.com",
    };
    vi.mocked(panelPersistence.getPreviousSnapshotMap).mockReturnValueOnce(
      new Map([["ext-1", previousSnapshot as never]])
    );
    // Override panelToSnapshot for this test to exercise preservation end-to-end.
    vi.mocked(panelToSnapshot).mockImplementationOnce(((t: unknown, prev?: unknown) => ({
      ...(prev as Record<string, unknown> | undefined),
      id: (t as { id: string }).id,
      kind: (t as { kind: string }).kind,
    })) as typeof panelToSnapshot);

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    // Without the fix, outgoing terminals would be base-only. With it, the
    // preserved fragment (browserUrl) reaches the main-process pre-apply.
    expect(panelPersistence.getPreviousSnapshotMap).toHaveBeenCalledWith(projectA.id);
    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.terminals).toHaveLength(1);
    expect(outgoing.terminals[0]).toEqual(
      expect.objectContaining({
        id: "ext-1",
        kind: "custom-widget",
        browserUrl: "https://example.com",
      })
    );
  });

  it("sends empty tabGroups array to clear stale groups when none exist", async () => {
    const { setPanelStoreGetter } = await import("../projectStore");
    setPanelStoreGetter(() => ({
      panelsById: {} as never,
      panelIds: [],
      tabGroups: new Map(),
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.tabGroups).toEqual([]);
  });

  it("includes terminals in reopen outgoing state", async () => {
    const { setPanelStoreGetter } = await import("../projectStore");
    const panel = { id: "b-1", kind: "browser", location: "grid" };
    setPanelStoreGetter(() => ({
      panelsById: { "b-1": panel } as never,
      panelIds: ["b-1"],
      tabGroups: new Map(),
    }));

    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().reopenProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.reopen.mock.calls[0]![1];
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

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBe("wt-feature");
  });

  it("includes non-root activeWorktreeId in reopenProject outgoing state", async () => {
    mockActiveWorktreeId = "wt-feature";

    const { useProjectStore, setWorktreeSelectionStoreGetter } = await import("../projectStore");
    setWorktreeSelectionStoreGetter(() => ({ activeWorktreeId: mockActiveWorktreeId }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().reopenProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.reopen.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBe("wt-feature");
  });

  it("converts null activeWorktreeId to undefined in outgoing state", async () => {
    mockActiveWorktreeId = null;

    const { useProjectStore, setWorktreeSelectionStoreGetter } = await import("../projectStore");
    setWorktreeSelectionStoreGetter(() => ({ activeWorktreeId: mockActiveWorktreeId }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBeUndefined();
    expect("activeWorktreeId" in outgoing).toBe(true);
  });

  it("includes activeWorktreeId even when terminal store getter is null (early return)", async () => {
    mockActiveWorktreeId = "wt-early";

    // Don't call setPanelStoreGetter — forces the early return path
    const { useProjectStore, setWorktreeSelectionStoreGetter } = await import("../projectStore");
    setWorktreeSelectionStoreGetter(() => ({ activeWorktreeId: mockActiveWorktreeId }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBe("wt-early");
  });
});

describe("fleet arming clear on project switch (#5298)", () => {
  it("invokes the registered fleet-arming clear callback before the IPC call", async () => {
    const { useProjectStore, setFleetArmingClear } = await import("../projectStore");
    const clearSpy = vi.fn();
    setFleetArmingClear(clearSpy);

    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    // Sanity: not called before switch
    expect(clearSpy).not.toHaveBeenCalled();

    await useProjectStore.getState().switchProject(projectB.id);

    expect(clearSpy).toHaveBeenCalledTimes(1);
    // Called before the fire-and-forget IPC
    const clearOrder = clearSpy.mock.invocationCallOrder[0];
    const switchOrder = projectClientMock.switch.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(switchOrder!);
  });

  it("does not throw when the callback is a no-op", async () => {
    const { useProjectStore, setFleetArmingClear } = await import("../projectStore");
    setFleetArmingClear(() => {});

    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await expect(useProjectStore.getState().switchProject(projectB.id)).resolves.not.toThrow();
  });

  it("does not invoke clear when switching to the current project (early return)", async () => {
    const { useProjectStore, setFleetArmingClear } = await import("../projectStore");
    const clearSpy = vi.fn();
    setFleetArmingClear(clearSpy);

    useProjectStore.setState({ projects: [projectA], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectA.id);

    expect(clearSpy).not.toHaveBeenCalled();
  });
});
