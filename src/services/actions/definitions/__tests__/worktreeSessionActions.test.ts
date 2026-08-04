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
  location: "grid" | "dock" | "trash" | "overlay" | "background" | "dialog";
  worktreeId?: string;
  kind?: string;
  detectedAgentId?: string;
  agentState?: string;
};

function setPanelState(panels: Panel[]) {
  const panelsById: Record<string, Panel> = {};
  for (const p of panels) panelsById[p.id] = p;
  const bulkTrashByWorktree = vi.fn();
  const bulkRestartByWorktree = vi.fn().mockResolvedValue(undefined);
  const bulkCloseByWorktree = vi.fn();
  panelStoreMock.getState.mockImplementation(() => ({
    panelIds: panels.map((p) => p.id),
    panelsById,
    bulkTrashByWorktree,
    bulkRestartByWorktree,
    bulkCloseByWorktree,
  }));
  return { bulkTrashByWorktree, bulkRestartByWorktree, bulkCloseByWorktree };
}

// The registration callbacks are unused by these action factories; one shared
// escape hatch keeps the no-unsafe-type-assertion count flat across helpers.
const registrationCallbacks = {} as unknown as ActionCallbacks;

function buildRegistry(): ActionRegistry {
  const actions: ActionRegistry = new Map();
  registerWorktreeSessionActions(actions, registrationCallbacks);
  return actions;
}

function setupActions() {
  const actions = buildRegistry();
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

describe("worktree.sessions.endAll confirm gate", () => {
  it("does not end sessions without confirmed:true — the palette/keybinding bypass guard", async () => {
    const { bulkCloseByWorktree } = setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
      { id: "p2", location: "dock", worktreeId: "wt-1" },
    ]);
    const run = setupActions();

    await run("worktree.sessions.endAll", { worktreeId: "wt-1" });

    expect(bulkCloseByWorktree).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "worktreeEndAll",
      targetCount: 2,
      runningAgentCount: 0,
      worktreeId: "wt-1",
    });
  });

  it("counts trash, overlay, and background panels (matching bulkCloseByWorktree) but excludes dialog panels and other worktrees", async () => {
    const { bulkCloseByWorktree } = setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
      { id: "p2", location: "dock", worktreeId: "wt-1" },
      { id: "p3", location: "trash", worktreeId: "wt-1" },
      { id: "p4", location: "overlay", worktreeId: "wt-1" },
      { id: "p5", location: "background", worktreeId: "wt-1" },
      { id: "p6", location: "dialog", worktreeId: "wt-1" },
      { id: "p7", location: "grid", worktreeId: "wt-2" },
    ]);
    const run = setupActions();

    await run("worktree.sessions.endAll", { worktreeId: "wt-1" });

    expect(bulkCloseByWorktree).not.toHaveBeenCalled();
    // grid + dock + trash + overlay + background = 5; dialog and wt-2 are excluded.
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "worktreeEndAll",
      targetCount: 5,
      runningAgentCount: 0,
      worktreeId: "wt-1",
    });
  });

  it("counts only running agents inside the target set — not other worktrees or dialog panels", async () => {
    setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
      {
        id: "p2",
        location: "grid",
        worktreeId: "wt-1",
        detectedAgentId: "claude",
        agentState: "working",
      },
      // Working agent in a DIFFERENT worktree — excluded from targets and count.
      {
        id: "p3",
        location: "grid",
        worktreeId: "wt-2",
        detectedAgentId: "claude",
        agentState: "working",
      },
      // Working agent in a dialog panel — excluded (bulkCloseByWorktree skips dialogs).
      {
        id: "p4",
        location: "dialog",
        worktreeId: "wt-1",
        detectedAgentId: "claude",
        agentState: "working",
      },
    ]);
    const run = setupActions();

    await run("worktree.sessions.endAll", { worktreeId: "wt-1" });

    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "worktreeEndAll",
      targetCount: 2,
      runningAgentCount: 1,
      worktreeId: "wt-1",
    });
  });

  it("does not clear another worktree's pending confirmation when ending this worktree", async () => {
    const { bulkCloseByWorktree } = setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
    ]);
    // A confirmation is already pending for a DIFFERENT worktree.
    pendingDestructiveStoreMock.state.request({
      kind: "worktreeEndAll",
      targetCount: 3,
      runningAgentCount: 0,
      worktreeId: "wt-OTHER",
    });
    const run = setupActions();

    await run("worktree.sessions.endAll", { worktreeId: "wt-1", confirmed: true });

    expect(bulkCloseByWorktree).toHaveBeenCalledWith("wt-1");
    expect(pendingDestructiveStoreMock.state.clear).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.pending).toMatchObject({ worktreeId: "wt-OTHER" });
  });

  it("ends sessions when confirmed:true is passed and clears a stale same-kind pending entry", async () => {
    const { bulkCloseByWorktree } = setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
    ]);
    pendingDestructiveStoreMock.state.request({
      kind: "worktreeEndAll",
      targetCount: 1,
      runningAgentCount: 0,
      worktreeId: "wt-1",
    });
    const run = setupActions();

    await run("worktree.sessions.endAll", { worktreeId: "wt-1", confirmed: true });

    expect(bulkCloseByWorktree).toHaveBeenCalledWith("wt-1");
    expect(pendingDestructiveStoreMock.state.clear).toHaveBeenCalled();
  });

  it("ends sessions for an agent-sourced dispatch without a second prompt (MCP already confirmed)", async () => {
    const { bulkCloseByWorktree } = setPanelState([
      { id: "p1", location: "grid", worktreeId: "wt-1" },
    ]);
    const run = setupActions();

    await run("worktree.sessions.endAll", { worktreeId: "wt-1" }, { dispatchSource: "agent" });

    expect(bulkCloseByWorktree).toHaveBeenCalledWith("wt-1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("is a no-op (no empty confirmation) when the target worktree has no non-dialog sessions", async () => {
    const { bulkCloseByWorktree } = setPanelState([
      { id: "p1", location: "dialog", worktreeId: "wt-1" },
    ]);
    const run = setupActions();

    // Unconfirmed: proves an empty target set never opens a "End 0 sessions" dialog.
    await run("worktree.sessions.endAll", { worktreeId: "wt-1" });

    expect(bulkCloseByWorktree).not.toHaveBeenCalled();
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

describe("worktree.sessions.clearHistory confirm gate", () => {
  const clearMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    clearMock.mockClear();
    vi.stubGlobal("window", { electron: { agentSessionHistory: { clear: clearMock } } });
  });

  it("does not clear without confirmed:true — requests confirmation with a zero count (no live panels)", async () => {
    const run = setupActions();

    await run("worktree.sessions.clearHistory", { worktreeId: "wt-explicit" });

    expect(clearMock).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "worktreeClearHistory",
      targetCount: 0,
      runningAgentCount: 0,
      worktreeId: "wt-explicit",
    });
  });

  it("requests against the active worktree from context when no id is passed", async () => {
    const run = setupActions();

    await run("worktree.sessions.clearHistory", {}, { activeWorktreeId: "wt-active" });

    expect(clearMock).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "worktreeClearHistory",
      targetCount: 0,
      runningAgentCount: 0,
      worktreeId: "wt-active",
    });
  });

  it("clears the explicit worktreeId when confirmed:true and clears a stale same-kind pending entry", async () => {
    pendingDestructiveStoreMock.state.request({
      kind: "worktreeClearHistory",
      targetCount: 0,
      runningAgentCount: 0,
      worktreeId: "wt-explicit",
    });
    const run = setupActions();

    await run("worktree.sessions.clearHistory", { worktreeId: "wt-explicit", confirmed: true });

    expect(clearMock).toHaveBeenCalledWith("wt-explicit");
    expect(pendingDestructiveStoreMock.state.clear).toHaveBeenCalled();
  });

  it("clears for an agent-sourced dispatch without a second prompt (MCP already confirmed)", async () => {
    const run = setupActions();

    await run(
      "worktree.sessions.clearHistory",
      { worktreeId: "wt-active" },
      { dispatchSource: "agent" }
    );

    expect(clearMock).toHaveBeenCalledWith("wt-active");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("does not clear another worktree's pending confirmation when clearing this worktree", async () => {
    pendingDestructiveStoreMock.state.request({
      kind: "worktreeClearHistory",
      targetCount: 0,
      runningAgentCount: 0,
      worktreeId: "wt-OTHER",
    });
    const run = setupActions();

    await run("worktree.sessions.clearHistory", { worktreeId: "wt-explicit", confirmed: true });

    expect(clearMock).toHaveBeenCalledWith("wt-explicit");
    expect(pendingDestructiveStoreMock.state.clear).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.pending).toMatchObject({ worktreeId: "wt-OTHER" });
  });

  it("is a no-op (no confirmation request) when no worktree can be resolved", async () => {
    const run = setupActions();

    // Unconfirmed and unresolved: must not open a confirmation for a null worktree.
    await run("worktree.sessions.clearHistory", {});

    expect(clearMock).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });
});

describe("worktree.sessions confirmed flag survives arg validation (schema regression guard)", () => {
  // The gate tests call run() directly, bypassing Zod. If `confirmed` were dropped
  // from a schema, Zod would strip it and every confirmed dispatch would re-request
  // forever — so assert the schemas actually preserve the flag through a parse.
  function schemaFor(id: string) {
    const factory = buildRegistry().get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return (factory() as AnyActionDefinition).argsSchema;
  }

  it.each(["worktree.sessions.endAll", "worktree.sessions.clearHistory"])(
    "%s preserves confirmed:true through argsSchema",
    (id) => {
      const schema = schemaFor(id);
      expect(schema).toBeDefined();
      const parsed = schema?.safeParse({ worktreeId: "wt-1", confirmed: true });
      expect(parsed?.success).toBe(true);
      expect(parsed?.success ? parsed.data : undefined).toMatchObject({ confirmed: true });
    }
  );
});

describe("worktree.sessions.resetRenderers", () => {
  // Mixed kinds and worktrees: only the PTY panels of the target worktree may
  // be swept. A browser/review panel has no renderer to reset, and letting one
  // hold a frame slot would delay a genuinely garbled terminal behind it.
  const PANES: Panel[] = [
    { id: "a1", location: "grid", worktreeId: "wt-1", kind: "terminal" },
    { id: "b1", location: "grid", worktreeId: "wt-2", kind: "terminal" },
    { id: "a2", location: "grid", worktreeId: "wt-1", kind: "terminal" },
    { id: "web1", location: "grid", worktreeId: "wt-1", kind: "browser" },
    { id: "a3", location: "dock", worktreeId: "wt-1", kind: "terminal" },
    { id: "rev1", location: "grid", worktreeId: "wt-1", kind: "review" },
    // A legacy panel with no recorded kind still sweeps — absence is not proof
    // it lacks a PTY, and skipping it would silently drop a real terminal.
    { id: "a4", location: "grid", worktreeId: "wt-1" },
  ];

  const ptyTargets = ["a1", "a2", "a3", "a4"];

  it("forces every PTY pane in the target worktree and no others", async () => {
    setPanelState(PANES);
    const run = setupActions();

    await run(
      "worktree.sessions.resetRenderers",
      { worktreeId: "wt-1" },
      { dispatchSource: "menu" }
    );

    const called = terminalInstanceServiceMock.resetRenderer.mock.calls.map(([id]) => id);
    // Order-insensitive set equality: the frame pacing is an implementation
    // detail, but the COVERAGE is the contract — awaiting the action must leave
    // no PTY pane of the worktree un-redrawn, and no non-PTY pane touched.
    expect([...called].sort()).toEqual([...ptyTargets].sort());
    // Bulk Redraw is the same explicit user intent as the per-pane one, so it
    // takes the same bypass (#11638).
    for (const call of terminalInstanceServiceMock.resetRenderer.mock.calls) {
      expect(call[1]).toEqual({ force: true });
    }
  });

  it("withholds the bypass from non-foreground dispatch", async () => {
    setPanelState(PANES);
    const run = setupActions();

    await run(
      "worktree.sessions.resetRenderers",
      { worktreeId: "wt-1" },
      { dispatchSource: "plugin" }
    );

    expect(terminalInstanceServiceMock.resetRenderer).toHaveBeenCalled();
    for (const call of terminalInstanceServiceMock.resetRenderer.mock.calls) {
      expect(call[1]).toEqual({ force: false });
    }
  });

  it("falls back to the ambient worktree when the caller names none", async () => {
    setPanelState(PANES);
    const run = setupActions();

    await run(
      "worktree.sessions.resetRenderers",
      {},
      { activeWorktreeId: "wt-2", dispatchSource: "menu" }
    );

    const called = terminalInstanceServiceMock.resetRenderer.mock.calls.map(([id]) => id);
    expect(called).toEqual(["b1"]);
  });

  it("is a no-op when no worktree can be resolved", async () => {
    setPanelState(PANES);
    const run = setupActions();

    await run("worktree.sessions.resetRenderers", {}, { dispatchSource: "menu" });

    expect(terminalInstanceServiceMock.resetRenderer).not.toHaveBeenCalled();
  });

  it("serializes overlapping sweeps instead of interleaving them", async () => {
    setPanelState(PANES);
    const run = setupActions();

    // Two dispatches in flight at once. Each paces itself at one synchronous
    // reflow per frame, but if their loops interleave, several land in the same
    // frame — the pile-up the pacing exists to prevent. Queueing (not
    // superseding) also means neither worktree is left half-repaired.
    const first = run(
      "worktree.sessions.resetRenderers",
      { worktreeId: "wt-1" },
      { dispatchSource: "menu" }
    );
    const second = run(
      "worktree.sessions.resetRenderers",
      { worktreeId: "wt-2" },
      { dispatchSource: "menu" }
    );
    await Promise.all([first, second]);

    const called = terminalInstanceServiceMock.resetRenderer.mock.calls.map(([id]) => id);
    // Every target of BOTH sweeps ran, and wt-2's single pane comes after all
    // of wt-1's rather than being spliced between them.
    expect([...called].sort()).toEqual([...ptyTargets, "b1"].sort());
    expect(called.indexOf("b1")).toBe(called.length - 1);
  });
});
