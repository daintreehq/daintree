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
  onWorktreeLoadStatus:
    vi.fn<
      (cb: (p: { projectId: string; worktreeLoadError: string | null }) => void) => () => void
    >(),
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
    cancel: vi.fn(),
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
      expect.objectContaining({ draftInputs: {} }),
      undefined
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
      expect.objectContaining({ draftInputs: { "terminal-1": "hello world" } }),
      undefined
    );
  });

  it("sends undefined outgoingState when no current project", async () => {
    const { useProjectStore } = await import("../projectStore");

    // No currentProject set
    useProjectStore.setState({ projects: [projectB], currentProject: null });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    expect(projectClientMock.switch).toHaveBeenCalledWith(projectB.id, undefined, undefined);
  });
});

describe("buildOutgoingState terminal/tabGroup snapshot (#5001)", () => {
  it("includes browser panel snapshots in outgoing terminals", async () => {
    const { setPanelStoreAccessor } = await import("../storeAccessors");
    const browserPanel = {
      id: "browser-1",
      kind: "browser",
      title: "Browser",
      location: "grid",
      browserUrl: "https://example.com",
    };
    setPanelStoreAccessor(() => ({
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
    const { setPanelStoreAccessor } = await import("../storeAccessors");
    const devPreview = {
      id: "dev-1",
      kind: "dev-preview",
      title: "Dev Preview",
      location: "grid",
    };
    setPanelStoreAccessor(() => ({
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
    const { setPanelStoreAccessor } = await import("../storeAccessors");
    const panels = {
      "t-trash": { id: "t-trash", kind: "terminal", location: "trash" },
      "t-bg": { id: "t-bg", kind: "terminal", location: "background" },
      "t-assistant": { id: "t-assistant", kind: "assistant", location: "grid" },
      "smoke-test-1": { id: "smoke-test-1", kind: "terminal", location: "grid" },
      "t-keep": { id: "t-keep", kind: "browser", location: "grid" },
    } as never;
    setPanelStoreAccessor(() => ({
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
    const { setPanelStoreAccessor } = await import("../storeAccessors");
    const tabGroups = new Map([
      ["g1", { id: "g1", location: "grid" as const, activeTabId: "a", panelIds: ["a", "b"] }],
      ["g2", { id: "g2", location: "grid" as const, activeTabId: "c", panelIds: ["c"] }],
    ]);
    setPanelStoreAccessor(() => ({
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
    const { setPanelStoreAccessor } = await import("../storeAccessors");
    const { panelPersistence, panelToSnapshot } = await import("../persistence/panelPersistence");

    const extPanel = {
      id: "ext-1",
      kind: "custom-widget",
      title: "Custom",
      location: "grid",
    };
    setPanelStoreAccessor(() => ({
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
    const { setPanelStoreAccessor } = await import("../storeAccessors");
    setPanelStoreAccessor(() => ({
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
    const { setPanelStoreAccessor } = await import("../storeAccessors");
    const panel = { id: "b-1", kind: "browser", location: "grid" };
    setPanelStoreAccessor(() => ({
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

describe("buildOutgoingState worktree selection (#5000, #9512)", () => {
  it("persists the durable restore selection in switchProject outgoing state", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { setWorktreeSelectionAccessor } = await import("../storeAccessors");
    setWorktreeSelectionAccessor(() => ({
      activeWorktreeId: "wt-feature",
      restoreWorktreeId: "wt-feature",
    }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBe("wt-feature");
  });

  it("persists the durable restore selection in reopenProject outgoing state", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { setWorktreeSelectionAccessor } = await import("../storeAccessors");
    setWorktreeSelectionAccessor(() => ({
      activeWorktreeId: "wt-feature",
      restoreWorktreeId: "wt-feature",
    }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().reopenProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.reopen.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBe("wt-feature");
  });

  it("persists the durable selection, not an incidentally-active worktree (#9512)", async () => {
    // A batch merge left a temporary PR worktree focused/active, but the user's
    // last deliberate selection was the root worktree. The outgoing state must
    // carry the durable selection so switching back lands on root.
    const { useProjectStore } = await import("../projectStore");
    const { setWorktreeSelectionAccessor, setWorktreeIdSetAccessor } =
      await import("../storeAccessors");
    setWorktreeSelectionAccessor(() => ({
      activeWorktreeId: "wt-temp-pr",
      restoreWorktreeId: "wt-root",
    }));
    setWorktreeIdSetAccessor(() => new Set(["wt-root", "wt-temp-pr"]));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBe("wt-root");
  });

  it("drops a restore target that no longer exists so hydration falls back (#9512)", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { setWorktreeSelectionAccessor, setWorktreeIdSetAccessor } =
      await import("../storeAccessors");
    setWorktreeSelectionAccessor(() => ({
      activeWorktreeId: null,
      restoreWorktreeId: "wt-removed",
    }));
    setWorktreeIdSetAccessor(() => new Set(["wt-root"]));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBeUndefined();
    expect("activeWorktreeId" in outgoing).toBe(true);
  });

  it("preserves the restore target when no view store is mounted (skip validation)", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { setWorktreeSelectionAccessor } = await import("../storeAccessors");
    // No setWorktreeIdSetAccessor → getWorktreeIdSet() returns null → no validation.
    setWorktreeSelectionAccessor(() => ({
      activeWorktreeId: "wt-feature",
      restoreWorktreeId: "wt-feature",
    }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBe("wt-feature");
  });

  it("converts null restore selection to undefined in outgoing state", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { setWorktreeSelectionAccessor } = await import("../storeAccessors");
    setWorktreeSelectionAccessor(() => ({ activeWorktreeId: null, restoreWorktreeId: null }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBeUndefined();
    expect("activeWorktreeId" in outgoing).toBe(true);
  });

  it("includes the restore selection even when terminal store getter is null (early return)", async () => {
    // Don't call setPanelStoreAccessor — forces the early return path
    const { useProjectStore } = await import("../projectStore");
    const { setWorktreeSelectionAccessor } = await import("../storeAccessors");
    setWorktreeSelectionAccessor(() => ({
      activeWorktreeId: "wt-early",
      restoreWorktreeId: "wt-early",
    }));
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();

    const outgoing = projectClientMock.switch.mock.calls[0]![1];
    expect(outgoing.activeWorktreeId).toBe("wt-early");
  });
});

describe("fleet arming clear on project switch (#5298)", () => {
  it("invokes the registered fleet-arming clear callback before the IPC call", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { setFleetArmingClearAccessor: setFleetArmingClear } = await import("../storeAccessors");
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
    const { useProjectStore } = await import("../projectStore");
    const { setFleetArmingClearAccessor: setFleetArmingClear } = await import("../storeAccessors");
    setFleetArmingClear(() => {});

    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await expect(useProjectStore.getState().switchProject(projectB.id)).resolves.not.toThrow();
  });

  it("does not invoke clear when switching to the current project (early return)", async () => {
    const { useProjectStore } = await import("../projectStore");
    const { setFleetArmingClearAccessor: setFleetArmingClear } = await import("../storeAccessors");
    const clearSpy = vi.fn();
    setFleetArmingClear(clearSpy);

    useProjectStore.setState({ projects: [projectA], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectA.id);

    expect(clearSpy).not.toHaveBeenCalled();
  });
});

describe("worktreeLoadError surfacing (#8400)", () => {
  it("clears a stale worktreeLoadError atomically when a switch starts", async () => {
    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({
      projects: [projectA, projectB],
      currentProject: projectA,
      worktreeLoadError: "Not a git repository",
    });

    await useProjectStore.getState().switchProject(projectB.id);

    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
    expect(useProjectStore.getState().error).toBeNull();
    expect(useProjectStore.getState().isLoading).toBe(true);
  });

  it("setWorktreeLoadError sets and clears the slice", async () => {
    const { useProjectStore } = await import("../projectStore");

    useProjectStore.getState().setWorktreeLoadError("boom");
    expect(useProjectStore.getState().worktreeLoadError).toBe("boom");

    useProjectStore.getState().setWorktreeLoadError(null);
    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
  });

  it("applies the worktree-load-status event, guarding on projectId", async () => {
    delete (globalThis as { __daintreeProjectStoreListenerState?: unknown })
      .__daintreeProjectStoreListenerState;
    // The module-init listener block only registers when window.electron.project
    // is present; provide a minimal stub so the listener is wired.
    (window as unknown as { electron: unknown }).electron = {
      project: { onUpdated: vi.fn(), onRemoved: vi.fn() },
    };
    const { useProjectStore } = await import("../projectStore");

    const statusCb = projectClientMock.onWorktreeLoadStatus.mock.calls[0]?.[0];
    expect(typeof statusCb).toBe("function");

    // Permissive: accepted while currentProject is still null (cold view).
    useProjectStore.setState({ currentProject: null, worktreeLoadError: null });
    statusCb!({ projectId: projectB.id, worktreeLoadError: "Not a git repository" });
    expect(useProjectStore.getState().worktreeLoadError).toBe("Not a git repository");

    // Applied when the payload's project matches this view's current project.
    useProjectStore.setState({ currentProject: projectB });
    statusCb!({ projectId: projectB.id, worktreeLoadError: null });
    expect(useProjectStore.getState().worktreeLoadError).toBeNull();

    // Ignored when the payload targets a different project (cross-view broadcast
    // contamination guard).
    useProjectStore.setState({ currentProject: projectB, worktreeLoadError: null });
    statusCb!({ projectId: projectA.id, worktreeLoadError: "Other project failed" });
    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
  });
});

describe("switch busy indication (#10736)", () => {
  it("flags isSwitching and the target project id when a switch starts", async () => {
    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    expect(useProjectStore.getState().isSwitching).toBe(false);
    expect(useProjectStore.getState().switchingToProjectId).toBeNull();

    await useProjectStore.getState().switchProject(projectB.id);

    expect(useProjectStore.getState().isSwitching).toBe(true);
    expect(useProjectStore.getState().switchingToProjectId).toBe(projectB.id);
  });

  it("keeps isSwitching set after the fire-and-forget IPC resolves (view is replaced)", async () => {
    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    await Promise.resolve();
    await Promise.resolve();

    // The happy path never re-enters this renderer, so the flag is not cleared.
    expect(useProjectStore.getState().isSwitching).toBe(true);
  });

  it("clears isSwitching when the switch IPC rejects (outgoing view stays visible)", async () => {
    projectClientMock.switch.mockRejectedValueOnce(new Error("boom"));
    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectB.id);
    // Let the rejected promise's .catch() run.
    await Promise.resolve();
    await Promise.resolve();

    expect(useProjectStore.getState().isSwitching).toBe(false);
    expect(useProjectStore.getState().switchingToProjectId).toBeNull();
    expect(useProjectStore.getState().isLoading).toBe(false);
  });

  it("does not flag isSwitching when switching to the current project (early return)", async () => {
    const { useProjectStore } = await import("../projectStore");
    useProjectStore.setState({ projects: [projectA], currentProject: projectA });

    await useProjectStore.getState().switchProject(projectA.id);

    expect(useProjectStore.getState().isSwitching).toBe(false);
    expect(useProjectStore.getState().switchingToProjectId).toBeNull();
  });
});
