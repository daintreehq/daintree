import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalInstanceServiceMock = vi.hoisted(() => ({
  resetRenderer: vi.fn(),
}));
const pendingDestructiveStoreMock = vi.hoisted(() => {
  let pending: unknown = null;
  return {
    state: {
      get pending() {
        return pending;
      },
      request: vi.fn((snap: unknown) => {
        pending = snap;
      }),
      clear: vi.fn(() => {
        pending = null;
      }),
    },
    reset: () => {
      pending = null;
    },
  };
});

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: terminalInstanceServiceMock,
}));
vi.mock("@/store/terminalPendingDestructiveActionStore", () => ({
  useTerminalPendingDestructiveActionStore: { getState: () => pendingDestructiveStoreMock.state },
}));

import { registerWorktreeSessionActions } from "../worktreeSessionActions";

type Panel = {
  id: string;
  location: "grid" | "dock" | "trash";
  worktreeId?: string;
  detectedAgentId?: string;
  agentState?: string;
};

function setPanelState(panels: Panel[]) {
  const panelsById: Record<string, Panel> = {};
  for (const p of panels) panelsById[p.id] = p;
  const bulkTrashByWorktree = vi.fn();
  const bulkRestartByWorktree = vi.fn().mockResolvedValue(undefined);
  panelStoreMock.getState.mockImplementation(() => ({
    panelIds: panels.map((p) => p.id),
    panelsById,
    bulkTrashByWorktree,
    bulkRestartByWorktree,
  }));
  return { bulkTrashByWorktree, bulkRestartByWorktree };
}

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks = {} as unknown as ActionCallbacks;
  registerWorktreeSessionActions(actions, callbacks);
  return (id: string, args?: unknown, ctx?: Partial<ActionContext>) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, (ctx ?? {}) as ActionContext);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingDestructiveStoreMock.reset();
});

describe("worktree.sessions.trashAll confirm gate", () => {
  it("does not trash without confirmed:true — even when no agent is running (palette/keybinding bypass guard)", async () => {
    const { bulkTrashByWorktree } = setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
      { id: "p2", location: "grid", worktreeId: "wt-1" },
    ]);
    const run = setupActions();

    await run("worktree.sessions.trashAll", { worktreeId: "wt-1" });

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "worktreeTrashAll",
      targetCount: 2,
      runningAgentCount: 0,
      worktreeId: "wt-1",
    });
  });

  it("trashes when confirmed:true is passed", async () => {
    const { bulkTrashByWorktree } = setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
    ]);
    const run = setupActions();

    await run("worktree.sessions.trashAll", { worktreeId: "wt-1", confirmed: true });

    expect(bulkTrashByWorktree).toHaveBeenCalledWith("wt-1");
  });

  it("is a no-op when the target worktree has no non-trash sessions", async () => {
    const { bulkTrashByWorktree } = setPanelState([
      { id: "p1", location: "trash", worktreeId: "wt-1" },
    ]);
    const run = setupActions();

    await run("worktree.sessions.trashAll", { worktreeId: "wt-1", confirmed: true });

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });
});

describe("worktree.sessions.restartAll confirm gate", () => {
  it("accepts undefined args (keybinding dispatch path) without throwing a validation error", async () => {
    const { bulkRestartByWorktree } = setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
    ]);
    const run = setupActions();

    await run("worktree.sessions.restartAll", undefined, { activeWorktreeId: "wt-1" });

    expect(bulkRestartByWorktree).toHaveBeenCalledWith("wt-1");
  });

  it("restarts immediately when the worktree has no running agent sessions", async () => {
    const { bulkRestartByWorktree } = setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
      {
        id: "p2",
        location: "grid",
        worktreeId: "wt-1",
        detectedAgentId: "claude",
        agentState: "idle",
      },
    ]);
    const run = setupActions();

    await run("worktree.sessions.restartAll", { worktreeId: "wt-1" });

    expect(bulkRestartByWorktree).toHaveBeenCalledWith("wt-1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("requests confirmation when an agent is mid-work in the target worktree", async () => {
    const { bulkRestartByWorktree } = setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
      {
        id: "p2",
        location: "grid",
        worktreeId: "wt-1",
        detectedAgentId: "claude",
        agentState: "working",
      },
    ]);
    const run = setupActions();

    await run("worktree.sessions.restartAll", { worktreeId: "wt-1" });

    expect(bulkRestartByWorktree).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "worktreeRestartAll",
      targetCount: 2,
      runningAgentCount: 1,
      worktreeId: "wt-1",
    });
  });

  it("restarts when confirmed:true is passed even with running agents", async () => {
    const { bulkRestartByWorktree } = setPanelState([
      {
        id: "p1",
        location: "grid",
        worktreeId: "wt-1",
        detectedAgentId: "claude",
        agentState: "working",
      },
    ]);
    const run = setupActions();

    await run("worktree.sessions.restartAll", { worktreeId: "wt-1", confirmed: true });

    expect(bulkRestartByWorktree).toHaveBeenCalledWith("wt-1");
  });

  it("is a no-op when no targetWorktreeId can be resolved", async () => {
    const { bulkRestartByWorktree } = setPanelState([]);
    const run = setupActions();

    await run("worktree.sessions.restartAll");

    expect(bulkRestartByWorktree).not.toHaveBeenCalled();
  });
});
