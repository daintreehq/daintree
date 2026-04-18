import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDefinition } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

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
}));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/createWorktreeStore", () => currentViewStoreMock);
vi.mock("@/store/worktreeStore", () => worktreeSelectionMock);
vi.mock("@/config/agents", () => agentRegistryMock);

import { registerAgentActions } from "../agentActions";

function makeCallbacks() {
  return {
    onLaunchAgent: vi.fn().mockResolvedValue("term-1"),
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
  const def = factory() as ActionDefinition<unknown, unknown>;
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
    expect(result).toEqual({ terminalId: "term-1" });
  });

  it("one agent.<id> action is registered per AGENT_REGISTRY entry", () => {
    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);

    expect(actions.has("agent.claude")).toBe(true);
    expect(actions.has("agent.codex")).toBe(true);
    expect(actions.has("agent.terminal")).toBe(true);
  });

  it("each generated agent.<id> launches its own agent id (no closure capture bug)", async () => {
    const callbacks = makeCallbacks();
    const actions = setupActions(callbacks);

    await callAction(actions, "agent.claude");
    await callAction(actions, "agent.codex");
    await callAction(actions, "agent.terminal");

    expect(callbacks.onLaunchAgent).toHaveBeenNthCalledWith(1, "claude");
    expect(callbacks.onLaunchAgent).toHaveBeenNthCalledWith(2, "codex");
    expect(callbacks.onLaunchAgent).toHaveBeenNthCalledWith(3, "terminal");
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

  it("onLaunchAgent rejection propagates out of generated agent.<id>", async () => {
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockRejectedValueOnce(new Error("generator boom"));
    const actions = setupActions(callbacks);

    await expect(callAction(actions, "agent.claude")).rejects.toThrow("generator boom");
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
      expect(result.result).toEqual({ terminalId: "term-1" });
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

  it("rejects malformed args with a VALIDATION_ERROR targeting agentId and never invokes the callback", async () => {
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
      { agentId: "not-a-real-agent" },
      { source: "user" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(result.error.details)).toContain("agentId");
    }
    expect(callbacks.onLaunchAgent).not.toHaveBeenCalled();
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
});
