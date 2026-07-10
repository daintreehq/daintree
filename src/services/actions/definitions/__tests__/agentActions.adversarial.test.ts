import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  agentCapabilitiesClient: {
    getRegistry: vi.fn(),
  },
  userAgentRegistryClient: {
    get: vi.fn(),
  },
}));

const agentSettingsStoreMock = vi.hoisted(() => ({
  useAgentSettingsStore: { getState: vi.fn() },
}));

const cliAvailabilityStoreMock = vi.hoisted(() => ({
  useCliAvailabilityStore: { getState: vi.fn() },
}));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/createWorktreeStore", () => currentViewStoreMock);
vi.mock("@/store/worktreeStore", () => worktreeSelectionMock);
vi.mock("@/store/agentSettingsStore", () => agentSettingsStoreMock);
vi.mock("@/store/cliAvailabilityStore", () => cliAvailabilityStoreMock);
vi.mock("@/config/agents", () => agentRegistryMock);
vi.mock("@/clients/userAgentRegistryClient", () => ({
  userAgentRegistryClient: clientsMock.userAgentRegistryClient,
}));
vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    agentSettingsClient: clientsMock.agentSettingsClient,
    cliAvailabilityClient: clientsMock.cliAvailabilityClient,
    agentCapabilitiesClient: clientsMock.agentCapabilitiesClient,
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

  it("agent.launch preserves the atomic missing-CLI diagnostic discriminant", async () => {
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockResolvedValueOnce({
      terminalId: "diagnostic-panel",
      location: "grid",
      spawnStatus: "missing-cli",
    });
    const actions = setupActions(callbacks);

    const result = await callAction(actions, "agent.launch", { agentId: "claude" });

    expect(result).toEqual({
      terminalId: "diagnostic-panel",
      location: "grid",
      spawnStatus: "missing-cli",
    });
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

  // Drive the normalized renderer stores the toolbar itself reads from, with
  // `hasRealData: true` so the action takes the store path (not the client
  // fallback) — the steady-state case.
  function setStores(
    settings: { agents?: Record<string, unknown> } | null,
    availability: Record<string, string>,
    hasRealData = true
  ): void {
    agentSettingsStoreMock.useAgentSettingsStore.getState.mockReturnValue({ settings });
    cliAvailabilityStoreMock.useCliAvailabilityStore.getState.mockReturnValue({
      availability,
      hasRealData,
    });
  }

  async function listToolbar(
    settings: { agents?: Record<string, unknown> },
    availability: Record<string, string>
  ): Promise<ToolbarRow[]> {
    setStores(settings, availability);
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

  it.each([
    ["ready", true, true],
    ["installed", true, true],
    ["blocked", true, true],
    ["unauthenticated", true, true],
    ["missing", false, false],
  ] as const)(
    "with no pin, availability %s -> installed:%s visible:%s",
    async (state, installed, visible) => {
      const rows = await listToolbar({ agents: {} }, { gemini: state });
      const gemini = rowFor(rows, "gemini");
      expect(gemini.installed).toBe(installed);
      expect(gemini.visible).toBe(visible);
    }
  );

  it("treats undefined availability (no entry) as not installed / not visible", async () => {
    const rows = await listToolbar({ agents: {} }, {});
    const gemini = rowFor(rows, "gemini");
    expect(gemini.installed).toBe(false);
    expect(gemini.visible).toBe(false);
  });

  it("uses getAgentDisplayTitle for displayName", async () => {
    const rows = await listToolbar({ agents: {} }, {});
    expect(rowFor(rows, "claude").displayName).toBe("Title:claude");
  });

  it("never leaks sensitive agent-settings fields — only the toolbar shape is returned", async () => {
    const rows = await listToolbar(
      {
        agents: {
          claude: {
            pinned: true,
            customFlags: "--dangerously-skip-permissions",
            env: { SECRET: "shh" },
            presets: [{ id: "p1" }],
            dangerousEnabled: true,
          },
        },
      },
      { claude: "ready" }
    );
    expect(Object.keys(rowFor(rows, "claude")).sort()).toEqual(
      ["displayName", "id", "installed", "pinned", "visible"].sort()
    );
  });

  it("treats a non-boolean pinned (corrupted config) as absent — never forwarded", async () => {
    const rows = await listToolbar(
      { agents: { claude: { pinned: null as unknown as boolean } } },
      { claude: "ready" }
    );
    const claude = rowFor(rows, "claude");
    expect(claude).not.toHaveProperty("pinned");
    // Falls through to availability since the bad pin is ignored.
    expect(claude.visible).toBe(true);
  });

  it("reads from the renderer stores without probing the IPC clients in steady state", async () => {
    await listToolbar({ agents: {} }, {});
    expect(agentSettingsStoreMock.useAgentSettingsStore.getState).toHaveBeenCalledTimes(1);
    expect(cliAvailabilityStoreMock.useCliAvailabilityStore.getState).toHaveBeenCalledTimes(1);
    expect(clientsMock.agentSettingsClient.get).not.toHaveBeenCalled();
    expect(clientsMock.cliAvailabilityClient.get).not.toHaveBeenCalled();
  });

  it("falls back to the cache-aware clients when the stores have not hydrated", async () => {
    setStores(null, {}, false);
    clientsMock.agentSettingsClient.get.mockResolvedValue({ agents: { codex: { pinned: true } } });
    clientsMock.cliAvailabilityClient.get.mockResolvedValue({ codex: "missing" });
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agent.listToolbar")) as { agents: ToolbarRow[] };
    expect(clientsMock.agentSettingsClient.get).toHaveBeenCalledTimes(1);
    expect(clientsMock.cliAvailabilityClient.get).toHaveBeenCalledTimes(1);
    const codex = rowFor(result.agents, "codex");
    expect(codex.pinned).toBe(true);
    expect(codex.visible).toBe(true);
  });

  it("rejects without a partial result when the settings read fails", async () => {
    setStores(null, {}, true);
    clientsMock.agentSettingsClient.get.mockRejectedValue(new Error("IPC error"));
    const actions = setupActions(makeCallbacks());
    await expect(callAction(actions, "agent.listToolbar")).rejects.toThrow("IPC error");
  });

  it("registers with the expected read-only discovery metadata", () => {
    const actions = setupActions(makeCallbacks());
    const def = actions.get("agent.listToolbar")?.() as AnyActionDefinition;
    expect(def).toBeDefined();
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.scope).toBe("renderer");
    expect(def.mcpVisibility).toBe("discoverable");
    expect(def.argsSchema).toBeUndefined();
  });
});

describe("agent.listAvailable", () => {
  type AvailableRow = {
    id: string;
    displayName: string;
    source: "built-in" | "user" | "plugin";
    launchable?: boolean;
    availability?: string;
    installed?: boolean;
    pinned?: boolean;
    toolbarVisible?: boolean;
  };

  function setStores(
    settings: { agents?: Record<string, unknown> } | null,
    availability: Record<string, string>,
    hasRealData = true
  ): void {
    agentSettingsStoreMock.useAgentSettingsStore.getState.mockReturnValue({ settings });
    cliAvailabilityStoreMock.useCliAvailabilityStore.getState.mockReturnValue({
      availability,
      hasRealData,
    });
  }

  it("returns the complete effective registry with toolbar fields only for built-ins", async () => {
    setStores(
      { agents: { claude: { pinned: true } } },
      { claude: "ready", "custom-agent": "missing" }
    );
    clientsMock.agentCapabilitiesClient.getRegistry.mockResolvedValue({
      "plugin-agent": { name: "Plugin" },
      "custom-agent": { name: "Custom" },
      claude: { name: "Claude" },
      "daintree-assistant": { name: "Assistant" },
    });
    clientsMock.userAgentRegistryClient.get.mockResolvedValue({
      "custom-agent": { name: "Custom" },
    });
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agent.listAvailable")) as {
      complete: boolean;
      availabilityComplete: boolean;
      agents: AvailableRow[];
    };

    expect(result.complete).toBe(true);
    expect(result.availabilityComplete).toBe(false);
    expect(result.agents.map((row) => row.id)).toEqual(["claude", "custom-agent", "plugin-agent"]);
    const claude = result.agents[0];
    expect(claude).toMatchObject({
      source: "built-in",
      availability: "ready",
      installed: true,
      launchable: true,
      pinned: true,
      toolbarVisible: true,
    });
    expect(result.agents[1]).toMatchObject({
      source: "user",
      availability: "missing",
      installed: false,
      launchable: false,
    });
    expect(result.agents[1]).not.toHaveProperty("toolbarVisible");
    expect(result.agents[2]).toMatchObject({
      source: "plugin",
      displayName: "Plugin",
    });
    expect(result.agents[2]).not.toHaveProperty("availability");
    expect(result.agents[2]).not.toHaveProperty("installed");
    expect(result.agents[2]).not.toHaveProperty("launchable");
    expect(result.agents[2]).not.toHaveProperty("pinned");
  });

  it("registers as a narrow discoverable read with a structured MCP result", () => {
    const actions = setupActions(makeCallbacks());
    const def = actions.get("agent.listAvailable")?.() as AnyActionDefinition;
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.scope).toBe("renderer");
    expect(def.mcpVisibility).toBe("discoverable");
    expect(def.mcpOutputSchema).toBe(true);
  });

  it("re-reads authoritative registry membership and never leaks registry/settings details", async () => {
    setStores(
      {
        agents: {
          claude: {
            pinned: false,
            env: { SECRET: "shh" },
            customFlags: "--dangerous",
            presets: [{ id: "private" }],
          },
        },
      },
      { claude: "ready", "plugin-agent": "blocked" }
    );
    clientsMock.agentCapabilitiesClient.getRegistry
      .mockResolvedValueOnce({
        claude: { name: "Claude", command: "claude", env: { TOKEN: "secret" } },
        "plugin-agent": {
          name: "Plugin Agent",
          command: "private-command",
          args: ["--secret"],
        },
      })
      .mockResolvedValueOnce({ claude: { name: "Claude" } });
    clientsMock.userAgentRegistryClient.get.mockResolvedValue({});
    const actions = setupActions(makeCallbacks());

    const first = (await callAction(actions, "agent.listAvailable")) as {
      availabilityComplete: boolean;
      agents: AvailableRow[];
    };
    expect(first.availabilityComplete).toBe(true);
    expect(first.agents.map((row) => row.id)).toEqual(["claude", "plugin-agent"]);
    expect(Object.keys(first.agents[0]!).sort()).toEqual(
      [
        "availability",
        "displayName",
        "id",
        "installed",
        "launchable",
        "pinned",
        "source",
        "toolbarVisible",
      ].sort()
    );
    expect(Object.keys(first.agents[1]!).sort()).toEqual(
      ["availability", "displayName", "id", "installed", "launchable", "source"].sort()
    );
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(JSON.stringify(first)).not.toContain("private-command");
    expect(JSON.stringify(first)).not.toContain("dangerous");

    const second = (await callAction(actions, "agent.listAvailable")) as {
      agents: AvailableRow[];
    };
    expect(second.agents.map((row) => row.id)).toEqual(["claude"]);
    expect(clientsMock.agentCapabilitiesClient.getRegistry).toHaveBeenCalledTimes(2);
  });
});

describe("agentSessionHistory.list (#10854)", () => {
  const SAMPLE_SESSIONS = [
    {
      sessionId: "sess-1",
      agentId: "claude",
      worktreeId: "wt-1",
      title: "Auth refactor",
      projectId: "proj-1",
      savedAt: 1_700_000_000_000,
      agentLaunchFlags: ["--model", "opus"],
      agentModelId: "claude-opus",
      cwd: "/repo",
      branch: "feature/auth",
    },
    {
      // Minimal record: nullable fields null, all optionals absent.
      sessionId: "sess-2",
      agentId: "codex",
      worktreeId: null,
      title: null,
      projectId: null,
      savedAt: 1_699_000_000_000,
    },
  ];

  const listMock = vi.fn();

  beforeEach(() => {
    listMock.mockReset();
    listMock.mockResolvedValue(SAMPLE_SESSIONS);
    // @ts-expect-error - minimal window.electron stub for the renderer IPC call
    globalThis.window = { electron: { agentSessionHistory: { list: listMock } } };
  });

  afterEach(() => {
    // @ts-expect-error - tear down the stub so it doesn't leak to other suites
    delete globalThis.window;
  });

  function getDef(): AnyActionDefinition {
    const def = setupActions(makeCallbacks()).get("agentSessionHistory.list")?.() as
      | AnyActionDefinition
      | undefined;
    if (!def) throw new Error("agentSessionHistory.list not registered");
    return def;
  }

  it("forwards the worktreeId arg to the bridge and wraps the result in { sessions }", async () => {
    const actions = setupActions(makeCallbacks());
    const result = await callAction(actions, "agentSessionHistory.list", { worktreeId: "wt-1" });
    expect(listMock).toHaveBeenCalledWith("wt-1");
    expect(result).toEqual({ sessions: SAMPLE_SESSIONS });
  });

  it("passes undefined (cross-project) when no worktreeId is given", async () => {
    const actions = setupActions(makeCallbacks());
    await callAction(actions, "agentSessionHistory.list");
    expect(listMock).toHaveBeenCalledWith(undefined);
  });

  it("passes undefined when called with an empty args object", async () => {
    const actions = setupActions(makeCallbacks());
    await callAction(actions, "agentSessionHistory.list", {});
    expect(listMock).toHaveBeenCalledWith(undefined);
  });

  it("returns the bridge's empty array verbatim (never throws on empty journal)", async () => {
    listMock.mockResolvedValue([]);
    const actions = setupActions(makeCallbacks());
    const result = await callAction(actions, "agentSessionHistory.list", {});
    expect(result).toEqual({ sessions: [] });
  });

  it("registers as a read-only query action advertising an MCP output schema", () => {
    const def = getDef();
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.scope).toBe("renderer");
    expect(def.mcpOutputSchema).toBe(true);
  });

  it("resultSchema accepts both a full record and a null/absent-optional record", () => {
    const parsed = getDef().resultSchema?.safeParse({ sessions: SAMPLE_SESSIONS });
    expect(parsed?.success).toBe(true);
  });

  it("resultSchema rejects a session missing the required sessionId", () => {
    const parsed = getDef().resultSchema?.safeParse({
      sessions: [{ agentId: "claude", worktreeId: null, title: null, projectId: null, savedAt: 1 }],
    });
    expect(parsed?.success).toBe(false);
  });

  it("argsSchema accepts an omitted worktreeId and a non-empty one", () => {
    const schema = getDef().argsSchema;
    expect(schema?.safeParse(undefined).success).toBe(true);
    expect(schema?.safeParse({}).success).toBe(true);
    expect(schema?.safeParse({ worktreeId: "wt-1" }).success).toBe(true);
  });

  it("argsSchema rejects an empty worktreeId (would silently unfilter to cross-project)", () => {
    expect(getDef().argsSchema?.safeParse({ worktreeId: "" }).success).toBe(false);
  });
});
