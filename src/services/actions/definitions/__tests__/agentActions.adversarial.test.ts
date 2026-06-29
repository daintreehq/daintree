import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({
  getState: vi.fn(),
}));

const currentViewStoreMock = vi.hoisted(() => ({
  getCurrentViewStore: vi.fn(),
}));

const worktreeSelectionMock = vi.hoisted(() => ({
  useWorktreeSelectionStore: {
    getState: vi.fn<() => { activeWorktreeId: string | null }>(() => ({
      activeWorktreeId: null,
    })),
  },
}));

const agentRegistryMock = vi.hoisted(() => ({
  AGENT_REGISTRY: {
    claude: { name: "Claude" },
    codex: { name: "Codex" },
  },
  getAgentDisplayTitle: vi.fn((id: string) => `Title:${id}`),
}));

const clientsMock = vi.hoisted(() => ({
  agentSettingsClient: {
    get: vi.fn(),
  },
  cliAvailabilityClient: {
    get: vi.fn(),
  },
}));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/createWorktreeStore", () => currentViewStoreMock);
vi.mock("@/store/worktreeStore", () => worktreeSelectionMock);
vi.mock("@/config/agents", () => agentRegistryMock);
vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    agentSettingsClient: clientsMock.agentSettingsClient,
    cliAvailabilityClient: clientsMock.cliAvailabilityClient,
  };
});

import { registerAgentActions } from "../agentActions";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";

function makeCallbacks() {
  return {
    onLaunchAgent: vi.fn().mockResolvedValue({ terminalId: "term-1", location: "grid" }),
    onOpenQuickSwitcher: vi.fn(),
  } as unknown as ActionCallbacks & {
    onLaunchAgent: ReturnType<typeof vi.fn>;
    onOpenQuickSwitcher: ReturnType<typeof vi.fn>;
  };
}

function setupActions(callbacks: ActionCallbacks) {
  const actions: ActionRegistry = new Map();
  registerAgentActions(actions, callbacks);
  return actions;
}

function callAction(actions: ActionRegistry, id: string, args?: unknown): Promise<unknown> {
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  const def = factory() as AnyActionDefinition;
  return def.run(args, {} as never);
}

function setPanelState(
  overrides: {
    focusNextWaiting?: ReturnType<typeof vi.fn>;
    focusNextWorking?: ReturnType<typeof vi.fn>;
    focusNextAgent?: ReturnType<typeof vi.fn>;
    focusPreviousAgent?: ReturnType<typeof vi.fn>;
    focusNextBlockedDock?: ReturnType<typeof vi.fn>;
    isInTrash?: boolean;
    getPanelGroup?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const state = {
    focusNextWaiting: overrides.focusNextWaiting ?? vi.fn(),
    focusNextWorking: overrides.focusNextWorking ?? vi.fn(),
    focusNextAgent: overrides.focusNextAgent ?? vi.fn(),
    focusPreviousAgent: overrides.focusPreviousAgent ?? vi.fn(),
    focusNextBlockedDock: overrides.focusNextBlockedDock ?? vi.fn(),
    isInTrash: overrides.isInTrash ?? false,
    getPanelGroup: overrides.getPanelGroup ?? vi.fn(),
  };
  panelStoreMock.getState.mockReturnValue(state);
  return state;
}

function setWorktreeMap(entries: Array<[string, { worktreeId?: string }]>) {
  currentViewStoreMock.getCurrentViewStore.mockReturnValue({
    getState: () => ({ worktrees: new Map(entries) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setPanelState();
  setWorktreeMap([]);
});

describe("agentActions adversarial", () => {
  it("agent.launch remaps 'model' arg to 'modelId' in the callback", async () => {
    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);

    const result = await callAction(actions, "agent.launch", {
      agentId: "claude",
      location: "grid",
      cwd: "/repo",
      worktreeId: "wt-1",
      prompt: "hello",
      interactive: true,
      model: "gpt-5",
    });

    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith("claude", {
      location: "grid",
      cwd: "/repo",
      worktreeId: "wt-1",
      prompt: "hello",
      interactive: true,
      modelId: "gpt-5",
    });
    expect(result).toEqual({ terminalId: "term-1", location: "grid" });
  });

  it("agent.launch forwards 'name' to the launch callback", async () => {
    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);

    await callAction(actions, "agent.launch", {
      agentId: "claude",
      prompt: "do the thing",
      name: "Claude: auth refactor",
    });

    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ name: "Claude: auth refactor" })
    );
  });

  it("agent.launch omits 'name' from the callback when not provided", async () => {
    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);

    await callAction(actions, "agent.launch", { agentId: "claude" });

    const [, options] = callbacks.onLaunchAgent.mock.calls[0] ?? [];
    expect(options?.name).toBeUndefined();
  });

  it("agent.launch forwards a whitespace-only 'name' verbatim (downstream decides fallback)", async () => {
    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);

    await callAction(actions, "agent.launch", { agentId: "claude", name: "   " });

    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ name: "   " })
    );
  });

  it("one agent.<id> action is registered per AGENT_REGISTRY entry", () => {
    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);

    expect(actions.has("agent.claude")).toBe(true);
    expect(actions.has("agent.codex")).toBe(true);
    expect(actions.has("agent.terminal")).toBe(true);
    expect(actions.has("agent.browser")).toBe(true);
  });

  it("each generated agent.<id> launches its own agent id (no closure capture bug)", async () => {
    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);

    await callAction(actions, "agent.claude");
    await callAction(actions, "agent.codex");
    await callAction(actions, "agent.terminal");
    await callAction(actions, "agent.browser");

    expect(callbacks.onLaunchAgent).toHaveBeenNthCalledWith(1, "claude", {
      location: undefined,
      spawnedBy: undefined,
    });
    expect(callbacks.onLaunchAgent).toHaveBeenNthCalledWith(2, "codex", {
      location: undefined,
      spawnedBy: undefined,
    });
    expect(callbacks.onLaunchAgent).toHaveBeenNthCalledWith(3, "terminal", {
      location: undefined,
      spawnedBy: undefined,
    });
    expect(callbacks.onLaunchAgent).toHaveBeenNthCalledWith(4, "browser", {
      location: undefined,
      spawnedBy: undefined,
    });
  });

  it("shortcut launch actions accept omitted args through ActionService dispatch", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();

    const callbacks = makeCallbacks();
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, callbacks);

    for (const [, factory] of registry) {
      service.register(factory());
    }

    const terminal = await service.dispatch("agent.terminal", undefined, { source: "keybinding" });
    const browser = await service.dispatch("agent.browser", undefined, { source: "keybinding" });

    expect(terminal.ok).toBe(true);
    expect(browser.ok).toBe(true);
    expect(callbacks.onLaunchAgent).toHaveBeenNthCalledWith(1, "terminal", {
      location: undefined,
      spawnedBy: undefined,
    });
    expect(callbacks.onLaunchAgent).toHaveBeenNthCalledWith(2, "browser", {
      location: undefined,
      spawnedBy: undefined,
    });
  });

  it("agent.launch accepts 'name' through ActionService schema validation", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();

    const callbacks = makeCallbacks();
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, callbacks);
    for (const [, factory] of registry) service.register(factory());

    const result = await service.dispatch(
      "agent.launch",
      { agentId: "claude", name: "Claude: auth refactor" },
      { source: "agent" }
    );

    expect(result.ok).toBe(true);
    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ name: "Claude: auth refactor" })
    );
  });

  it("agent.launch rejects a 'name' longer than the 200-char cap", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();

    const callbacks = makeCallbacks();
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, callbacks);
    for (const [, factory] of registry) service.register(factory());

    const result = await service.dispatch(
      "agent.launch",
      { agentId: "claude", name: "x".repeat(201) },
      { source: "agent" }
    );

    expect(result.ok).toBe(false);
    expect(callbacks.onLaunchAgent).not.toHaveBeenCalled();
  });

  it("agent.palette only opens the quick switcher and does not launch", async () => {
    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    await callAction(actions, "agent.palette");

    expect(callbacks.onOpenQuickSwitcher).toHaveBeenCalledTimes(1);
    expect(callbacks.onLaunchAgent).not.toHaveBeenCalled();
  });

  it("focusNextWaiting passes isInTrash + the valid-worktree Set (both map key and nested worktreeId)", async () => {
    const focusNextWaiting = vi.fn();
    setPanelState({ focusNextWaiting, isInTrash: true });
    setWorktreeMap([
      ["key-a", { worktreeId: "alias-a" }],
      ["key-b", {}],
    ]);

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    await callAction(actions, "agent.focusNextWaiting");

    expect(focusNextWaiting).toHaveBeenCalledTimes(1);
    const [isInTrash, set] = focusNextWaiting.mock.calls[0]!;
    expect(isInTrash).toBe(true);
    expect(set instanceof Set).toBe(true);
    expect([...(set as Set<string>)].sort()).toEqual(["alias-a", "key-a", "key-b"]);
  });

  it("focusNextWorking and focusPreviousAgent both respect the same trash mode + id set", async () => {
    const focusNextWorking = vi.fn();
    const focusPreviousAgent = vi.fn();
    setPanelState({ focusNextWorking, focusPreviousAgent, isInTrash: false });
    setWorktreeMap([["k", { worktreeId: "k" }]]);

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);

    await callAction(actions, "agent.focusNextWorking");
    await callAction(actions, "agent.focusPreviousAgent");

    expect(focusNextWorking).toHaveBeenCalledWith(false, expect.any(Set));
    expect(focusPreviousAgent).toHaveBeenCalledWith(false, expect.any(Set));
  });

  it("dock.focusNextWaiting normalizes null activeWorktreeId to undefined for focusNextBlockedDock", async () => {
    const focusNextBlockedDock = vi.fn();
    const getPanelGroup = vi.fn();
    setPanelState({ focusNextBlockedDock, getPanelGroup });
    worktreeSelectionMock.useWorktreeSelectionStore.getState.mockReturnValue({
      activeWorktreeId: null,
    });

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    await callAction(actions, "dock.focusNextWaiting");

    expect(focusNextBlockedDock).toHaveBeenCalledWith(undefined, getPanelGroup);
  });

  it("dock.focusNextWaiting forwards a real activeWorktreeId unchanged", async () => {
    const focusNextBlockedDock = vi.fn();
    const getPanelGroup = vi.fn();
    setPanelState({ focusNextBlockedDock, getPanelGroup });
    worktreeSelectionMock.useWorktreeSelectionStore.getState.mockReturnValue({
      activeWorktreeId: "wt-live",
    });

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    await callAction(actions, "dock.focusNextWaiting");

    expect(focusNextBlockedDock).toHaveBeenCalledWith("wt-live", getPanelGroup);
  });

  it("onLaunchAgent rejection propagates out of agent.launch", async () => {
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockRejectedValueOnce(new Error("launcher boom"));
    const actions = setupActions(callbacks);

    await expect(callAction(actions, "agent.launch", { agentId: "claude" })).rejects.toThrow(
      "launcher boom"
    );
  });

  it("agent.launch surfaces a worktree-not-found launcher error as ok:false through ActionService (#10812)", async () => {
    // Regression guard: a worktree-not-found launch must reach the MCP layer as a
    // dispatch failure (ok:false), NOT as a terminal-less success ({ok:true,result:null}).
    // The hook throws on an unknown worktreeId; ActionService converts the throw to
    // an EXECUTION_ERROR result, which sessionServer serializes with isError:true.
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();

    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockRejectedValueOnce(
      new Error("Worktree 'main' not found. Available worktree IDs: wt-1, wt-2")
    );
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, callbacks);
    for (const [, factory] of registry) service.register(factory());

    const result = await service.dispatch(
      "agent.launch",
      { agentId: "claude", worktreeId: "main" },
      { source: "agent" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXECUTION_ERROR");
      expect(result.error.message).toContain("Worktree 'main' not found");
      expect(result.error.message).toContain("wt-1, wt-2");
    }
  });

  it("onLaunchAgent rejection propagates out of generated agent.<id>", async () => {
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockRejectedValueOnce(new Error("generator boom"));
    const actions = setupActions(callbacks);

    await expect(callAction(actions, "agent.claude")).rejects.toThrow("generator boom");
  });

  it("agent.getState returns matching panel data when launchAgentId matches", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["term-a", "term-b"],
      panelsById: {
        "term-a": {
          id: "term-a",
          launchAgentId: "claude",
          agentState: "working",
          lastStateChange: 1717000000000,
        },
        "term-b": {
          id: "term-b",
          launchAgentId: "codex",
          agentState: "idle",
          lastStateChange: 1717000005000,
        },
      },
    });

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    const result = await callAction(actions, "agent.getState", { agentId: "codex" });

    expect(result).toEqual({
      agentId: "codex",
      state: "idle",
      waitingReason: null,
      lastTransitionAt: 1717000005000,
      exitCode: null,
      spawnedAt: null,
      terminalId: "term-b",
      found: true,
    });
  });

  it("agent.getState returns runtime-detected agent state without launch affinity", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["term-runtime"],
      panelsById: {
        "term-runtime": {
          id: "term-runtime",
          detectedAgentId: "claude",
          agentState: "working",
          lastStateChange: 1717000009000,
        },
      },
    });

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    const result = await callAction(actions, "agent.getState", { agentId: "claude" });

    expect(result).toEqual({
      agentId: "claude",
      state: "working",
      waitingReason: null,
      lastTransitionAt: 1717000009000,
      exitCode: null,
      spawnedAt: null,
      terminalId: "term-runtime",
      found: true,
    });
  });

  it("agent.getState returns found:false with null fields when no panel matches", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["term-a"],
      panelsById: {
        "term-a": { id: "term-a", launchAgentId: "claude", agentState: "working" },
      },
    });

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    const result = await callAction(actions, "agent.getState", { agentId: "gemini" });

    expect(result).toEqual({
      agentId: "gemini",
      state: null,
      waitingReason: null,
      lastTransitionAt: null,
      exitCode: null,
      spawnedAt: null,
      terminalId: null,
      found: false,
    });
  });

  it("agent.getState returns the first matching panel when multiple share an agentId", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["term-first", "term-second"],
      panelsById: {
        "term-first": {
          id: "term-first",
          launchAgentId: "claude",
          agentState: "waiting",
          lastStateChange: 100,
        },
        "term-second": {
          id: "term-second",
          launchAgentId: "claude",
          agentState: "working",
          lastStateChange: 200,
        },
      },
    });

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    const result = await callAction(actions, "agent.getState", { agentId: "claude" });

    expect(result).toMatchObject({ terminalId: "term-first", state: "waiting" });
  });

  it("agent.getState tolerates panels missing agentState/lastStateChange", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["term-a"],
      panelsById: {
        "term-a": { id: "term-a", launchAgentId: "claude" },
      },
    });

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    const result = await callAction(actions, "agent.getState", { agentId: "claude" });

    expect(result).toEqual({
      agentId: "claude",
      state: null,
      waitingReason: null,
      lastTransitionAt: null,
      exitCode: null,
      spawnedAt: null,
      terminalId: "term-a",
      found: true,
    });
  });

  it("agent.getState skips ephemeral panels even when their launchAgentId matches", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["term-ephemeral", "term-real"],
      panelsById: {
        "term-ephemeral": {
          id: "term-ephemeral",
          launchAgentId: "claude",
          agentState: "working",
          excludeFromPersistence: true,
        },
        "term-real": {
          id: "term-real",
          launchAgentId: "claude",
          agentState: "idle",
          lastStateChange: 999,
        },
      },
    });

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    const result = await callAction(actions, "agent.getState", { agentId: "claude" });

    expect(result).toMatchObject({ terminalId: "term-real", state: "idle", found: true });
  });

  it("agent.getState rejects empty agentId at the schema layer", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();
    const callbacks = makeCallbacks();
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, callbacks);
    for (const [, factory] of registry) {
      service.register(factory());
    }

    const result = await service.dispatch("agent.getState", { agentId: "" }, { source: "user" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("focusNextAgent builds the Set from both map keys and nested worktreeIds (aliases added)", async () => {
    const focusNextAgent = vi.fn();
    setPanelState({ focusNextAgent });
    setWorktreeMap([
      ["primary", { worktreeId: "backup" }],
      ["other", {}],
    ]);

    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);
    await callAction(actions, "agent.focusNextAgent");

    const [, set] = focusNextAgent.mock.calls[0]!;
    expect([...(set as Set<string>)].sort()).toEqual(["backup", "other", "primary"]);
  });
});

describe("agent.launch dispatch integration", () => {
  it("routes through ActionService.dispatch with validated args and returns terminalId", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();

    const callbacks = makeCallbacks();
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, callbacks);

    for (const [, factory] of registry) {
      service.register(factory());
    }

    const result = await service.dispatch<{ terminalId: string }>(
      "agent.launch",
      { agentId: "claude", worktreeId: "wt-1", location: "grid" },
      { source: "user" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ terminalId: "term-1", location: "grid" });
    }
    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith("claude", {
      location: "grid",
      cwd: undefined,
      worktreeId: "wt-1",
      prompt: undefined,
      interactive: undefined,
      modelId: undefined,
    });
  });

  it("rejects an empty agentId with a VALIDATION_ERROR targeting agentId and never invokes the callback", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();

    const callbacks = makeCallbacks();
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, callbacks);

    for (const [, factory] of registry) {
      service.register(factory());
    }

    // An empty string is the genuinely-malformed case: the schema now accepts
    // arbitrary non-empty ids (plugin-contributed agents, #10560), but still
    // rejects empty/missing ids at the boundary.
    const result = await service.dispatch("agent.launch", { agentId: "" }, { source: "user" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(result.error.details)).toContain("agentId");
    }
    expect(callbacks.onLaunchAgent).not.toHaveBeenCalled();
  });

  it("accepts an unknown (plugin-contributed) agentId through the schema so plugin agents launch (#10560)", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();

    const callbacks = makeCallbacks();
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, callbacks);

    for (const [, factory] of registry) {
      service.register(factory());
    }

    // Plugin agent ids are dynamic and unknown at schema-definition time, so the
    // schema must let them through; existence is resolved downstream in the
    // launcher (an unresolved id falls back to a plain terminal, never a crash).
    const result = await service.dispatch(
      "agent.launch",
      { agentId: "acme-agent", worktreeId: "wt-1", location: "grid" },
      { source: "user" }
    );

    expect(result.ok).toBe(true);
    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith(
      "acme-agent",
      expect.objectContaining({ worktreeId: "wt-1", location: "grid" })
    );
  });

  it("accepts dev-preview through the schema so worktree-card dev-preview launches don't silently fail", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();

    const callbacks = makeCallbacks();
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, callbacks);

    for (const [, factory] of registry) {
      service.register(factory());
    }

    const result = await service.dispatch(
      "agent.launch",
      { agentId: "dev-preview", worktreeId: "wt-1", location: "grid" },
      { source: "user" }
    );

    expect(result.ok).toBe(true);
    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith(
      "dev-preview",
      expect.objectContaining({ worktreeId: "wt-1", location: "grid" })
    );
  });

  it("accepts overlay location through the schema so Assistant launches don't silently fail (#9640)", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();

    const callbacks = makeCallbacks();
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, callbacks);

    for (const [, factory] of registry) {
      service.register(factory());
    }

    const result = await service.dispatch(
      "agent.launch",
      { agentId: "claude", cwd: "/help", location: "overlay", excludeFromPersistence: true },
      { source: "user" }
    );

    expect(result.ok).toBe(true);
    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ location: "overlay" })
    );
  });
});

describe("agent.listToolbar (#10838)", () => {
  type ToolbarRow = {
    id: string;
    displayName: string;
    pinned?: boolean;
    installed: boolean;
    visible: boolean;
  };

  async function listToolbar(
    settings: { agents?: Record<string, { pinned?: boolean }> },
    availability: Record<string, string>
  ): Promise<ToolbarRow[]> {
    clientsMock.agentSettingsClient.get.mockResolvedValue(settings);
    clientsMock.cliAvailabilityClient.get.mockResolvedValue(availability);
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agent.listToolbar")) as { agents: ToolbarRow[] };
    return result.agents;
  }

  function rowFor(rows: ToolbarRow[], id: string): ToolbarRow {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`no row for ${id}`);
    return row;
  }

  it("returns one row per launchable agent, in registry order", async () => {
    const rows = await listToolbar({ agents: {} }, {});
    expect(rows.map((r) => r.id)).toEqual([...LAUNCHABLE_AGENT_IDS]);
    // assistant-only agents are never launchable and must not appear
    expect(rows.some((r) => r.id === "daintree-assistant")).toBe(false);
  });

  it("explicit pin (pinned:true) wins over a missing binary — visible:true, installed:false", async () => {
    const rows = await listToolbar({ agents: { claude: { pinned: true } } }, { claude: "missing" });
    const claude = rowFor(rows, "claude");
    expect(claude.pinned).toBe(true);
    expect(claude.installed).toBe(false);
    expect(claude.visible).toBe(true);
  });

  it("explicit unpin (pinned:false) wins over an installed binary — visible:false, installed:true", async () => {
    const rows = await listToolbar({ agents: { codex: { pinned: false } } }, { codex: "ready" });
    const codex = rowFor(rows, "codex");
    expect(codex.pinned).toBe(false);
    expect(codex.installed).toBe(true);
    expect(codex.visible).toBe(false);
  });

  it("omits pinned and follows live availability when no setting is present", async () => {
    const rows = await listToolbar({ agents: {} }, { gemini: "ready", aider: "missing" });
    const gemini = rowFor(rows, "gemini");
    expect(gemini).not.toHaveProperty("pinned");
    expect(gemini.installed).toBe(true);
    expect(gemini.visible).toBe(true);

    const aider = rowFor(rows, "aider");
    expect(aider).not.toHaveProperty("pinned");
    expect(aider.installed).toBe(false);
    expect(aider.visible).toBe(false);
  });

  it("treats blocked/unauthenticated binaries as installed", async () => {
    const rows = await listToolbar({ agents: {} }, { gemini: "blocked", aider: "unauthenticated" });
    expect(rowFor(rows, "gemini").installed).toBe(true);
    expect(rowFor(rows, "aider").installed).toBe(true);
  });

  it("uses getAgentDisplayTitle for displayName", async () => {
    const rows = await listToolbar({ agents: {} }, {});
    expect(rowFor(rows, "claude").displayName).toBe("Title:claude");
  });

  it("reads settings and availability once each — no fresh probing", async () => {
    await listToolbar({ agents: {} }, {});
    expect(clientsMock.agentSettingsClient.get).toHaveBeenCalledTimes(1);
    expect(clientsMock.cliAvailabilityClient.get).toHaveBeenCalledTimes(1);
  });

  it("rejects without a partial result when the settings read fails", async () => {
    clientsMock.agentSettingsClient.get.mockRejectedValue(new Error("IPC error"));
    clientsMock.cliAvailabilityClient.get.mockResolvedValue({});
    const actions = setupActions(makeCallbacks());
    await expect(callAction(actions, "agent.listToolbar")).rejects.toThrow("IPC error");
  });
});
