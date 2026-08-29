import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

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

const agentPreferencesStoreMock = vi.hoisted(() => ({
  useAgentPreferencesStore: {
    getState: vi.fn<() => { defaultAgent: string | undefined }>(() => ({
      defaultAgent: undefined,
    })),
  },
}));

// Return types are spelled out because `vi.fn` otherwise infers them from the
// default implementation, which narrows `hydratedProjectId` to `null` and makes
// every ownership case below a type error rather than a test.
const ccrPresetsStoreMock = vi.hoisted(() => ({
  useCcrPresetsStore: {
    getState: vi.fn<() => { ccrPresetsByAgent: Record<string, unknown[]>; isInitialized: boolean }>(
      () => ({ ccrPresetsByAgent: {}, isInitialized: true })
    ),
  },
}));

const projectPresetsStoreMock = vi.hoisted(() => ({
  useProjectPresetsStore: {
    getState: vi.fn<
      () => { presetsByAgent: Record<string, unknown[]>; hydratedProjectId: string | null }
    >(() => ({ presetsByAgent: {}, hydratedProjectId: null })),
  },
}));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/createWorktreeStore", () => currentViewStoreMock);
vi.mock("@/store/worktreeStore", () => worktreeSelectionMock);
vi.mock("@/store/agentSettingsStore", () => agentSettingsStoreMock);
vi.mock("@/store/cliAvailabilityStore", () => cliAvailabilityStoreMock);
vi.mock("@/store/agentPreferencesStore", () => agentPreferencesStoreMock);
vi.mock("@/store/ccrPresetsStore", () => ccrPresetsStoreMock);
vi.mock("@/store/projectPresetsStore", () => projectPresetsStoreMock);
// Partial rather than whole-module: a factory-built namespace throws on any
// export it did not declare, so replacing the module outright would break the
// moment production code reaches a second symbol in it. Spreading the real
// module also means the preset-identity merge under test here is the real one.
vi.mock("@/config/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/agents")>();
  return { ...actual, ...agentRegistryMock };
});
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

/**
 * The identity the launcher resolves before spawning and now returns alongside
 * the terminal (#11547). Shared by the callback fixture and the expectations so
 * a field added to one side can't silently drift from the other.
 */
const LAUNCH_IDENTITY = {
  worktreeId: "wt-1",
  worktreePath: "/repo/wt-1",
  branch: "feature/x",
  cwd: "/repo/wt-1",
};

function makeCallbacks() {
  return {
    onLaunchAgent: vi
      .fn()
      .mockResolvedValue({ terminalId: "term-1", location: "grid", ...LAUNCH_IDENTITY }),
    onOpenQuickSwitcher: vi.fn(),
  } as unknown as ActionCallbacks & {
    onLaunchAgent: ReturnType<typeof vi.fn>;
    onOpenQuickSwitcher: ReturnType<typeof vi.fn>;
  };
}

/** The full public `agent.launch` result for a launch that started an agent. */
function launchedResult(overrides: Record<string, unknown> = {}) {
  return {
    launched: true,
    terminalId: "term-1",
    location: "grid",
    spawnStatus: null,
    ...LAUNCH_IDENTITY,
    ...overrides,
  };
}

function setupActions(callbacks: ActionCallbacks) {
  const actions: ActionRegistry = new Map();
  registerAgentActions(actions, callbacks);
  return actions;
}

function getDefinition(actions: ActionRegistry, id: string): AnyActionDefinition {
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

function callAction(
  actions: ActionRegistry,
  id: string,
  args?: unknown,
  ctx: Partial<ActionContext> = {}
): Promise<unknown> {
  return getDefinition(actions, id).run(args, ctx as never);
}

/**
 * Parse a result through the action's own declared schema. Nothing does this at
 * runtime (`resultSchema` is manifest documentation, never enforced), so the
 * round-trip has to be asserted or `run()` silently drifts from what MCP
 * advertises as the tool's outputSchema.
 */
function parseAgainstSchema(actions: ActionRegistry, id: string, result: unknown) {
  const schema = getDefinition(actions, id).resultSchema;
  if (!schema) throw new Error(`${id} has no resultSchema`);
  return schema.safeParse(result);
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
    expect(result).toEqual(launchedResult());
    expect(parseAgainstSchema(actions, "agent.launch", result).success).toBe(true);
  });

  it("agent.launch returns the identity the launcher resolved (#11547)", async () => {
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockResolvedValueOnce({
      terminalId: "term-9",
      location: "dock",
      worktreeId: "wt-42",
      worktreePath: "/repo/wt-42",
      branch: "feature/parallel",
      cwd: "/repo/wt-42/packages/app",
    });
    const actions = setupActions(callbacks);

    // The point of the widening: a caller firing several launches at once maps
    // a terminal back to its worktree without re-resolving the target itself.
    const result = await callAction(actions, "agent.launch", { agentId: "claude" });

    expect(result).toEqual({
      launched: true,
      terminalId: "term-9",
      location: "dock",
      spawnStatus: null,
      worktreeId: "wt-42",
      worktreePath: "/repo/wt-42",
      branch: "feature/parallel",
      cwd: "/repo/wt-42/packages/app",
    });
    expect(parseAgainstSchema(actions, "agent.launch", result).success).toBe(true);
  });

  it("agent.launch reports a launch outside a worktree with null identity fields", async () => {
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockResolvedValueOnce({
      terminalId: "term-3",
      location: "grid",
      worktreeId: null,
      worktreePath: null,
      branch: null,
      cwd: "/home/user/scratch",
    });
    const actions = setupActions(callbacks);

    const result = await callAction(actions, "agent.launch", { agentId: "claude" });

    // cwd is still real — it is where the PTY actually started, which is the
    // only locator a scratch/project-root launch has.
    expect(result).toMatchObject({
      launched: true,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      cwd: "/home/user/scratch",
    });
    expect(parseAgainstSchema(actions, "agent.launch", result).success).toBe(true);
  });

  it("agent.launch preserves the atomic missing-CLI diagnostic discriminant", async () => {
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockResolvedValueOnce({
      terminalId: "diagnostic-panel",
      location: "grid",
      spawnStatus: "missing-cli",
      ...LAUNCH_IDENTITY,
    });
    const actions = setupActions(callbacks);

    const result = await callAction(actions, "agent.launch", { agentId: "claude" });

    // A diagnostic panel is a real panel but no agent started, so `launched` is
    // false while terminalId still points at something the caller can open.
    expect(result).toEqual({
      launched: false,
      terminalId: "diagnostic-panel",
      location: "grid",
      spawnStatus: "missing-cli",
      ...LAUNCH_IDENTITY,
    });
    expect(parseAgainstSchema(actions, "agent.launch", result).success).toBe(true);
  });

  it("agent.launch reports a declined launch as launched:false, not null (#11547)", async () => {
    const callbacks = makeCallbacks();
    // The launcher declines without throwing for a re-entrant launch of the
    // same agent or when Electron is unavailable.
    callbacks.onLaunchAgent.mockResolvedValueOnce(null);
    const actions = setupActions(callbacks);

    const result = await callAction(actions, "agent.launch", { agentId: "claude" });

    // A bare null read to an MCP client as a success with no terminal, and left
    // the declared object output schema unsatisfiable.
    expect(result).toEqual({
      launched: false,
      terminalId: null,
      location: null,
      spawnStatus: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      cwd: null,
    });
    expect(parseAgainstSchema(actions, "agent.launch", result).success).toBe(true);
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
      // worktreeId is required of an agent dispatch (#11722); this test is about
      // `name`, so name the worktree and keep the subject unchanged.
      { agentId: "claude", worktreeId: "wt-1", name: "Claude: auth refactor" },
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
      // Named worktree so the rejection is provably the 200-char cap and not the
      // agent-dispatch worktree guard.
      { agentId: "claude", worktreeId: "wt-1", name: "x".repeat(201) },
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

    const result = await service.dispatch<{ terminalId: string | null }>(
      "agent.launch",
      { agentId: "claude", worktreeId: "wt-1", location: "grid" },
      { source: "user" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual(launchedResult());
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

  // An omitted worktreeId is resolved against the LIVE active-worktree selection at
  // the instant the call lands. A person picking from the palette can see which row is
  // highlighted; an agent cannot, and launches fan out — so a batch dispatched while
  // the user switches worktrees lands split across two of them, with real terminals in
  // the wrong place by the time anyone could re-read (#11722).
  it("refuses an agent-dispatched launch that names no worktree, and launches nothing", async () => {
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
      { agentId: "claude" },
      { source: "agent" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("worktreeId");
    }
    // The point of failing closed: nothing may reach the launcher, or a terminal
    // exists in a worktree nobody chose.
    expect(callbacks.onLaunchAgent).not.toHaveBeenCalled();
  });

  it("lets an agent launch once it names the worktree", async () => {
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
      { agentId: "claude", worktreeId: "wt-1" },
      { source: "agent" }
    );

    expect(result.ok).toBe(true);
    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ worktreeId: "wt-1" })
    );
  });

  // The guard must not reach the surfaces it was already safe for: a person launching
  // from the palette or a keybinding still gets the active worktree.
  it("still lets a user-dispatched launch inherit the active worktree", async () => {
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
      { agentId: "claude" },
      { source: "user" }
    );

    expect(result.ok).toBe(true);
    expect(callbacks.onLaunchAgent).toHaveBeenCalled();
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

  it("accepts a non-built-in agentId through the schema and forwards it for downstream resolution (#10560)", async () => {
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
    // launcher, which rejects an id that resolves to no agent (#11498) rather
    // than degrading it to a plain terminal.
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
    hasRealData = true,
    // Defaults to the steady state (a live probe has completed). Pass false to
    // model the cache-hydrated window, where `availability` is synthesized and
    // must not be certified.
    isInitialized = true
  ): void {
    agentSettingsStoreMock.useAgentSettingsStore.getState.mockReturnValue({ settings });
    cliAvailabilityStoreMock.useCliAvailabilityStore.getState.mockReturnValue({
      availability,
      hasRealData,
      isInitialized,
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

  it("reports the default agent even when it is not on the toolbar", async () => {
    agentPreferencesStoreMock.useAgentPreferencesStore.getState.mockReturnValue({
      defaultAgent: "codex",
    });
    setStores({ agents: { codex: { pinned: false } } }, { codex: "ready" });
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agent.listToolbar")) as {
      agents: ToolbarRow[];
      defaultAgentId?: string;
      resolvedDefaultAgentId?: string;
    };
    // Pinning is a display preference and the default is a launch preference; an
    // explicitly hidden agent is still the agent a launch would pick.
    expect(rowFor(result.agents, "codex").visible).toBe(false);
    expect(result.defaultAgentId).toBe("codex");
    expect(result.resolvedDefaultAgentId).toBe("codex");
  });

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
    // Was `discoverable`, which hid it from tools/list while pretending the
    // meta-tools kept it reachable (#11585). Its tier placement is the control.
    expect(def.mcpVisibility).toBeUndefined();
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
    hasRealData = true,
    // Defaults to the steady state (a live probe has completed). Pass false to
    // model the cache-hydrated window, where `availability` is synthesized and
    // must not be certified.
    isInitialized = true
  ): void {
    agentSettingsStoreMock.useAgentSettingsStore.getState.mockReturnValue({ settings });
    cliAvailabilityStoreMock.useCliAvailabilityStore.getState.mockReturnValue({
      availability,
      hasRealData,
      isInitialized,
    });
  }

  async function listAvailable(
    defaultAgent: string | undefined,
    availability: Record<string, string>,
    isInitialized = true
  ) {
    agentPreferencesStoreMock.useAgentPreferencesStore.getState.mockReturnValue({ defaultAgent });
    setStores({ agents: {} }, availability, true, isInitialized);
    clientsMock.agentCapabilitiesClient.getRegistry.mockResolvedValue({
      claude: { name: "Claude" },
      codex: { name: "Codex" },
    });
    clientsMock.userAgentRegistryClient.get.mockResolvedValue({});
    const actions = setupActions(makeCallbacks());
    return (await callAction(actions, "agent.listAvailable")) as {
      agents: AvailableRow[];
      defaultAgentId?: string;
      resolvedDefaultAgentId?: string;
    };
  }

  it("reports the explicit default and the id a launch would actually resolve to", async () => {
    const result = await listAvailable("codex", { claude: "ready", codex: "ready" });
    expect(result.defaultAgentId).toBe("codex");
    expect(result.resolvedDefaultAgentId).toBe("codex");
  });

  it("keeps the pick but resolves past it when its CLI is not launchable", async () => {
    // The pick is what the user chose and the resolution is what they would get; a
    // caller needs both to say it substituted an agent rather than silently doing it.
    const result = await listAvailable("codex", { claude: "ready", codex: "missing" });
    expect(result.defaultAgentId).toBe("codex");
    expect(result.resolvedDefaultAgentId).toBe("claude");
  });

  it("omits the explicit default when the user picked None (first available)", async () => {
    const result = await listAvailable(undefined, { claude: "ready" });
    expect(result.defaultAgentId).toBeUndefined();
    expect(result.resolvedDefaultAgentId).toBe("claude");
  });

  it("never names an assistant-only agent as the default", async () => {
    // `daintree-assistant` is selectable in the settings dropdown but is absent from
    // this listing's rows, and choosing it means "open the assistant", not "delegate
    // work to it" — so a caller asking which agent to spawn has no pick to honour.
    const result = await listAvailable("daintree-assistant", {
      claude: "ready",
      "daintree-assistant": "ready",
    });
    expect(result.defaultAgentId).toBeUndefined();
    expect(result.resolvedDefaultAgentId).toBe("claude");
    expect(result.agents.some((row) => row.id === "daintree-assistant")).toBe(false);
  });

  it("withholds the resolution until a live probe has run, but keeps the pick", async () => {
    // A hydrating cache synthesizes "missing", which would resolve straight past a
    // default whose CLI is in fact installed.
    const result = await listAvailable("codex", { claude: "ready", codex: "missing" }, false);
    expect(result.defaultAgentId).toBe("codex");
    expect(result.resolvedDefaultAgentId).toBeUndefined();
  });

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

  it("omits availability and never certifies completeness from a still-hydrating cache", async () => {
    // hasRealData is true (cache hydrated) but the live probe has not finished:
    // the availability map here is the synthesized cache, so "missing" must not
    // leak out as an authoritative probe result.
    setStores(
      { agents: { claude: { pinned: true } } },
      { claude: "ready", "new-builtin": "missing" },
      true,
      false
    );
    clientsMock.agentCapabilitiesClient.getRegistry.mockResolvedValue({
      claude: { name: "Claude" },
    });
    clientsMock.userAgentRegistryClient.get.mockResolvedValue({});
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agent.listAvailable")) as {
      availabilityComplete: boolean;
      agents: AvailableRow[];
    };

    expect(result.availabilityComplete).toBe(false);
    const claude = result.agents[0]!;
    // Membership and toolbar visibility still resolve; the unproven probe fields do not.
    expect(claude).toMatchObject({ id: "claude", source: "built-in", pinned: true });
    expect(claude).toHaveProperty("toolbarVisible");
    expect(claude).not.toHaveProperty("availability");
    expect(claude).not.toHaveProperty("installed");
    expect(claude).not.toHaveProperty("launchable");
  });

  it("registers as a narrow read with a structured MCP result", () => {
    const actions = setupActions(makeCallbacks());
    const def = actions.get("agent.listAvailable")?.() as AnyActionDefinition;
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.scope).toBe("renderer");
    // Was `discoverable` — see the tier tests for where it is actually reachable
    // (every in-app tier plus `external`, which needs it to resolve launchable
    // agent ids for `agent.launch`).
    expect(def.mcpVisibility).toBeUndefined();
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

  describe("discovery-read deadline (#11795)", () => {
    // Belt and braces with the per-test `finally`: if the deadline regresses,
    // `advanceTimersToNextTimerAsync` no-ops, the awaited assertion never
    // settles, and vitest kills the test externally — which unwinds nothing, so
    // the local `finally` never runs and fake timers would leak into the rest
    // of the file.
    afterEach(() => {
      vi.useRealTimers();
      clientsMock.agentCapabilitiesClient.getRegistry.mockReset();
    });

    /**
     * Prime the dynamic `import()`s inside `readAgentDiscoveryState` under real
     * timers. They are mocked, but vitest registers mocks lazily and the first
     * import still traverses the module runner, which can stall under fake
     * timers — the hazard `fakeTimersImportOrder.contract.test.ts` exists for.
     * Importing the modules directly rather than running the whole action keeps
     * the warm-up from arming a real 25s timer.
     */
    async function primeDiscoveryImports(): Promise<void> {
      await Promise.all([
        import("@/store/agentSettingsStore"),
        import("@/store/cliAvailabilityStore"),
      ]);
    }

    it("settles instead of hanging when a discovery read never resolves", async () => {
      await primeDiscoveryImports();
      setStores({ agents: {} }, { claude: "ready" });
      clientsMock.userAgentRegistryClient.get.mockResolvedValue({});
      // Exactly the shape that shipped broken: an IPC leg that never settles
      // rather than rejecting. Main abandons the dispatch at 30s without
      // cancelling the renderer, so this promise stayed pending indefinitely
      // and held its focus-suppression lease with it.
      clientsMock.agentCapabilitiesClient.getRegistry.mockReturnValue(new Promise(() => {}));
      const actions = setupActions(makeCallbacks());

      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const pending = callAction(actions, "agent.listAvailable");
        // Assert before advancing: attaching the handler afterwards races the
        // rejection and trips vitest's unhandled-rejection guard.
        const rejects = expect(pending).rejects.toThrow(/still waiting on: agentRegistry$/);
        // The deadline must be the only timer in flight, so advancing to "next"
        // provably lands on it rather than on something scheduled nearby.
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersToNextTimerAsync();
        await rejects;

        // The bound is only correct relative to two constants in other files;
        // pinning the elapsed window catches drift in either direction that a
        // bare "it rejected" assertion would sail past. Lower bound: the real
        // cold-read ceiling, refreshPath's 10s (electron/setup/environment.ts
        // REFRESH_TIMEOUT_MS) plus CliAvailabilityService's 10s CHECK_TIMEOUT_MS,
        // below which a slow cold start fails spuriously. Upper bound:
        // MCP_DISPATCH_TIMEOUT_MS (electron/services/mcp-server/shared.ts), past
        // which main has already abandoned the dispatch and the bound is moot.
        const elapsed = Date.now() - startedAt;
        expect(elapsed).toBeGreaterThan(20_000);
        expect(elapsed).toBeLessThan(30_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("disarms the deadline once the reads succeed", async () => {
      await primeDiscoveryImports();
      setStores({ agents: {} }, { claude: "ready" });
      clientsMock.agentCapabilitiesClient.getRegistry.mockResolvedValue({
        claude: { name: "Claude" },
      });
      clientsMock.userAgentRegistryClient.get.mockResolvedValue({});
      const actions = setupActions(makeCallbacks());

      vi.useFakeTimers();
      try {
        await callAction(actions, "agent.listAvailable");

        // A deadline that resolves the action but leaves its timer armed would
        // keep the renderer awake for 25s after every call.
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
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
      AnyActionDefinition | undefined;
    if (!def) throw new Error("agentSessionHistory.list not registered");
    return def;
  }

  it("forwards the worktreeId arg to the bridge and wraps the result in { sessions }", async () => {
    const actions = setupActions(makeCallbacks());
    const result = await callAction(actions, "agentSessionHistory.list", { worktreeId: "wt-1" });
    expect(listMock).toHaveBeenCalledWith("wt-1", undefined);
    expect(result).toEqual({ sessions: SAMPLE_SESSIONS, total: 2, hasMore: false });
  });

  // #11530 — the action used to fall open to every worktree of every project
  // when no scope was given. Scope is now resolved args-first, then context.
  it("scopes to an explicit projectId when no worktreeId is given", async () => {
    const actions = setupActions(makeCallbacks());
    await callAction(actions, "agentSessionHistory.list", { projectId: "proj-1" });
    expect(listMock).toHaveBeenCalledWith(undefined, "proj-1");
  });

  it("combines an explicit worktreeId and projectId rather than dropping one", async () => {
    const actions = setupActions(makeCallbacks());
    await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
      projectId: "proj-1",
    });
    expect(listMock).toHaveBeenCalledWith("wt-1", "proj-1");
  });

  it("falls back to the context's active worktree when no scope arg is given", async () => {
    const actions = setupActions(makeCallbacks());
    await callAction(actions, "agentSessionHistory.list", {}, { activeWorktreeId: "ctx-wt" });
    expect(listMock).toHaveBeenCalledWith("ctx-wt", undefined);
  });

  it("falls back to the context's project when there is no active worktree", async () => {
    const actions = setupActions(makeCallbacks());
    await callAction(actions, "agentSessionHistory.list", {}, { projectId: "ctx-proj" });
    expect(listMock).toHaveBeenCalledWith(undefined, "ctx-proj");
  });

  // A worktree id is a normalized absolute path, so the same worktree opened as
  // its own project journals records under a different projectId. Scoping by the
  // context's worktree alone would surface that other project's sessions.
  it("carries BOTH context ids so a shared worktree path can't leak another project", async () => {
    const actions = setupActions(makeCallbacks());
    await callAction(
      actions,
      "agentSessionHistory.list",
      {},
      { activeWorktreeId: "/repo/wt-feature", projectId: "ctx-proj" }
    );
    expect(listMock).toHaveBeenCalledWith("/repo/wt-feature", "ctx-proj");
  });

  it("uses an explicit worktreeId verbatim instead of narrowing it with context", async () => {
    const actions = setupActions(makeCallbacks());
    await callAction(
      actions,
      "agentSessionHistory.list",
      { worktreeId: "arg-wt" },
      { activeWorktreeId: "ctx-wt", projectId: "ctx-proj" }
    );
    expect(listMock).toHaveBeenCalledWith("arg-wt", undefined);
  });

  it("uses an explicit projectId verbatim even when the context has a worktree", async () => {
    const actions = setupActions(makeCallbacks());
    await callAction(
      actions,
      "agentSessionHistory.list",
      { projectId: "arg-proj" },
      { activeWorktreeId: "ctx-wt", projectId: "ctx-proj" }
    );
    expect(listMock).toHaveBeenCalledWith(undefined, "arg-proj");
  });

  it("throws without reading the journal when no scope can be resolved", async () => {
    const actions = setupActions(makeCallbacks());
    await expect(callAction(actions, "agentSessionHistory.list", {})).rejects.toThrow(/scope/i);
    // The point of the guard is not shipping the cross-project payload at all —
    // an empty return would still have paid for the read.
    expect(listMock).not.toHaveBeenCalled();
  });

  // A scratch view has no project and no git worktrees, so its context carries
  // only scratchId — yet its terminals ARE journaled, under that opaque id as
  // their ownership stamp. Without the fallback the scope guard above turns
  // every scratch into a dead end, and no agent-visible arg can escape it.
  it("scopes to the context's scratch id rather than dead-ending a scratch workspace", async () => {
    const actions = setupActions(makeCallbacks());
    const result = await callAction(
      actions,
      "agentSessionHistory.list",
      {},
      { scratchId: "scratch-7" }
    );
    expect(listMock).toHaveBeenCalledWith(undefined, "scratch-7");
    expect(result).toEqual({
      sessions: SAMPLE_SESSIONS,
      total: SAMPLE_SESSIONS.length,
      hasMore: false,
    });
  });

  it("prefers a resolved project over the scratch id when the context carries both", async () => {
    const actions = setupActions(makeCallbacks());
    await callAction(
      actions,
      "agentSessionHistory.list",
      {},
      { projectId: "ctx-proj", scratchId: "scratch-7" }
    );
    expect(listMock).toHaveBeenCalledWith(undefined, "ctx-proj");
  });

  it("returns an empty page for a scoped but empty journal (never throws)", async () => {
    listMock.mockResolvedValue([]);
    const actions = setupActions(makeCallbacks());
    const result = await callAction(actions, "agentSessionHistory.list", { worktreeId: "wt-1" });
    expect(result).toEqual({ sessions: [], total: 0, hasMore: false });
  });

  // #11539 — dispatch parses results against `resultSchema`, but the journal's
  // own `normalizeRecords` deliberately admits any object with a string
  // sessionId so a corrupt, hand-edited or newer-schema file degrades instead of
  // crashing reads. Without a filter here, one such row rejects the whole page.
  it("drops a record the advertised shape cannot carry instead of failing the page", async () => {
    listMock.mockResolvedValue([
      SAMPLE_SESSIONS[0],
      // Everything the schema requires beyond `sessionId` is missing.
      { sessionId: "sess-degraded" },
      SAMPLE_SESSIONS[1],
    ]);
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
    })) as { sessions: Array<{ sessionId: string }>; total: number; hasMore: boolean };

    expect(result.sessions.map((s) => s.sessionId)).toEqual(["sess-1", "sess-2"]);
    // `total` still counts what the journal holds, and `hasMore` is computed
    // before the drop — a dropped row must not read as "end of list" and strand
    // the records behind it.
    expect(result).toMatchObject({ total: 3, hasMore: false });
  });

  // Read the declared default off the schema rather than copying the constant,
  // so the assertion stays exact without pinning the product decision.
  function declaredDefaults(): { limit: number; offset: number } {
    const parsed = getDef().argsSchema?.parse({ worktreeId: "wt-1" }) as {
      limit: number;
      offset: number;
    };
    return parsed;
  }

  it("truncates to exactly the default limit and reports the untruncated total", async () => {
    const { limit: defaultLimit } = declaredDefaults();
    const many = Array.from({ length: defaultLimit + 2 }, (_, i) => ({
      ...SAMPLE_SESSIONS[0],
      sessionId: `sess-${i}`,
    }));
    listMock.mockResolvedValue(many);
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
    })) as { sessions: Array<{ sessionId: string }>; total: number; hasMore: boolean };
    // Exact prefix — a "return all but one" implementation would still grow
    // linearly with the journal and must not pass.
    expect(result.sessions.map((s) => s.sessionId)).toEqual(
      many.slice(0, defaultLimit).map((s) => s.sessionId)
    );
    expect(result.total).toBe(many.length);
    expect(result.hasMore).toBe(true);
  });

  it("reports hasMore false when the result exactly fills the limit", async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      ...SAMPLE_SESSIONS[0],
      sessionId: `sess-${i}`,
    }));
    listMock.mockResolvedValue(many);
    const actions = setupActions(makeCallbacks());
    const exact = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
      limit: many.length,
    })) as { sessions: unknown[]; total: number; hasMore: boolean };
    // `hasMore: total >= limit` would wrongly claim another page exists.
    expect(exact.sessions).toHaveLength(many.length);
    expect(exact.hasMore).toBe(false);

    // A limit past the end returns everything and still says there's no more.
    const over = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
      limit: many.length + 2,
    })) as { sessions: unknown[]; hasMore: boolean };
    expect(over.sessions).toHaveLength(many.length);
    expect(over.hasMore).toBe(false);
  });

  it("pages past the limit with offset so no record is unreachable", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...SAMPLE_SESSIONS[0],
      sessionId: `sess-${i}`,
    }));
    listMock.mockResolvedValue(many);
    const actions = setupActions(makeCallbacks());
    const page2 = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
      limit: 2,
      offset: 2,
    })) as { sessions: Array<{ sessionId: string }>; total: number; hasMore: boolean };
    expect(page2.sessions.map((s) => s.sessionId)).toEqual(["sess-2", "sess-3"]);
    expect(page2).toMatchObject({ total: 5, hasMore: true });

    // The final page reports no more even though it is shorter than the limit.
    const tail = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
      limit: 2,
      offset: 4,
    })) as { sessions: Array<{ sessionId: string }>; hasMore: boolean };
    expect(tail.sessions.map((s) => s.sessionId)).toEqual(["sess-4"]);
    expect(tail.hasMore).toBe(false);

    // An offset past the end is empty, not an error.
    const beyond = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
      offset: 99,
    })) as { sessions: unknown[]; total: number; hasMore: boolean };
    expect(beyond).toEqual({ sessions: [], total: 5, hasMore: false });
  });

  it("honours an explicit limit and keeps the newest records (bridge order)", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...SAMPLE_SESSIONS[0],
      sessionId: `sess-${i}`,
    }));
    listMock.mockResolvedValue(many);
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
      limit: 3,
    })) as { sessions: Array<{ sessionId: string }>; total: number; hasMore: boolean };
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["sess-0", "sess-1", "sess-2"]);
    expect(result).toMatchObject({ total: 10, hasMore: true });
  });

  it("strips pane-presentation bookmark fields while keeping the actionable ones", async () => {
    const bookmarked = {
      ...SAMPLE_SESSIONS[0],
      bookmark: {
        bookmarkedAt: 1_700_000_000_001,
        label: "Pinned auth work",
        // Distinct values throughout, and isInputLocked deliberately opposite
        // to isUsingFallback, so a mis-wired projection can't coincidentally match.
        sourceLocation: "dock",
        agentPresetId: "preset-resolved",
        originalPresetId: "preset-requested",
        isInputLocked: true,
        // Pane-presentation only — must not reach an agent (#11530).
        sourcePanelId: "panel-1",
        titleMode: "custom",
        agentPresetColor: "#ff0000",
        isUsingFallback: false,
        fallbackChainIndex: 2,
      },
    };
    listMock.mockResolvedValue([bookmarked]);
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
    })) as { sessions: Array<{ bookmark?: Record<string, unknown> }> };
    const bookmark = result.sessions[0]?.bookmark ?? {};
    // Whole-object equality, with every retained value distinct and the two
    // booleans opposite: a projection that swapped agentPresetId with
    // originalPresetId, hardcoded "grid", or sourced isInputLocked from
    // isUsingFallback would pass a key-set check but fails here.
    expect(bookmark).toEqual({
      bookmarkedAt: 1_700_000_000_001,
      label: "Pinned auth work",
      sourceLocation: "dock",
      agentPresetId: "preset-resolved",
      originalPresetId: "preset-requested",
      isInputLocked: true,
    });
    // The source record is shared with the cache in main — never mutate it.
    expect(bookmarked.bookmark.agentPresetColor).toBe("#ff0000");
  });

  it("keeps a minimal bookmark to just its required fields", async () => {
    listMock.mockResolvedValue([
      { ...SAMPLE_SESSIONS[0], bookmark: { bookmarkedAt: 7, label: "Bare" } },
    ]);
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
    })) as { sessions: Array<{ bookmark?: Record<string, unknown> }> };
    expect(result.sessions[0]?.bookmark).toEqual({ bookmarkedAt: 7, label: "Bare" });
  });

  it("survives a hand-edited record whose bookmark is null", async () => {
    // The journal is a plain JSON file and normalizeRecords admits any object
    // with a string sessionId, so `"bookmark": null` can reach the projection.
    // It must not take down the whole listing.
    listMock.mockResolvedValue([{ ...SAMPLE_SESSIONS[0], bookmark: null }]);
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
    })) as { sessions: Array<Record<string, unknown>> };
    expect(result.sessions).toHaveLength(1);
    expect(Object.hasOwn(result.sessions[0] ?? {}, "bookmark")).toBe(false);
  });

  it("omits absent optional fields rather than emitting explicit undefined", async () => {
    listMock.mockResolvedValue([SAMPLE_SESSIONS[1]]);
    const actions = setupActions(makeCallbacks());
    const result = (await callAction(actions, "agentSessionHistory.list", {
      worktreeId: "wt-1",
    })) as { sessions: Array<Record<string, unknown>> };
    expect(Object.keys(result.sessions[0] ?? {}).sort()).toEqual([
      "agentId",
      "projectId",
      "savedAt",
      "sessionId",
      "title",
      "worktreeId",
    ]);
  });

  it("registers as a read-only query action advertising an MCP output schema", () => {
    const def = getDef();
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.scope).toBe("renderer");
    expect(def.mcpOutputSchema).toBe(true);
  });

  it("resultSchema accepts both a full record and a null/absent-optional record", () => {
    const parsed = getDef().resultSchema?.safeParse({
      sessions: SAMPLE_SESSIONS,
      total: SAMPLE_SESSIONS.length,
      hasMore: false,
    });
    expect(parsed?.success).toBe(true);
  });

  it("resultSchema rejects a session missing the required sessionId", () => {
    const parsed = getDef().resultSchema?.safeParse({
      sessions: [{ agentId: "claude", worktreeId: null, title: null, projectId: null, savedAt: 1 }],
      total: 1,
      hasMore: false,
    });
    expect(parsed?.success).toBe(false);
  });

  it("resultSchema requires BOTH truncation metadata fields", () => {
    // Advertised as the MCP outputSchema, so an agent reads it to learn whether
    // a listing can be partial. Each field is checked on its own — asserting
    // only `{ sessions: [] }` would pass if just one of them were dropped.
    const schema = getDef().resultSchema;
    expect(schema?.safeParse({ sessions: [], total: 0, hasMore: false }).success).toBe(true);
    expect(schema?.safeParse({ sessions: [], hasMore: false }).success).toBe(false);
    expect(schema?.safeParse({ sessions: [], total: 0 }).success).toBe(false);
  });

  it("resultSchema advertises the lean bookmark, not the stored one", () => {
    // The schema doesn't enforce the projection (nothing parses the real
    // return), but it IS the documentation an agent plans against — it must not
    // promise fields run() strips.
    const withStripped = getDef().resultSchema?.safeParse({
      sessions: [
        {
          ...SAMPLE_SESSIONS[0],
          bookmark: { bookmarkedAt: 1, label: "L", agentPresetColor: "#fff" },
        },
      ],
      total: 1,
      hasMore: false,
    }) as { success: boolean; data?: { sessions: Array<{ bookmark?: Record<string, unknown> }> } };
    // zod strips unknown keys, so a stripped field must not survive parsing.
    expect(withStripped.success).toBe(true);
    expect(withStripped.data?.sessions[0]?.bookmark).toEqual({ bookmarkedAt: 1, label: "L" });
  });

  it("argsSchema accepts an omitted scope and either scope arg", () => {
    const schema = getDef().argsSchema;
    // `{}` still parses — the scope requirement is enforced in run(), where the
    // dispatch context (which the schema cannot see) gets its chance to supply one.
    expect(schema?.safeParse(undefined).success).toBe(true);
    expect(schema?.safeParse({}).success).toBe(true);
    expect(schema?.safeParse({ worktreeId: "wt-1" }).success).toBe(true);
    expect(schema?.safeParse({ projectId: "proj-1" }).success).toBe(true);
  });

  it("argsSchema rejects an empty scope id (would silently unfilter the listing)", () => {
    expect(getDef().argsSchema?.safeParse({ worktreeId: "" }).success).toBe(false);
    expect(getDef().argsSchema?.safeParse({ projectId: "" }).success).toBe(false);
  });

  it("argsSchema bounds limit to a positive integer under a ceiling", () => {
    const schema = getDef().argsSchema;
    expect(schema?.safeParse({ worktreeId: "wt-1", limit: 1 }).success).toBe(true);
    expect(schema?.safeParse({ worktreeId: "wt-1", limit: 0 }).success).toBe(false);
    expect(schema?.safeParse({ worktreeId: "wt-1", limit: -5 }).success).toBe(false);
    expect(schema?.safeParse({ worktreeId: "wt-1", limit: 2.5 }).success).toBe(false);
    expect(schema?.safeParse({ worktreeId: "wt-1", limit: 100_000 }).success).toBe(false);
  });
});

describe("agent.listPresets", () => {
  const SECRET = "sk-live-do-not-leak";

  /**
   * Narrow the dispatch result without a type assertion, and deliberately
   * loosely: a row that smuggled an extra field has to survive parsing so the
   * key allowlist below can see it. A strict schema would strip the leak and
   * make the very test that hunts for it pass.
   */
  const PRESET_ROW_KEYS = new Set(["id", "name", "source", "description"]);

  const PresetsResultShape = z.object({
    presetsComplete: z.boolean(),
    presets: z.array(z.looseObject({ id: z.string(), name: z.string(), source: z.string() })),
  });

  beforeEach(() => {
    clientsMock.agentSettingsClient.get.mockResolvedValue({ agents: {} });
    setSources({});
  });

  function setSources(options: {
    settings?: { agents?: Record<string, unknown> } | null;
    ccrPresetsByAgent?: Record<string, unknown[]>;
    ccrInitialized?: boolean;
    presetsByAgent?: Record<string, unknown[]>;
    hydratedProjectId?: string | null;
  }): void {
    agentSettingsStoreMock.useAgentSettingsStore.getState.mockReturnValue({
      settings: options.settings === undefined ? { agents: {} } : options.settings,
    });
    ccrPresetsStoreMock.useCcrPresetsStore.getState.mockReturnValue({
      ccrPresetsByAgent: options.ccrPresetsByAgent ?? {},
      isInitialized: options.ccrInitialized ?? true,
    });
    projectPresetsStoreMock.useProjectPresetsStore.getState.mockReturnValue({
      presetsByAgent: options.presetsByAgent ?? {},
      hydratedProjectId: options.hydratedProjectId ?? null,
    });
  }

  // Defaults to a scratch scope: a view that has resolved its workspace and
  // genuinely has no project. Tests that mean "the view resolved nothing" pass
  // an explicit empty context instead.
  async function listPresets(
    args: Record<string, unknown> = { agentId: "claude" },
    ctx: Partial<ActionContext> = { scratchId: "scratch-1" }
  ) {
    const actions = setupActions(makeCallbacks());
    return PresetsResultShape.parse(await callAction(actions, "agent.listPresets", args, ctx));
  }

  it("registers as a narrow read with a structured MCP result", () => {
    const def = getDefinition(setupActions(makeCallbacks()), "agent.listPresets");
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.scope).toBe("renderer");
    expect(def.mcpVisibility).toBeUndefined();
    expect(def.mcpOutputSchema).toBe(true);
  });

  it("returns rows the declared result schema accepts", async () => {
    setSources({
      settings: { agents: { claude: { customPresets: [{ id: "zai", name: "Z.AI" }] } } },
    });
    const actions = setupActions(makeCallbacks());
    const result = await callAction(
      actions,
      "agent.listPresets",
      { agentId: "claude" },
      { scratchId: "scratch-1" }
    );

    // `resultSchema` is parsed at dispatch, so a run() that drifts from it
    // fails as a validation error rather than shipping the extra field.
    expect(parseAgainstSchema(actions, "agent.listPresets", result).success).toBe(true);
    expect(result).toEqual({
      presetsComplete: true,
      presets: [{ id: "zai", name: "Z.AI", source: "custom" }],
    });
  });

  it("never leaks a preset's launch payload", async () => {
    setSources({
      settings: {
        agents: {
          claude: {
            customPresets: [
              {
                id: "zai",
                name: "Z.AI",
                description: "Routes through Z.AI",
                env: { ANTHROPIC_API_KEY: SECRET },
                args: ["--secret-flag"],
                customFlags: "--dangerous",
                dangerousMode: "on",
              },
            ],
          },
        },
      },
    });

    const result = await listPresets();

    expect(Object.keys(result.presets[0]!).sort()).toEqual(
      ["description", "id", "name", "source"].sort()
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("--secret-flag");
    expect(serialized).not.toContain("dangerous");
  });

  it("merges the three layers in launch precedence and tags each one", async () => {
    setSources({
      settings: { agents: { claude: { customPresets: [{ id: "shared", name: "Custom" }] } } },
      ccrPresetsByAgent: { claude: [{ id: "ccr-route", name: "CCR route" }] },
      presetsByAgent: {
        claude: [
          { id: "shared", name: "Project" },
          { id: "team", name: "Team" },
        ],
      },
      hydratedProjectId: "proj-1",
    });

    expect(await listPresets({ agentId: "claude" }, { projectId: "proj-1" })).toEqual({
      presetsComplete: true,
      presets: [
        { id: "shared", name: "Custom", source: "custom" },
        { id: "team", name: "Team", source: "project" },
        { id: "ccr-route", name: "CCR route", source: "ccr" },
      ],
    });
  });

  it("prefers an explicit project over the dispatch context", async () => {
    setSources({
      presetsByAgent: { claude: [{ id: "team", name: "Team" }] },
      hydratedProjectId: "proj-explicit",
    });

    expect(
      await listPresets(
        { agentId: "claude", projectId: "proj-explicit" },
        { projectId: "proj-ambient" }
      )
    ).toEqual({
      presetsComplete: true,
      presets: [{ id: "team", name: "Team", source: "project" }],
    });

    // The ambient project would have been the wrong scope for this snapshot.
    expect(await listPresets({ agentId: "claude" }, { projectId: "proj-ambient" })).toEqual({
      presetsComplete: false,
      presets: [],
    });
  });

  it("withholds another project's presets rather than answering for the wrong one", async () => {
    setSources({
      presetsByAgent: { claude: [{ id: "team", name: "Team" }] },
      hydratedProjectId: "proj-1",
    });

    expect(await listPresets({ agentId: "claude" }, { projectId: "proj-2" })).toEqual({
      presetsComplete: false,
      presets: [],
    });
  });

  it("reports completeness per unproven source", async () => {
    // A project in scope whose snapshot has not landed.
    setSources({ hydratedProjectId: null });
    expect(
      (await listPresets({ agentId: "claude" }, { projectId: "proj-1" })).presetsComplete
    ).toBe(false);

    // CCR discovery still in flight.
    setSources({ ccrInitialized: false });
    expect((await listPresets()).presetsComplete).toBe(false);

    // No project in scope: there are no repository presets to be missing.
    setSources({});
    expect((await listPresets()).presetsComplete).toBe(true);
  });

  it("names client-fallback presets without certifying them", async () => {
    setSources({ settings: null });
    clientsMock.agentSettingsClient.get.mockResolvedValue({
      agents: { claude: { customPresets: [{ id: "zai", name: "Z.AI" }] } },
    });

    // The launcher resolves a preset id against the settings store, not this
    // client. Naming the preset early is useful; certifying it would promise an
    // id a launch in this same window would not find.
    expect(await listPresets()).toEqual({
      presetsComplete: false,
      presets: [{ id: "zai", name: "Z.AI", source: "custom" }],
    });
    expect(clientsMock.agentSettingsClient.get).toHaveBeenCalled();
  });

  it("reports an unreadable settings layer as incomplete", async () => {
    setSources({ settings: null });
    clientsMock.agentSettingsClient.get.mockResolvedValue(null);

    expect((await listPresets()).presetsComplete).toBe(false);
  });

  it("degrades to the proven layers when the settings client rejects", async () => {
    setSources({
      settings: null,
      ccrPresetsByAgent: { claude: [{ id: "ccr-route", name: "CCR route" }] },
    });
    clientsMock.agentSettingsClient.get.mockRejectedValue(new Error("ipc down"));

    // A read-only query that already carries a completeness flag has a better
    // answer than failing outright: report what is proven and say so.
    expect(await listPresets()).toEqual({
      presetsComplete: false,
      presets: [{ id: "ccr-route", name: "CCR route", source: "ccr" }],
    });
  });

  it("keeps built-in presets when the CCR store holds no key for the agent", async () => {
    // An absent key is not an empty bucket: `[]` would replace the built-in
    // presets, so the action must pass absence through as absence.
    setSources({ ccrPresetsByAgent: {} });

    const result = await listPresets({ agentId: "mistral" });

    expect(result.presets.length).toBeGreaterThan(0);
    expect(result.presets.every((row) => row.source === "registry")).toBe(true);
    // Asserted against the key allowlist rather than a sentinel from the
    // registry fixture, so editing that agent's presets cannot quietly retire
    // the leak check.
    for (const row of result.presets) {
      expect(Object.keys(row).every((key) => PRESET_ROW_KEYS.has(key))).toBe(true);
    }
  });

  it("passes an own empty CCR bucket through as a replacement", async () => {
    // The mirror of the case above: an own `[]` is real data meaning "CCR
    // discovery cleared this agent", and it must still displace the built-ins.
    setSources({ ccrPresetsByAgent: { mistral: [] } });

    expect(await listPresets({ agentId: "mistral" })).toEqual({
      presetsComplete: true,
      presets: [],
    });
  });

  it("does not treat an inherited key as a preset bucket", async () => {
    setSources({});

    // `agentId` is unconstrained, so `__proto__` would otherwise resolve to
    // `Object.prototype` and throw on the first array operation.
    for (const agentId of ["__proto__", "constructor", "toString", "valueOf"]) {
      expect(await listPresets({ agentId })).toEqual({ presetsComplete: true, presets: [] });
    }
  });

  it("reads a corrupted bucket as absent, the same way a launch would", async () => {
    setSources({
      ccrPresetsByAgent: { claude: "not-an-array" as unknown as unknown[] },
      presetsByAgent: { claude: 7 as unknown as unknown[] },
      hydratedProjectId: "proj-1",
    });

    // Certifying this is honest only because the launch-facing merge now reads
    // a malformed bucket as absent too — the listing and the launcher agree.
    expect(await listPresets({ agentId: "claude" }, { projectId: "proj-1" })).toEqual({
      presetsComplete: true,
      presets: [],
    });
  });

  it("still returns the proven layers while another source is incomplete", async () => {
    // Guards the lazy implementation that empties the list whenever the flag is
    // false — the flag qualifies the list, it does not replace it.
    setSources({
      settings: { agents: { claude: { customPresets: [{ id: "zai", name: "Z.AI" }] } } },
      ccrInitialized: false,
    });

    expect(await listPresets()).toEqual({
      presetsComplete: false,
      presets: [{ id: "zai", name: "Z.AI", source: "custom" }],
    });

    setSources({
      settings: { agents: { claude: { customPresets: [{ id: "zai", name: "Z.AI" }] } } },
      presetsByAgent: { claude: [{ id: "team", name: "Team" }] },
      hydratedProjectId: "other-project",
    });

    expect(await listPresets({ agentId: "claude" }, { projectId: "proj-1" })).toEqual({
      presetsComplete: false,
      presets: [{ id: "zai", name: "Z.AI", source: "custom" }],
    });
  });

  it("treats an owned but empty project snapshot as complete", async () => {
    setSources({ presetsByAgent: {}, hydratedProjectId: "proj-1" });

    expect(
      (await listPresets({ agentId: "claude" }, { projectId: "proj-1" })).presetsComplete
    ).toBe(true);
  });

  it("does not certify a view that has resolved no workspace at all", async () => {
    setSources({});

    // A scratch is a real "no repository presets" answer; no pointer at all is
    // an unresolved view, where an absent project layer is a gap.
    expect(
      (await listPresets({ agentId: "claude" }, { scratchId: "scratch-1" })).presetsComplete
    ).toBe(true);
    expect((await listPresets({ agentId: "claude" }, {})).presetsComplete).toBe(false);
  });

  it("advertises an item shape that cannot carry launch payload", async () => {
    const def = getDefinition(setupActions(makeCallbacks()), "agent.listPresets");
    const withPayload = {
      presetsComplete: true,
      presets: [{ id: "zai", name: "Z.AI", source: "custom", env: { KEY: "secret" } }],
    };

    // The schema is parsed at dispatch and strips what it does not declare, so
    // this proves the advertised contract itself has no room for a payload.
    const parsed = def.resultSchema!.parse(withPayload);
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });
});
