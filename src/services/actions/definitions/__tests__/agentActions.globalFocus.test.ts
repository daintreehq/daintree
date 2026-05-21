import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({
  getState: vi.fn(),
}));

const currentViewStoreMock = vi.hoisted(() => ({
  getCurrentViewStore: vi.fn(() => ({
    getState: () => ({ worktrees: new Map() }),
  })),
}));

const worktreeSelectionMock = vi.hoisted(() => ({
  useWorktreeSelectionStore: {
    getState: vi.fn(() => ({ activeWorktreeId: null })),
  },
}));

const agentRegistryMock = vi.hoisted(() => ({
  AGENT_REGISTRY: {
    claude: { name: "Claude" },
  },
}));

const projectStoreMock = vi.hoisted(() => ({
  getState: vi.fn(),
}));

const projectStatsStoreMock = vi.hoisted(() => ({
  getState: vi.fn(),
}));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/createWorktreeStore", () => currentViewStoreMock);
vi.mock("@/store/worktreeStore", () => worktreeSelectionMock);
vi.mock("@/config/agents", () => agentRegistryMock);
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));
vi.mock("@/store/projectStatsStore", () => ({ useProjectStatsStore: projectStatsStoreMock }));

import { registerAgentActions } from "../agentActions";

function makeCallbacks() {
  return {
    onLaunchAgent: vi.fn(),
    onOpenQuickSwitcher: vi.fn(),
  } as unknown as ActionCallbacks;
}

function setupActions(): ActionRegistry {
  const actions: ActionRegistry = new Map();
  registerAgentActions(actions, makeCallbacks());
  return actions;
}

function callAction(actions: ActionRegistry, id: string): Promise<unknown> {
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  const def = factory() as AnyActionDefinition;
  return def.run(undefined, {} as never);
}

interface ProjectState {
  projects: Array<{ id: string; name: string; path: string }>;
  currentProject: { id: string } | null;
  switchProject: ReturnType<typeof vi.fn>;
}

function setProjectState(
  projects: Array<{ id: string }>,
  currentProjectId: string | null
): ProjectState {
  const state: ProjectState = {
    projects: projects.map((p) => ({ id: p.id, name: p.id, path: `/p/${p.id}` })),
    currentProject: currentProjectId ? { id: currentProjectId } : null,
    switchProject: vi.fn().mockResolvedValue(undefined),
  };
  projectStoreMock.getState.mockReturnValue(state);
  return state;
}

function setStats(stats: Record<string, { waitingAgentCount: number }>): void {
  projectStatsStoreMock.getState.mockReturnValue({ stats });
}

beforeEach(() => {
  vi.clearAllMocks();
  panelStoreMock.getState.mockReturnValue({
    focusNextWaiting: vi.fn(),
    isInTrash: false,
  });
});

describe("agent.focusNextWaitingGlobal", () => {
  it("is no-op when no projects have waiting agents", async () => {
    const state = setProjectState([{ id: "a" }, { id: "b" }], "a");
    setStats({ a: { waitingAgentCount: 0 }, b: { waitingAgentCount: 0 } });

    const focusNextWaiting = vi.fn();
    panelStoreMock.getState.mockReturnValue({ focusNextWaiting, isInTrash: false });

    const actions = setupActions();
    await callAction(actions, "agent.focusNextWaitingGlobal");

    expect(state.switchProject).not.toHaveBeenCalled();
    expect(focusNextWaiting).not.toHaveBeenCalled();
  });

  it("dispatches local focusNextWaiting when only the current project has waiting agents", async () => {
    const state = setProjectState([{ id: "a" }, { id: "b" }, { id: "c" }], "b");
    setStats({
      a: { waitingAgentCount: 0 },
      b: { waitingAgentCount: 2 },
      c: { waitingAgentCount: 0 },
    });

    const focusNextWaiting = vi.fn();
    panelStoreMock.getState.mockReturnValue({ focusNextWaiting, isInTrash: false });

    const actions = setupActions();
    await callAction(actions, "agent.focusNextWaitingGlobal");

    expect(state.switchProject).not.toHaveBeenCalled();
    expect(focusNextWaiting).toHaveBeenCalledTimes(1);
  });

  it("switches to the next project with waiting agents and threads the focus intent", async () => {
    const state = setProjectState([{ id: "a" }, { id: "b" }, { id: "c" }], "a");
    setStats({
      a: { waitingAgentCount: 0 },
      b: { waitingAgentCount: 0 },
      c: { waitingAgentCount: 1 },
    });

    const focusNextWaiting = vi.fn();
    panelStoreMock.getState.mockReturnValue({ focusNextWaiting, isInTrash: false });

    const actions = setupActions();
    await callAction(actions, "agent.focusNextWaitingGlobal");

    expect(state.switchProject).toHaveBeenCalledTimes(1);
    expect(state.switchProject).toHaveBeenCalledWith("c", {
      focusIntent: "focus-next-waiting",
    });
    expect(focusNextWaiting).not.toHaveBeenCalled();
  });

  it("starts searching from AFTER the current project (skips currentProject in the cycle)", async () => {
    const state = setProjectState([{ id: "a" }, { id: "b" }, { id: "c" }], "b");
    setStats({
      a: { waitingAgentCount: 1 },
      b: { waitingAgentCount: 1 },
      c: { waitingAgentCount: 1 },
    });

    const focusNextWaiting = vi.fn();
    panelStoreMock.getState.mockReturnValue({ focusNextWaiting, isInTrash: false });

    const actions = setupActions();
    await callAction(actions, "agent.focusNextWaitingGlobal");

    // Search starts after "b" → first hit is "c", not "a" or "b".
    expect(state.switchProject).toHaveBeenCalledTimes(1);
    expect(state.switchProject).toHaveBeenCalledWith("c", {
      focusIntent: "focus-next-waiting",
    });
    // Must not also dispatch the local action — cross-project path skips it.
    expect(focusNextWaiting).not.toHaveBeenCalled();
  });

  it("wraps around to the head when current project is the last entry", async () => {
    const state = setProjectState([{ id: "a" }, { id: "b" }, { id: "c" }], "c");
    setStats({
      a: { waitingAgentCount: 1 },
      b: { waitingAgentCount: 0 },
      c: { waitingAgentCount: 0 },
    });

    const actions = setupActions();
    await callAction(actions, "agent.focusNextWaitingGlobal");

    expect(state.switchProject).toHaveBeenCalledWith("a", {
      focusIntent: "focus-next-waiting",
    });
  });

  it("treats a missing stats entry as zero waiting agents", async () => {
    const state = setProjectState([{ id: "a" }, { id: "b" }], "a");
    // No stats entry for "b" — should be treated as 0 and skipped (no-op since
    // only project is "a" which is current with 0 waiting).
    setStats({ a: { waitingAgentCount: 0 } });

    const focusNextWaiting = vi.fn();
    panelStoreMock.getState.mockReturnValue({ focusNextWaiting, isInTrash: false });

    const actions = setupActions();
    await callAction(actions, "agent.focusNextWaitingGlobal");

    expect(state.switchProject).not.toHaveBeenCalled();
    expect(focusNextWaiting).not.toHaveBeenCalled();
  });

  it("is no-op when there are no projects at all", async () => {
    const state = setProjectState([], null);
    setStats({});

    const actions = setupActions();
    await callAction(actions, "agent.focusNextWaitingGlobal");

    expect(state.switchProject).not.toHaveBeenCalled();
  });

  it("picks a waiting project when currentProject is not in the projects list", async () => {
    // Edge case: currentProject set to an id not in projects (stale state).
    const state = setProjectState([{ id: "a" }, { id: "b" }], "ghost");
    setStats({
      a: { waitingAgentCount: 0 },
      b: { waitingAgentCount: 3 },
    });

    const actions = setupActions();
    await callAction(actions, "agent.focusNextWaitingGlobal");

    // Falls through to head-of-list search; "b" is the first project with
    // waiting agents.
    expect(state.switchProject).toHaveBeenCalledWith("b", {
      focusIntent: "focus-next-waiting",
    });
  });
});
