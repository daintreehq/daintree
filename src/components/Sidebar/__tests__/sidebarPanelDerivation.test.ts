import { describe, it, expect } from "vitest";
import type { PanelInstance } from "@shared/types/panel";
import {
  selectSidebarVisiblePanelIds,
  selectSidebarAgentStateByPanelId,
  selectSidebarFleetEligibleWorktreeById,
  computePanelStateByWorktree,
  type SidebarPanelDerivationState,
} from "../sidebarPanelDerivation";

function agentPanel(overrides: Partial<PanelInstance> = {}): PanelInstance {
  return {
    id: "p",
    kind: "terminal",
    title: "T",
    cwd: "/w",
    cols: 80,
    rows: 24,
    location: "grid",
    worktreeId: "wt-1",
    hasPty: true,
    launchAgentId: "claude",
    agentState: "working",
    ...overrides,
  } as PanelInstance;
}

function makeState(
  panelsById: Record<string, PanelInstance>,
  trashed: Set<string> = new Set()
): SidebarPanelDerivationState {
  return {
    panelIds: Object.keys(panelsById),
    panelsById,
    isInTrash: (id) => trashed.has(id),
  };
}

describe("sidebarPanelDerivation selectors", () => {
  it("agent-state map is unchanged when only a buffer-written field (activityHeadline) changes", () => {
    const before = makeState({ a: agentPanel({ id: "a", agentState: "working" }) });
    // Simulate a status-buffer flush: same references replaced, only the
    // high-frequency activity fields differ. Agent state and visibility must not.
    const after = makeState({
      a: agentPanel({ id: "a", agentState: "working", activityHeadline: "streaming…" }),
    });

    expect(selectSidebarAgentStateByPanelId(after)).toEqual(
      selectSidebarAgentStateByPanelId(before)
    );
    expect(selectSidebarVisiblePanelIds(after)).toEqual(selectSidebarVisiblePanelIds(before));
  });

  it("agent-state map DOES change on a real agentState transition (no stale rollup)", () => {
    const working = makeState({ a: agentPanel({ id: "a", agentState: "working" }) });
    const waiting = makeState({ a: agentPanel({ id: "a", agentState: "waiting" }) });

    expect(selectSidebarAgentStateByPanelId(working)).toEqual({ a: "working" });
    expect(selectSidebarAgentStateByPanelId(waiting)).toEqual({ a: "waiting" });
  });

  it("visibility excludes trashed and non-visible locations", () => {
    const state = makeState(
      {
        a: agentPanel({ id: "a", location: "grid" }),
        b: agentPanel({ id: "b", location: "background" }),
        c: agentPanel({ id: "c", location: "grid" }),
      },
      new Set(["c"])
    );

    expect(selectSidebarVisiblePanelIds(state)).toEqual({ a: 1 });
  });

  it("counts panels committed to panelsById before panelIds is revealed (spawn batch)", () => {
    // During a spawn/hydration batch the panel lands in panelsById immediately
    // but panelIds is deferred until flush (#9649). The selectors iterate
    // panelsById so the sidebar still counts it before the batch flush.
    const state: SidebarPanelDerivationState = {
      panelIds: [], // not yet revealed
      panelsById: { batched: agentPanel({ id: "batched", agentState: "working" }) },
      isInTrash: () => false,
    };

    expect(selectSidebarVisiblePanelIds(state)).toEqual({ batched: 1 });

    const rollup = computePanelStateByWorktree(
      ["wt-1"],
      { "wt-1": ["batched"] },
      selectSidebarVisiblePanelIds(state),
      selectSidebarAgentStateByPanelId(state),
      new Set(["wt-1"])
    );
    expect(rollup["wt-1"]?.terminalCount).toBe(1);
    expect(rollup["wt-1"]?.hasWorkingAgent).toBe(true);
  });

  it("fleet eligibility maps live PTY panels to their worktree id", () => {
    const state = makeState({
      a: agentPanel({ id: "a", worktreeId: "wt-1", runtimeStatus: "running" }),
      exited: agentPanel({ id: "exited", worktreeId: "wt-1", runtimeStatus: "exited" }),
    });

    const eligible = selectSidebarFleetEligibleWorktreeById(state);
    expect(eligible.a).toBe("wt-1");
    // A panel whose runtimeStatus has crossed into "exited" is not arm-eligible.
    expect(eligible.exited).toBeUndefined();
  });

  it("fleet eligibility excludes plain shells so the sidebar arm count is agent-scoped", () => {
    // #11637: the count behind the quick-filter arm affordance fed on the broad
    // terminal predicate, so shells inflated "Arm all N terminals" and got armed.
    // `agentPanel` defaults launchAgentId to "claude", so the shell must clear
    // every identity source or it stays agent-capable and proves nothing.
    const state = makeState({
      agent: agentPanel({ id: "agent", worktreeId: "wt-1", runtimeStatus: "running" }),
      shell: agentPanel({
        id: "shell",
        worktreeId: "wt-1",
        runtimeStatus: "running",
        launchAgentId: undefined,
        detectedAgentId: undefined,
        runtimeIdentity: undefined,
        agentState: undefined,
      }),
    });

    const eligible = selectSidebarFleetEligibleWorktreeById(state);
    expect(eligible.agent).toBe("wt-1");
    expect(eligible.shell).toBeUndefined();
  });

  it("fleet eligibility excludes demoted ex-agent shells", () => {
    // Launch affinity survives but detection, runtime identity, and agentState
    // are gone — the demotion branch, distinct from the plain shell above.
    const state = makeState({
      exAgent: agentPanel({
        id: "exAgent",
        worktreeId: "wt-1",
        runtimeStatus: "running",
        launchAgentId: "claude",
        detectedAgentId: undefined,
        runtimeIdentity: undefined,
        agentState: undefined,
        everDetectedAgent: true,
      }),
    });

    expect(selectSidebarFleetEligibleWorktreeById(state).exAgent).toBeUndefined();
  });

  it("fleet eligibility counts plugin-contributed agents, not just built-in ids", () => {
    // The arm count must not gate on built-in agent capability — plugin and user
    // agent ids are non-built-in by construction, and arming only adds the
    // terminal to the broadcast set (#11637).
    const state = makeState({
      plugin: agentPanel({
        id: "plugin",
        worktreeId: "wt-1",
        runtimeStatus: "running",
        launchAgentId: "acme-plugin-agent",
        detectedAgentId: undefined,
      }),
    });

    expect(selectSidebarFleetEligibleWorktreeById(state).plugin).toBe("wt-1");
  });
});

describe("computePanelStateByWorktree", () => {
  it("counts visible terminals and rolls up agent-state flags per worktree", () => {
    const visible = { a: 1, b: 1, c: 1 } as Record<string, 1>;
    const agentState = { a: "working", b: "waiting", c: "waiting" } as const;

    const result = computePanelStateByWorktree(
      ["wt-1"],
      { "wt-1": ["a", "b", "c"] },
      visible,
      agentState,
      new Set(["wt-1"])
    );

    expect(result["wt-1"]).toEqual({
      terminalCount: 3,
      waitingTerminalCount: 2,
      hasWorkingAgent: true,
      hasWaitingAgent: true,
      hasCompletedAgent: false,
      hasExitedAgent: false,
    });
  });

  it("sets completed and exited flags from agent state", () => {
    const result = computePanelStateByWorktree(
      ["wt-1"],
      { "wt-1": ["a", "b"] },
      { a: 1, b: 1 },
      { a: "completed", b: "exited" },
      new Set(["wt-1"])
    );

    expect(result["wt-1"]?.hasCompletedAgent).toBe(true);
    expect(result["wt-1"]?.hasExitedAgent).toBe(true);
    expect(result["wt-1"]?.hasWorkingAgent).toBe(false);
    expect(result["wt-1"]?.waitingTerminalCount).toBe(0);
  });

  it("does not count panels absent from the visible map", () => {
    const result = computePanelStateByWorktree(
      ["wt-1"],
      { "wt-1": ["a", "hidden"] },
      { a: 1 },
      { a: "working" },
      new Set(["wt-1"])
    );

    expect(result["wt-1"]?.terminalCount).toBe(1);
    expect(result["wt-1"]?.hasWorkingAgent).toBe(true);
  });

  it("emits an empty summary for orphaned worktrees (not in the valid set)", () => {
    const result = computePanelStateByWorktree(
      ["wt-orphan"],
      { "wt-orphan": ["a"] },
      { a: 1 },
      { a: "working" },
      new Set(["wt-1"])
    );

    expect(result["wt-orphan"]).toEqual({
      terminalCount: 0,
      waitingTerminalCount: 0,
      hasWorkingAgent: false,
      hasWaitingAgent: false,
      hasCompletedAgent: false,
      hasExitedAgent: false,
    });
  });
});
