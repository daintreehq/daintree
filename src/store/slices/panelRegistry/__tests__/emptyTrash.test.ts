import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockProjectClient = {
  getTerminals: vi.fn().mockResolvedValue([]),
  setTerminals: vi.fn().mockResolvedValue(undefined),
  setTabGroups: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: mockProjectClient,
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("../../../panelStore");
const { terminalClient } = await import("@/clients");
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
const { panelPersistence } = await import("../../../persistence/panelPersistence");

function makePanel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Panel ${id}`,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid" as const,
    worktreeId: null as string | null,
    kind: "terminal" as const,
    flowStatus: null,
    ...overrides,
  };
}

function makeTrashedInfo(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    expiresAt: Date.now() + 20_000,
    originalLocation: "grid" as const,
    ...overrides,
  };
}

describe("emptyTrash", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const { reset } = usePanelStore.getState();
    await reset();
    usePanelStore.setState({
      panelsById: {} as Record<string, unknown>,
      panelIds: [],
      panelIdsByWorktreeId: {},
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("removes multiple trashed panels in a single operation", () => {
    usePanelStore.setState({
      panelsById: {
        "p-1": makePanel("p-1"),
        "p-2": makePanel("p-2"),
      },
      panelIds: ["p-1", "p-2"],
      trashedTerminals: new Map([
        ["p-1", makeTrashedInfo("p-1")],
        ["p-2", makeTrashedInfo("p-2")],
      ]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["p-1", "p-2"]);

    const state = usePanelStore.getState();
    expect(state.panelsById["p-1"]).toBeUndefined();
    expect(state.panelsById["p-2"]).toBeUndefined();
    expect(state.panelIds).toEqual([]);
    expect(state.trashedTerminals.size).toBe(0);
  });

  it("leaves non-requested panels untouched", () => {
    usePanelStore.setState({
      panelsById: {
        "p-1": makePanel("p-1"),
        "p-2": makePanel("p-2"),
        "p-3": makePanel("p-3"),
      },
      panelIds: ["p-1", "p-2", "p-3"],
      trashedTerminals: new Map([
        ["p-1", makeTrashedInfo("p-1")],
        ["p-3", makeTrashedInfo("p-3")],
      ]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["p-1"]);

    const state = usePanelStore.getState();
    expect(state.panelsById["p-1"]).toBeUndefined();
    expect(state.panelsById["p-2"]).toBeDefined();
    expect(state.panelsById["p-3"]).toBeDefined();
    expect(state.panelIds).toEqual(["p-2", "p-3"]);
    expect(state.trashedTerminals.has("p-1")).toBe(false);
    expect(state.trashedTerminals.has("p-3")).toBe(true);
  });

  it("removes panels from backgroundedTerminals too", () => {
    usePanelStore.setState({
      panelsById: {
        "p-1": makePanel("p-1"),
      },
      panelIds: ["p-1"],
      trashedTerminals: new Map([["p-1", makeTrashedInfo("p-1")]]),
      backgroundedTerminals: new Map([["p-1", { id: "p-1", originalLocation: "grid" as const }]]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["p-1"]);

    const state = usePanelStore.getState();
    expect(state.backgroundedTerminals.has("p-1")).toBe(false);
  });

  it("handles empty ids array as no-op", () => {
    usePanelStore.setState({
      panelsById: { "p-1": makePanel("p-1") },
      panelIds: ["p-1"],
      trashedTerminals: new Map([["p-1", makeTrashedInfo("p-1")]]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash([]);

    const state = usePanelStore.getState();
    expect(state.panelsById["p-1"]).toBeDefined();
    expect(state.panelIds).toEqual(["p-1"]);
  });

  it("handles unknown IDs as no-op", () => {
    usePanelStore.setState({
      panelsById: { "p-1": makePanel("p-1") },
      panelIds: ["p-1"],
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["unknown"]);

    const state = usePanelStore.getState();
    expect(state.panelsById["p-1"]).toBeDefined();
    expect(state.panelIds).toEqual(["p-1"]);
  });

  it("deduplicates duplicate IDs", () => {
    usePanelStore.setState({
      panelsById: { "p-1": makePanel("p-1") },
      panelIds: ["p-1"],
      trashedTerminals: new Map([["p-1", makeTrashedInfo("p-1")]]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["p-1", "p-1", "p-1"]);

    const state = usePanelStore.getState();
    expect(state.panelsById["p-1"]).toBeUndefined();
    expect(state.trashedTerminals.has("p-1")).toBe(false);
  });

  it("kills PTY for each panel and destroys renderer", () => {
    usePanelStore.setState({
      panelsById: {
        "p-1": makePanel("p-1", { kind: "terminal" }),
        "p-2": makePanel("p-2", { kind: "terminal" }),
      },
      panelIds: ["p-1", "p-2"],
      trashedTerminals: new Map([
        ["p-1", makeTrashedInfo("p-1")],
        ["p-2", makeTrashedInfo("p-2")],
      ]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["p-1", "p-2"]);

    expect(terminalClient.kill).toHaveBeenCalledWith("p-1");
    expect(terminalClient.kill).toHaveBeenCalledWith("p-2");
    expect(terminalInstanceService.destroy).toHaveBeenCalledWith("p-1");
    expect(terminalInstanceService.destroy).toHaveBeenCalledWith("p-2");
  });

  it("skips PTY kill for non-PTY panels (browser, dev-preview)", () => {
    usePanelStore.setState({
      panelsById: {
        "p-1": makePanel("p-1", { kind: "browser" }),
      },
      panelIds: ["p-1"],
      trashedTerminals: new Map([["p-1", makeTrashedInfo("p-1")]]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    vi.clearAllMocks();
    usePanelStore.getState().emptyTrash(["p-1"]);

    expect(terminalClient.kill).not.toHaveBeenCalled();
    expect(terminalInstanceService.destroy).not.toHaveBeenCalled();
  });

  it("persists via saveNormalized exactly once", () => {
    usePanelStore.setState({
      panelsById: {
        "p-1": makePanel("p-1"),
        "p-2": makePanel("p-2"),
      },
      panelIds: ["p-1", "p-2"],
      trashedTerminals: new Map([
        ["p-1", makeTrashedInfo("p-1")],
        ["p-2", makeTrashedInfo("p-2")],
      ]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    (panelPersistence.save as unknown as ReturnType<typeof vi.fn>).mockClear();

    usePanelStore.getState().emptyTrash(["p-1", "p-2"]);

    // saveNormalized internally calls panelPersistence.save
    expect(panelPersistence.save).toHaveBeenCalledTimes(1);
  });

  it("prunes tab groups with removed panels", () => {
    const group = {
      id: "group-1",
      panelIds: ["p-1", "p-2", "p-3"],
      activeTabId: "p-1",
      location: "grid" as const,
    };

    usePanelStore.setState({
      panelsById: {
        "p-1": makePanel("p-1"),
        "p-2": makePanel("p-2"),
        "p-3": makePanel("p-3"),
      },
      panelIds: ["p-1", "p-2", "p-3"],
      tabGroups: new Map([["group-1", group]]),
      trashedTerminals: new Map([["p-1", makeTrashedInfo("p-1")]]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["p-1"]);

    const state = usePanelStore.getState();
    expect(state.tabGroups.has("group-1")).toBe(true);
    expect(state.tabGroups.get("group-1")?.panelIds).toEqual(["p-2", "p-3"]);
    expect(state.tabGroups.get("group-1")?.activeTabId).toBe("p-2");
  });

  it("deletes tab group when removal leaves 1 or 0 panels", () => {
    const group = {
      id: "group-1",
      panelIds: ["p-1", "p-2"],
      activeTabId: "p-1",
      location: "grid" as const,
    };

    usePanelStore.setState({
      panelsById: {
        "p-1": makePanel("p-1"),
        "p-2": makePanel("p-2"),
      },
      panelIds: ["p-1", "p-2"],
      tabGroups: new Map([["group-1", group]]),
      trashedTerminals: new Map([["p-1", makeTrashedInfo("p-1")]]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["p-1"]);

    const state = usePanelStore.getState();
    expect(state.tabGroups.has("group-1")).toBe(false);
  });

  it("updates panelIdsByWorktreeIndex for removed panels", () => {
    usePanelStore.setState({
      panelsById: {
        "p-1": makePanel("p-1", { worktreeId: "wt-a" }),
        "p-2": makePanel("p-2", { worktreeId: "wt-a" }),
      },
      panelIds: ["p-1", "p-2"],
      panelIdsByWorktreeId: { "wt-a": ["p-1", "p-2"] },
      trashedTerminals: new Map([
        ["p-1", makeTrashedInfo("p-1")],
        ["p-2", makeTrashedInfo("p-2")],
      ]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["p-1"]);

    const state = usePanelStore.getState();
    expect(state.panelIdsByWorktreeId["wt-a"]).toEqual(["p-2"]);
  });

  it("removes worktree bucket key entirely when last panel removed", () => {
    usePanelStore.setState({
      panelsById: {
        "p-1": makePanel("p-1", { worktreeId: "wt-a" }),
      },
      panelIds: ["p-1"],
      panelIdsByWorktreeId: { "wt-a": ["p-1"] },
      trashedTerminals: new Map([["p-1", makeTrashedInfo("p-1")]]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["p-1"]);

    const state = usePanelStore.getState();
    expect(state.panelIdsByWorktreeId["wt-a"]).toBeUndefined();
  });

  it("idempotent: calling again with same IDs is a no-op", () => {
    usePanelStore.setState({
      panelsById: { "p-1": makePanel("p-1") },
      panelIds: ["p-1"],
      trashedTerminals: new Map([["p-1", makeTrashedInfo("p-1")]]),
    } as unknown as Parameters<typeof usePanelStore.setState>[0]);

    usePanelStore.getState().emptyTrash(["p-1"]);
    const state1 = usePanelStore.getState();
    expect(state1.panelIds).toEqual([]);

    // Second call with same IDs should be harmless
    usePanelStore.getState().emptyTrash(["p-1"]);
    const state2 = usePanelStore.getState();
    expect(state2.panelIds).toEqual([]);
    expect(state2.panelsById).toEqual(state1.panelsById);
  });
});
