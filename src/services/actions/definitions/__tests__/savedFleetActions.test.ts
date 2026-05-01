// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FleetSavedScope, TerminalInstance } from "@shared/types";

const getSettingsMock = vi.hoisted(() => vi.fn());
const saveSettingsMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn().mockResolvedValue("test-id"),
    write: vi.fn(),
    resize: vi.fn(),
    trash: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    sendKey: vi.fn(),
    batchDoubleEscape: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue(null),
  },
  projectClient: {
    getSettings: getSettingsMock,
    saveSettings: saveSettingsMock,
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    destroy: vi.fn(),
    applyRendererPolicy: vi.fn(),
    resize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
  },
}));

vi.mock("@/store/persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
const { usePanelStore } = await import("@/store/panelStore");
const { useProjectStore } = await import("@/store/projectStore");
const { useProjectSettingsStore } = await import("@/store/projectSettingsStore");
const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
const { registerFleetActions } = await import("../fleetActions");

type ActionRegistry = Awaited<
  ReturnType<typeof import("@/services/actions/actionDefinitions").createActionDefinitions>
>;

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    kind: "terminal",
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "waiting",
    hasPty: true,
    ...overrides,
  } as TerminalInstance;
}

function seedPanels(terminals: TerminalInstance[]): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
  });
}

function setCurrentProject(id: string | null): void {
  useProjectStore.setState({
    currentProject: id ? ({ id, name: id } as never) : null,
  });
}

function resetState(): void {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({
    panelsById: {},
    panelIds: [],
    focusedId: null,
    maximizedId: null,
    commandQueue: [],
  });
  useProjectSettingsStore.setState({
    settings: null,
    projectId: null,
    detectedRunners: [],
    allDetectedRunners: [],
    isLoading: false,
    error: null,
  });
  useWorktreeSelectionStore.setState({ activeWorktreeId: null });
  setCurrentProject("proj-1");
}

async function buildRegistry(): Promise<ActionRegistry> {
  const registry: ActionRegistry = new Map();
  registerFleetActions(registry);
  return registry;
}

async function run(registry: ActionRegistry, id: string, args?: unknown): Promise<void> {
  const factory = registry.get(id);
  if (!factory) throw new Error(`action ${id} not registered`);
  const def = factory();
  await def.run(args as never, {} as never);
}

describe("fleet.saveNamedFleet", () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it("saves the current armed set as a snapshot scope", async () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    useFleetArmingStore.getState().armIds(["a", "b"]);
    getSettingsMock.mockResolvedValue({ runCommands: [] });
    saveSettingsMock.mockResolvedValue(undefined);

    const registry = await buildRegistry();
    await run(registry, "fleet.saveNamedFleet", { kind: "snapshot", name: "My Fleet" });

    expect(saveSettingsMock).toHaveBeenCalledTimes(1);
    const [projectId, settings] = saveSettingsMock.mock.calls[0]!;
    expect(projectId).toBe("proj-1");
    expect(settings.fleetSavedScopes).toHaveLength(1);
    const saved = settings.fleetSavedScopes[0] as FleetSavedScope;
    expect(saved.kind).toBe("snapshot");
    expect(saved.name).toBe("My Fleet");
    expect(saved.kind === "snapshot" ? saved.terminalIds : []).toEqual(["a", "b"]);
  });

  it("trims whitespace from the name and refuses an empty name", async () => {
    useFleetArmingStore.getState().armIds(["a"]);
    seedPanels([makeAgent("a")]);
    getSettingsMock.mockResolvedValue({ runCommands: [] });

    const registry = await buildRegistry();
    await run(registry, "fleet.saveNamedFleet", { kind: "snapshot", name: "   " });

    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it("saves a predicate scope without reading the current armed set", async () => {
    // Predicate save must work even when nothing is armed — the rule is
    // independent of the current selection.
    seedPanels([]);
    getSettingsMock.mockResolvedValue({ runCommands: [] });
    saveSettingsMock.mockResolvedValue(undefined);

    const registry = await buildRegistry();
    await run(registry, "fleet.saveNamedFleet", {
      kind: "predicate",
      name: "All waiting",
      scope: "all",
      stateFilter: "waiting",
    });

    expect(saveSettingsMock).toHaveBeenCalledTimes(1);
    const saved = saveSettingsMock.mock.calls[0]![1].fleetSavedScopes[0] as FleetSavedScope;
    expect(saved.kind).toBe("predicate");
    if (saved.kind === "predicate") {
      expect(saved.scope).toBe("all");
      expect(saved.stateFilter).toBe("waiting");
    }
  });

  it("appends to existing scopes without clobbering them", async () => {
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.getState().armIds(["a"]);
    const existing: FleetSavedScope = {
      kind: "predicate",
      id: "old",
      name: "Old",
      scope: "all",
      stateFilter: "working",
      createdAt: 1,
    };
    getSettingsMock.mockResolvedValue({ runCommands: [], fleetSavedScopes: [existing] });
    saveSettingsMock.mockResolvedValue(undefined);

    const registry = await buildRegistry();
    await run(registry, "fleet.saveNamedFleet", { kind: "snapshot", name: "New" });

    const saved = saveSettingsMock.mock.calls[0]![1].fleetSavedScopes;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ id: "old" });
    expect(saved[1].name).toBe("New");
  });

  it("aborts when the project switches mid-IPC (does not write)", async () => {
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.getState().armIds(["a"]);
    getSettingsMock.mockImplementation(async () => {
      // Simulate the project switching before getSettings resolves.
      setCurrentProject("proj-2");
      return { runCommands: [] };
    });

    const registry = await buildRegistry();
    await run(registry, "fleet.saveNamedFleet", { kind: "snapshot", name: "My Fleet" });

    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it("no-ops when no project is active", async () => {
    setCurrentProject(null);
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.getState().armIds(["a"]);

    const registry = await buildRegistry();
    await run(registry, "fleet.saveNamedFleet", { kind: "snapshot", name: "My Fleet" });

    expect(getSettingsMock).not.toHaveBeenCalled();
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it("writes the new scope through to useProjectSettingsStore so the UI updates", async () => {
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.getState().armIds(["a"]);
    useProjectSettingsStore.setState({
      projectId: "proj-1",
      settings: { runCommands: [] },
    });
    getSettingsMock.mockResolvedValue({ runCommands: [] });
    saveSettingsMock.mockResolvedValue(undefined);

    const registry = await buildRegistry();
    await run(registry, "fleet.saveNamedFleet", { kind: "snapshot", name: "My Fleet" });

    const stored = useProjectSettingsStore.getState().settings?.fleetSavedScopes;
    expect(stored).toHaveLength(1);
    expect(stored?.[0]).toMatchObject({ kind: "snapshot", name: "My Fleet" });
  });

  it("captures the snapshot armOrder before the IPC round-trip", async () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    useFleetArmingStore.getState().armIds(["a", "b"]);
    getSettingsMock.mockImplementation(async () => {
      // The user disarms all panes during the IPC round-trip. The persisted
      // snapshot must still reflect what they clicked Save on.
      useFleetArmingStore.getState().clear();
      return { runCommands: [] };
    });
    saveSettingsMock.mockResolvedValue(undefined);

    const registry = await buildRegistry();
    await run(registry, "fleet.saveNamedFleet", { kind: "snapshot", name: "My Fleet" });

    const saved = saveSettingsMock.mock.calls[0]![1].fleetSavedScopes[0] as FleetSavedScope;
    if (saved.kind === "snapshot") {
      expect(saved.terminalIds).toEqual(["a", "b"]);
    } else {
      throw new Error("expected snapshot kind");
    }
  });

  it("surfaces an error notification when saveSettings rejects", async () => {
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.getState().armIds(["a"]);
    getSettingsMock.mockResolvedValue({ runCommands: [] });
    saveSettingsMock.mockRejectedValue(new Error("disk full"));

    const registry = await buildRegistry();
    await run(registry, "fleet.saveNamedFleet", { kind: "snapshot", name: "My Fleet" });

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't save fleet" })
    );
  });
});

describe("fleet.recallNamedFleet", () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it("arms the saved snapshot terminal IDs that are still eligible", async () => {
    seedPanels([makeAgent("a"), makeAgent("c")]);
    const scope: FleetSavedScope = {
      kind: "snapshot",
      id: "s1",
      name: "Snap",
      // "b" is no longer in panelsById — should be silently dropped on recall.
      terminalIds: ["a", "b", "c"],
      createdAt: 1,
    };
    getSettingsMock.mockResolvedValue({ runCommands: [], fleetSavedScopes: [scope] });

    const registry = await buildRegistry();
    await run(registry, "fleet.recallNamedFleet", { id: "s1" });

    expect(useFleetArmingStore.getState().armOrder).toEqual(["a", "c"]);
  });

  it("preserves saved order on snapshot recall", async () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    const scope: FleetSavedScope = {
      kind: "snapshot",
      id: "s1",
      name: "Snap",
      terminalIds: ["c", "a", "b"],
      createdAt: 1,
    };
    getSettingsMock.mockResolvedValue({ runCommands: [], fleetSavedScopes: [scope] });

    const registry = await buildRegistry();
    await run(registry, "fleet.recallNamedFleet", { id: "s1" });

    expect(useFleetArmingStore.getState().armOrder).toEqual(["c", "a", "b"]);
  });

  it("recalls a predicate scope by re-evaluating against the current panels", async () => {
    seedPanels([
      makeAgent("a", { agentState: "waiting" }),
      makeAgent("b", { agentState: "working" }),
      makeAgent("c", { agentState: "waiting" }),
    ]);
    const scope: FleetSavedScope = {
      kind: "predicate",
      id: "p1",
      name: "Waiting",
      scope: "all",
      stateFilter: "waiting",
      createdAt: 1,
    };
    getSettingsMock.mockResolvedValue({ runCommands: [], fleetSavedScopes: [scope] });

    const registry = await buildRegistry();
    await run(registry, "fleet.recallNamedFleet", { id: "p1" });

    const armed = useFleetArmingStore.getState().armedIds;
    expect(armed.size).toBe(2);
    expect(armed.has("a")).toBe(true);
    expect(armed.has("c")).toBe(true);
  });

  it("predicate recall ends with zero armed when nothing matches (does not auto-delete)", async () => {
    // No agents in the "waiting" state — a predicate fleet that resolves to
    // zero panes must NOT be auto-deleted (Apple Music live-rule precedent).
    seedPanels([makeAgent("a", { agentState: "working" })]);
    const scope: FleetSavedScope = {
      kind: "predicate",
      id: "p1",
      name: "Waiting",
      scope: "all",
      stateFilter: "waiting",
      createdAt: 1,
    };
    getSettingsMock.mockResolvedValue({ runCommands: [], fleetSavedScopes: [scope] });

    const registry = await buildRegistry();
    await run(registry, "fleet.recallNamedFleet", { id: "p1" });

    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    // Saved scopes were never modified by recall — only save/delete may write.
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it("predicate stateFilter='all' calls armAll(scope)", async () => {
    seedPanels([makeAgent("a", { worktreeId: "wt-1" }), makeAgent("b", { worktreeId: "wt-2" })]);
    const scope: FleetSavedScope = {
      kind: "predicate",
      id: "p1",
      name: "Everyone",
      scope: "all",
      stateFilter: "all",
      createdAt: 1,
    };
    getSettingsMock.mockResolvedValue({ runCommands: [], fleetSavedScopes: [scope] });

    const registry = await buildRegistry();
    await run(registry, "fleet.recallNamedFleet", { id: "p1" });

    const armed = useFleetArmingStore.getState().armedIds;
    expect(armed.has("a")).toBe(true);
    expect(armed.has("b")).toBe(true);
  });

  it("is a no-op when the saved id is not found", async () => {
    seedPanels([makeAgent("a")]);
    getSettingsMock.mockResolvedValue({ runCommands: [], fleetSavedScopes: [] });

    const registry = await buildRegistry();
    await run(registry, "fleet.recallNamedFleet", { id: "missing" });

    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
  });

  it("missing-id recall preserves the existing armed set (does not clear)", async () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    useFleetArmingStore.getState().armIds(["a"]);
    getSettingsMock.mockResolvedValue({ runCommands: [], fleetSavedScopes: [] });

    const registry = await buildRegistry();
    await run(registry, "fleet.recallNamedFleet", { id: "missing" });

    expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a"]);
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it("predicate scope='current' restricts to the active worktree", async () => {
    seedPanels([
      makeAgent("a", { worktreeId: "wt-1" }),
      makeAgent("b", { worktreeId: "wt-2" }),
      makeAgent("c", { worktreeId: "wt-1" }),
    ]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    const scope: FleetSavedScope = {
      kind: "predicate",
      id: "p1",
      name: "Current",
      scope: "current",
      stateFilter: "all",
      createdAt: 1,
    };
    getSettingsMock.mockResolvedValue({ runCommands: [], fleetSavedScopes: [scope] });

    const registry = await buildRegistry();
    await run(registry, "fleet.recallNamedFleet", { id: "p1" });

    const armed = useFleetArmingStore.getState().armedIds;
    expect(armed.size).toBe(2);
    expect(armed.has("a")).toBe(true);
    expect(armed.has("c")).toBe(true);
    expect(armed.has("b")).toBe(false);
  });
});

describe("fleet.deleteNamedFleet", () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it("removes the matching scope and persists the new array", async () => {
    const scopes: FleetSavedScope[] = [
      {
        kind: "snapshot",
        id: "s1",
        name: "A",
        terminalIds: [],
        createdAt: 1,
      },
      {
        kind: "snapshot",
        id: "s2",
        name: "B",
        terminalIds: [],
        createdAt: 2,
      },
    ];
    getSettingsMock.mockResolvedValue({ runCommands: [], fleetSavedScopes: scopes });
    saveSettingsMock.mockResolvedValue(undefined);

    const registry = await buildRegistry();
    await run(registry, "fleet.deleteNamedFleet", { id: "s1" });

    expect(saveSettingsMock).toHaveBeenCalledTimes(1);
    const saved = saveSettingsMock.mock.calls[0]![1].fleetSavedScopes;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "s2" });
  });

  it("is idempotent — unknown id does not call saveSettings", async () => {
    getSettingsMock.mockResolvedValue({
      runCommands: [],
      fleetSavedScopes: [
        {
          kind: "snapshot",
          id: "s1",
          name: "A",
          terminalIds: [],
          createdAt: 1,
        } satisfies FleetSavedScope,
      ],
    });

    const registry = await buildRegistry();
    await run(registry, "fleet.deleteNamedFleet", { id: "missing" });

    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it("writes the trimmed scopes through to useProjectSettingsStore", async () => {
    useProjectSettingsStore.setState({
      projectId: "proj-1",
      settings: { runCommands: [] },
    });
    getSettingsMock.mockResolvedValue({
      runCommands: [],
      fleetSavedScopes: [
        {
          kind: "snapshot",
          id: "s1",
          name: "A",
          terminalIds: [],
          createdAt: 1,
        } satisfies FleetSavedScope,
      ],
    });
    saveSettingsMock.mockResolvedValue(undefined);

    const registry = await buildRegistry();
    await run(registry, "fleet.deleteNamedFleet", { id: "s1" });

    expect(useProjectSettingsStore.getState().settings?.fleetSavedScopes).toEqual([]);
  });

  it("aborts the write when the project switches mid-IPC", async () => {
    getSettingsMock.mockImplementation(async () => {
      setCurrentProject("proj-2");
      return {
        runCommands: [],
        fleetSavedScopes: [
          {
            kind: "snapshot",
            id: "s1",
            name: "A",
            terminalIds: [],
            createdAt: 1,
          } satisfies FleetSavedScope,
        ],
      };
    });

    const registry = await buildRegistry();
    await run(registry, "fleet.deleteNamedFleet", { id: "s1" });

    expect(saveSettingsMock).not.toHaveBeenCalled();
  });
});
