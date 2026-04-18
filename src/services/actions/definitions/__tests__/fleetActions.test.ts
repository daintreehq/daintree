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
    type: "terminal",
    kind: "agent",
    agentId: "claude",
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

  it("fleet.interrupt only targets working/waiting/running agents", async () => {
    seedPanels([
      makeAgent("a", { agentState: "working" }),
      makeAgent("b", { agentState: "waiting" }),
      makeAgent("c", { agentState: "running" }),
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
});
