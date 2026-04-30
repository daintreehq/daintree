// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TerminalInstance } from "@shared/types";

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

const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
const { useFleetPendingActionStore } = await import("@/store/fleetPendingActionStore");
const { usePanelStore } = await import("@/store/panelStore");
const { terminalClient } = await import("@/clients");
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

function resetStores(): void {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  useFleetPendingActionStore.setState({ pending: null });
  usePanelStore.setState({
    panelsById: {},
    panelIds: [],
    focusedId: null,
    maximizedId: null,
    commandQueue: [],
  });
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

describe("fleet actions — threshold confirmation", () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
  });

  it("fleet.interrupt dispatches immediately when fewer than 3 targets", async () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    useFleetArmingStore.getState().armIds(["a", "b"]);
    const registry = await buildRegistry();
    await run(registry, "fleet.interrupt");
    expect(terminalClient.batchDoubleEscape).toHaveBeenCalledWith(["a", "b"]);
    expect(useFleetPendingActionStore.getState().pending).toBeNull();
  });

  it("fleet.interrupt opens a confirmation when 3+ targets", async () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
    const registry = await buildRegistry();
    await run(registry, "fleet.interrupt");
    expect(terminalClient.batchDoubleEscape).not.toHaveBeenCalled();
    const pending = useFleetPendingActionStore.getState().pending;
    expect(pending?.kind).toBe("interrupt");
    expect(pending?.targetCount).toBe(3);
  });

  it("fleet.interrupt skips confirmation when re-dispatched with { confirmed: true }", async () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
    useFleetPendingActionStore.setState({
      pending: { kind: "interrupt", targetCount: 3, sessionLossCount: 0 },
    });
    const registry = await buildRegistry();
    await run(registry, "fleet.interrupt", { confirmed: true });
    expect(terminalClient.batchDoubleEscape).toHaveBeenCalledWith(["a", "b", "c"]);
    expect(useFleetPendingActionStore.getState().pending).toBeNull();
  });

  it("fleet.restart always confirms (even for a single target)", async () => {
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.getState().armIds(["a"]);
    const registry = await buildRegistry();
    await run(registry, "fleet.restart");
    const pending = useFleetPendingActionStore.getState().pending;
    expect(pending?.kind).toBe("restart");
  });

  it("fleet.restart ignores non-agent shells, but terminal-level trash still applies", async () => {
    const observedShell = makeAgent("observed", {
      detectedAgentId: undefined,
      everDetectedAgent: true,
      agentState: "working",
    });
    seedPanels([observedShell]);
    useFleetArmingStore.getState().armIds(["observed"]);
    const registry = await buildRegistry();

    await run(registry, "fleet.restart");
    expect(useFleetPendingActionStore.getState().pending).toBeNull();

    await run(registry, "fleet.trash");
    expect(usePanelStore.getState().panelsById["observed"]?.location).toBe("trash");
  });

  it("fleet.trash dispatches immediately below the 5-target threshold", async () => {
    const agents = Array.from({ length: 4 }, (_, i) => makeAgent(`a${i}`));
    seedPanels(agents);
    useFleetArmingStore.getState().armIds(agents.map((a) => a.id));
    const registry = await buildRegistry();
    await run(registry, "fleet.trash");
    expect(useFleetPendingActionStore.getState().pending).toBeNull();
    // All trashed
    expect(usePanelStore.getState().panelsById["a0"]?.location).toBe("trash");
    expect(usePanelStore.getState().panelsById["a3"]?.location).toBe("trash");
  });

  it("fleet.trash opens a confirmation at 5+ targets", async () => {
    const agents = Array.from({ length: 5 }, (_, i) => makeAgent(`a${i}`));
    seedPanels(agents);
    useFleetArmingStore.getState().armIds(agents.map((a) => a.id));
    const registry = await buildRegistry();
    await run(registry, "fleet.trash");
    const pending = useFleetPendingActionStore.getState().pending;
    expect(pending?.kind).toBe("trash");
    expect(pending?.targetCount).toBe(5);
    // Not yet trashed
    expect(usePanelStore.getState().panelsById["a0"]?.location).toBe("grid");
  });

  it("fleet.accept writes 'y\\r' only to armed agents in the waiting state", async () => {
    seedPanels([
      makeAgent("a", { agentState: "waiting" }),
      makeAgent("b", { agentState: "working" }),
      makeAgent("c", { agentState: "waiting" }),
    ]);
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
    const registry = await buildRegistry();
    await run(registry, "fleet.accept");
    const write = terminalClient.write as ReturnType<typeof vi.fn>;
    const calls = write.mock.calls;
    expect(calls.map((c) => c[0]).sort()).toEqual(["a", "c"]);
    for (const c of calls) expect(c[1]).toBe("y\r");
  });

  it("fleet.accept skips waiting observational shells even if stale-armed", async () => {
    seedPanels([
      makeAgent("full", { agentState: "waiting" }),
      makeAgent("observed", {
        detectedAgentId: undefined,
        everDetectedAgent: true,
        agentState: "waiting",
      }),
    ]);
    useFleetArmingStore.getState().armIds(["full", "observed"]);
    const registry = await buildRegistry();
    await run(registry, "fleet.accept");
    const write = terminalClient.write as ReturnType<typeof vi.fn>;
    expect(write.mock.calls.map((c) => c[0])).toEqual(["full"]);
  });

  it("fleet.accept drops terminals that are no longer eligible at dispatch time", async () => {
    seedPanels([
      makeAgent("a", { agentState: "waiting" }),
      makeAgent("b", { agentState: "waiting", hasPty: false }),
      makeAgent("c", { agentState: "waiting", location: "trash" }),
    ]);
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
    const registry = await buildRegistry();
    await run(registry, "fleet.accept");
    const write = terminalClient.write as ReturnType<typeof vi.fn>;
    expect(write.mock.calls.map((c) => c[0])).toEqual(["a"]);
  });

  it("fleet.reject writes 'n\\r' and respects the 5-target threshold", async () => {
    // Below threshold — dispatches directly
    const agents = Array.from({ length: 4 }, (_, i) =>
      makeAgent(`a${i}`, { agentState: "waiting" })
    );
    seedPanels(agents);
    useFleetArmingStore.getState().armIds(agents.map((a) => a.id));
    const registry = await buildRegistry();
    await run(registry, "fleet.reject");
    const write = terminalClient.write as ReturnType<typeof vi.fn>;
    expect(write.mock.calls.length).toBe(4);
    for (const c of write.mock.calls) expect(c[1]).toBe("n\r");
    expect(useFleetPendingActionStore.getState().pending).toBeNull();
  });

  it("fleet.reject opens a confirmation at 5+ waiting targets", async () => {
    const agents = Array.from({ length: 5 }, (_, i) =>
      makeAgent(`a${i}`, { agentState: "waiting" })
    );
    seedPanels(agents);
    useFleetArmingStore.getState().armIds(agents.map((a) => a.id));
    const registry = await buildRegistry();
    await run(registry, "fleet.reject");
    expect(terminalClient.write).not.toHaveBeenCalled();
    const pending = useFleetPendingActionStore.getState().pending;
    expect(pending?.kind).toBe("reject");
    expect(pending?.targetCount).toBe(5);
  });

  it("fleet.reject falls through to panel.palette when no waiting agents are armed", async () => {
    // Setup: armed agent exists but is 'working' — nothing to reject.
    seedPanels([makeAgent("a", { agentState: "working" })]);
    useFleetArmingStore.getState().armIds(["a"]);
    // Spy on actionService.dispatch via dynamic import mock
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    const registry = await buildRegistry();
    await run(registry, "fleet.reject");
    // Should have called panel.palette
    const calls = dispatchSpy.mock.calls.map((c) => c[0]);
    expect(calls).toContain("panel.palette");
    dispatchSpy.mockRestore();
  });

  it("fleet.interrupt only targets working/waiting agents", async () => {
    seedPanels([
      makeAgent("a", { agentState: "working" }),
      makeAgent("b", { agentState: "waiting" }),
      makeAgent("c", { agentState: "working" }),
      makeAgent("d", { agentState: "completed" }),
      makeAgent("e", { agentState: "idle" }),
    ]);
    useFleetArmingStore.getState().armIds(["a", "b", "c", "d", "e"]);
    const registry = await buildRegistry();
    // 3 interrupt candidates (a, b, c) hits the ≥3 threshold → confirmation
    await run(registry, "fleet.interrupt");
    expect(terminalClient.batchDoubleEscape).not.toHaveBeenCalled();
    const pending = useFleetPendingActionStore.getState().pending;
    expect(pending?.kind).toBe("interrupt");
    expect(pending?.targetCount).toBe(3);
    // Confirm and verify only the right subset is interrupted
    await run(registry, "fleet.interrupt", { confirmed: true });
    expect(terminalClient.batchDoubleEscape).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("fleet.interrupt skips working observational shells", async () => {
    seedPanels([
      makeAgent("full", { agentState: "working" }),
      makeAgent("observed", {
        detectedAgentId: undefined,
        everDetectedAgent: true,
        agentState: "working",
      }),
    ]);
    useFleetArmingStore.getState().armIds(["full", "observed"]);
    const registry = await buildRegistry();
    await run(registry, "fleet.interrupt");
    expect(terminalClient.batchDoubleEscape).toHaveBeenCalledWith(["full"]);
  });
});

describe("fleet.armMatchingFilter", () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
  });

  it("arms eligible terminals in the provided worktree ids", async () => {
    seedPanels([
      makeAgent("a1", { worktreeId: "wt-1" }),
      makeAgent("a2", { worktreeId: "wt-2" }),
      makeAgent("a3", { worktreeId: "wt-3" }),
      makeAgent("p1", { worktreeId: "wt-3", detectedAgentId: undefined, everDetectedAgent: false }),
    ]);
    const registry = await buildRegistry();
    await run(registry, "fleet.armMatchingFilter", { worktreeIds: ["wt-1", "wt-3"] });
    expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "a3", "p1"]);
  });

  it("is a no-op when worktreeIds is empty (does not clobber existing armed set)", async () => {
    seedPanels([makeAgent("a1"), makeAgent("a2")]);
    useFleetArmingStore.getState().armIds(["a1"]);
    const registry = await buildRegistry();
    await run(registry, "fleet.armMatchingFilter", { worktreeIds: [] });
    expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
  });

  it("preserves prior armed set when filtered worktrees contain no eligible terminals", async () => {
    // Matches the sidebar case where the filter matches worktrees that
    // happen to have no arm-eligible terminals — the button must
    // not silently clear the user's selection.
    seedPanels([makeAgent("a1", { worktreeId: "wt-1" })]);
    useFleetArmingStore.getState().armIds(["a1"]);
    const registry = await buildRegistry();
    await run(registry, "fleet.armMatchingFilter", { worktreeIds: ["wt-9"] });
    expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
  });

  it("replaces any prior armed set that falls outside the filter", async () => {
    seedPanels([makeAgent("a1", { worktreeId: "wt-1" }), makeAgent("a2", { worktreeId: "wt-2" })]);
    useFleetArmingStore.getState().armIds(["a2"]);
    const registry = await buildRegistry();
    await run(registry, "fleet.armMatchingFilter", { worktreeIds: ["wt-1"] });
    expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
  });
});

describe("fleet scope actions — flag gating", () => {
  beforeEach(async () => {
    resetStores();
    vi.clearAllMocks();
    const { useFleetScopeFlagStore } = await import("@/store/fleetScopeFlagStore");
    const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
    useFleetScopeFlagStore.setState({ mode: "legacy", isHydrated: false });
    useWorktreeSelectionStore.setState({
      activeWorktreeId: null,
      isFleetScopeActive: false,
      _previousActiveWorktreeId: null,
    });
  });

  it("fleet.scope.enter is a full no-op in legacy mode (no side effects)", async () => {
    const { useFleetScopeFlagStore } = await import("@/store/fleetScopeFlagStore");
    const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
    useFleetScopeFlagStore.setState({ mode: "legacy", isHydrated: true });
    useWorktreeSelectionStore.setState({
      activeWorktreeId: "wt-1",
      focusedWorktreeId: "wt-1",
      isFleetScopeActive: false,
      _previousActiveWorktreeId: null,
    });
    const registry = await buildRegistry();
    await run(registry, "fleet.scope.enter");
    const state = useWorktreeSelectionStore.getState();
    expect(state.isFleetScopeActive).toBe(false);
    expect(state.activeWorktreeId).toBe("wt-1");
    expect(state.focusedWorktreeId).toBe("wt-1");
    expect(state._previousActiveWorktreeId).toBeNull();
  });

  it("fleet.scope.enter activates scope and captures worktree in scoped mode", async () => {
    const { useFleetScopeFlagStore } = await import("@/store/fleetScopeFlagStore");
    const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
    useFleetScopeFlagStore.setState({ mode: "scoped", isHydrated: true });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    const registry = await buildRegistry();
    await run(registry, "fleet.scope.enter");
    const state = useWorktreeSelectionStore.getState();
    expect(state.isFleetScopeActive).toBe(true);
    expect(state._previousActiveWorktreeId).toBe("wt-1");
  });

  it("fleet.scope.exit is a no-op in legacy mode", async () => {
    const { useFleetScopeFlagStore } = await import("@/store/fleetScopeFlagStore");
    const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
    useFleetScopeFlagStore.setState({ mode: "legacy", isHydrated: true });
    useWorktreeSelectionStore.setState({
      activeWorktreeId: null,
      isFleetScopeActive: true,
      _previousActiveWorktreeId: "wt-stale",
    });
    const registry = await buildRegistry();
    await run(registry, "fleet.scope.exit");
    expect(useWorktreeSelectionStore.getState().isFleetScopeActive).toBe(true);
  });

  it("fleet.scope.exit restores prior worktree in scoped mode", async () => {
    const { useFleetScopeFlagStore } = await import("@/store/fleetScopeFlagStore");
    const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
    useFleetScopeFlagStore.setState({ mode: "scoped", isHydrated: true });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    const registry = await buildRegistry();
    await run(registry, "fleet.scope.enter");
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    await run(registry, "fleet.scope.exit");
    const state = useWorktreeSelectionStore.getState();
    expect(state.isFleetScopeActive).toBe(false);
    expect(state.activeWorktreeId).toBe("wt-1");
  });

  it("fleet.scope.enter is a no-op before hydration resolves", async () => {
    // With the "scoped" default, an unhydrated store could let a persisted-legacy
    // user briefly enter scope before hydrate() runs. The isHydrated guard
    // prevents the stuck isFleetScopeActive state that would follow when late
    // hydration flips mode back to "legacy".
    const { useFleetScopeFlagStore } = await import("@/store/fleetScopeFlagStore");
    const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
    useFleetScopeFlagStore.setState({ mode: "scoped", isHydrated: false });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    const registry = await buildRegistry();
    await run(registry, "fleet.scope.enter");
    expect(useWorktreeSelectionStore.getState().isFleetScopeActive).toBe(false);
  });

  it("flag is read at execution time, not at registration time", async () => {
    const { useFleetScopeFlagStore } = await import("@/store/fleetScopeFlagStore");
    const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
    useFleetScopeFlagStore.setState({ mode: "legacy", isHydrated: true });
    const registry = await buildRegistry();
    // Flip the flag AFTER registry build
    useFleetScopeFlagStore.setState({ mode: "scoped", isHydrated: true });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    await run(registry, "fleet.scope.enter");
    expect(useWorktreeSelectionStore.getState().isFleetScopeActive).toBe(true);
  });
});

describe("fleet.armFocused", () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
  });

  it("arms the focused eligible pane from an empty fleet", async () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    usePanelStore.setState({ focusedId: "a" });
    const registry = await buildRegistry();
    await run(registry, "fleet.armFocused");
    const armed = useFleetArmingStore.getState().armedIds;
    expect(armed.has("a")).toBe(true);
    expect(armed.size).toBe(1);
  });

  it("arms the focused plain terminal", async () => {
    seedPanels([
      makeAgent("plain", { detectedAgentId: undefined, everDetectedAgent: false }),
      makeAgent("agent"),
    ]);
    usePanelStore.setState({ focusedId: "plain" });
    const registry = await buildRegistry();
    await run(registry, "fleet.armFocused");
    const armed = useFleetArmingStore.getState().armedIds;
    expect(armed.has("plain")).toBe(true);
    expect(armed.size).toBe(1);
  });

  it("disarms the focused pane when it is already armed", async () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    useFleetArmingStore.getState().armIds(["a", "b"]);
    usePanelStore.setState({ focusedId: "a" });
    const registry = await buildRegistry();
    await run(registry, "fleet.armFocused");
    const armed = useFleetArmingStore.getState().armedIds;
    expect(armed.has("a")).toBe(false);
    expect(armed.has("b")).toBe(true);
    expect(armed.size).toBe(1);
  });

  it("no-ops when no pane is focused", async () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    usePanelStore.setState({ focusedId: null });
    const registry = await buildRegistry();
    await run(registry, "fleet.armFocused");
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
  });

  it("no-ops when the focused pane is not fleet-eligible", async () => {
    // location: "trash" disqualifies via isFleetArmEligible — same gate the
    // mouse path uses, so chord and click stay symmetric.
    seedPanels([makeAgent("a", { location: "trash" })]);
    usePanelStore.setState({ focusedId: "a" });
    const registry = await buildRegistry();
    await run(registry, "fleet.armFocused");
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
  });

  it("builds up a fleet across successive focus changes", async () => {
    // The keyboard workflow we're enabling: focus A, arm, focus B, arm,
    // focus C, arm — ends up with a 3-pane fleet without touching the mouse.
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    const registry = await buildRegistry();

    usePanelStore.setState({ focusedId: "a" });
    await run(registry, "fleet.armFocused");
    usePanelStore.setState({ focusedId: "b" });
    await run(registry, "fleet.armFocused");
    usePanelStore.setState({ focusedId: "c" });
    await run(registry, "fleet.armFocused");

    const armed = useFleetArmingStore.getState().armedIds;
    expect(armed.size).toBe(3);
    expect(armed.has("a")).toBe(true);
    expect(armed.has("b")).toBe(true);
    expect(armed.has("c")).toBe(true);
    // armOrder reflects the chronological add order, so the last-armed
    // becomes the lastArmedId — important for the existing exit-fleet
    // restore-focus behavior.
    expect(useFleetArmingStore.getState().lastArmedId).toBe("c");
  });
});
