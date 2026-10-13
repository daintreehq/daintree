// @vitest-environment jsdom
/**
 * Tests for useWorktreeTerminals hook logic
 *
 * Tests the core filtering and counting logic without full React rendering.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import { usePanelStore } from "@/store/panelStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { PtyPanelData } from "@shared/types/panel";
import type { AgentState } from "../../types";
import { aggregateAgentStates, useWorktreeTerminals } from "../useWorktreeTerminals";

/**
 * Helper function that implements the core logic of useWorktreeTerminals
 * This allows testing without React hooks infrastructure
 */
function calculateWorktreeCounts(terminals: PtyPanelData[], worktreeId: string) {
  const worktreeTerminals = terminals.filter((t) => t.worktreeId === worktreeId);

  const byState: Record<AgentState, number> = {
    idle: 0,
    working: 0,
    waiting: 0,
    directing: 0,
    completed: 0,
    exited: 0,
  };

  worktreeTerminals.forEach((terminal) => {
    const state = terminal.agentState || "idle";
    byState[state] = (byState[state] || 0) + 1;
  });

  return {
    terminals: worktreeTerminals,
    counts: {
      total: worktreeTerminals.length,
      byState,
    },
  };
}

describe("useWorktreeTerminals logic", () => {
  it("returns empty results for worktree with no terminals", () => {
    const result = calculateWorktreeCounts([], "worktree-1");

    expect(result.terminals).toEqual([]);
    expect(result.counts.total).toBe(0);
    expect(result.counts.byState).toEqual({
      idle: 0,
      working: 0,
      waiting: 0,
      directing: 0,
      completed: 0,
      exited: 0,
    });
  });

  it("filters terminals by worktreeId", () => {
    const terminals: PtyPanelData[] = [
      {
        id: "term-1",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Shell 1",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-2",
        kind: "terminal" as const,
        worktreeId: "worktree-2",
        title: "Shell 2",
        cwd: "/path/2",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-3",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Claude",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ];

    const result = calculateWorktreeCounts(terminals, "worktree-1");

    expect(result.terminals).toHaveLength(2);
    expect(result.terminals.map((t) => t.id)).toEqual(["term-1", "term-3"]);
    expect(result.counts.total).toBe(2);
  });

  it("counts terminals without agentState as idle", () => {
    const terminals: PtyPanelData[] = [
      {
        id: "term-1",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Shell",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        // No agentState
      },
      {
        id: "term-2",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Shell 2",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        // No agentState
      },
    ];

    const result = calculateWorktreeCounts(terminals, "worktree-1");

    expect(result.counts.total).toBe(2);
    expect(result.counts.byState.idle).toBe(2);
    expect(result.counts.byState.working).toBe(0);
  });

  it("aggregates terminals by agent state", () => {
    const terminals: PtyPanelData[] = [
      {
        id: "term-1",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Claude 1",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        agentState: "working",
      },
      {
        id: "term-2",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Claude 2",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        agentState: "working",
      },
      {
        id: "term-3",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Gemini",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        agentState: "idle",
      },
      {
        id: "term-4",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Claude 3",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        agentState: "completed",
      },
    ];

    const result = calculateWorktreeCounts(terminals, "worktree-1");

    expect(result.counts.total).toBe(4);
    expect(result.counts.byState.working).toBe(2);
    expect(result.counts.byState.idle).toBe(1);
    expect(result.counts.byState.completed).toBe(1);
    expect(result.counts.byState.waiting).toBe(0);
  });

  it("handles terminals without worktreeId", () => {
    const terminals: PtyPanelData[] = [
      {
        id: "term-1",
        kind: "terminal" as const,
        title: "Shell",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        // No worktreeId
      },
      {
        id: "term-2",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Shell 2",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ];

    const result = calculateWorktreeCounts(terminals, "worktree-1");

    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0]!.id).toBe("term-2");
    expect(result.counts.total).toBe(1);
  });

  it("handles mixed agent states", () => {
    const terminals: PtyPanelData[] = [
      {
        id: "term-1",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Claude",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        agentState: "waiting",
      },
      {
        id: "term-2",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Shell",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        // No agent state - should count as idle
      },
      {
        id: "term-3",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Gemini",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        agentState: "completed",
      },
    ];

    const result = calculateWorktreeCounts(terminals, "worktree-1");

    expect(result.counts.total).toBe(3);
    expect(result.counts.byState.waiting).toBe(1);
    expect(result.counts.byState.idle).toBe(1);
    expect(result.counts.byState.completed).toBe(1);
  });

  it("counts shell terminals with mixed agent states", () => {
    const terminals: PtyPanelData[] = [
      {
        id: "term-1",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Shell",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        agentState: "working",
      },
      {
        id: "term-2",
        kind: "terminal" as const,
        worktreeId: "worktree-1",
        title: "Shell 2",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        agentState: "idle",
      },
    ];

    const result = calculateWorktreeCounts(terminals, "worktree-1");

    expect(result.counts.total).toBe(2);
    expect(result.counts.byState.working).toBe(1);
    expect(result.counts.byState.idle).toBe(1);
  });
});

// #6650 — Active agentState (working/waiting/directing) credited to counts
// even when agent identity hasn't committed yet, so collapsed worktree badges
// surface live progress instead of staying idle until detection lands.
describe("aggregateAgentStates (#6650)", () => {
  function term(overrides: Partial<PtyPanelData>): PtyPanelData {
    return {
      id: "t-" + Math.random().toString(36).slice(2),
      kind: "terminal" as const,
      worktreeId: "wt-1",
      title: "T",
      cwd: "/x",
      cols: 80,
      rows: 24,
      location: "grid",
      ...overrides,
    } as PtyPanelData;
  }

  it("counts a working terminal toward byState.working even with no agent identity", () => {
    const { byState, agentStates } = aggregateAgentStates([term({ agentState: "working" })]);
    expect(byState.working).toBe(1);
    expect(byState.idle).toBe(0);
    expect(agentStates).toEqual(["working"]);
  });

  it("counts an identity-less waiting terminal toward byState.waiting", () => {
    const { byState, agentStates } = aggregateAgentStates([term({ agentState: "waiting" })]);
    expect(byState.waiting).toBe(1);
    expect(agentStates).toEqual(["waiting"]);
  });

  it("counts an identity-less directing terminal toward byState.directing", () => {
    const { byState, agentStates } = aggregateAgentStates([term({ agentState: "directing" })]);
    expect(byState.directing).toBe(1);
    expect(agentStates).toEqual(["directing"]);
  });

  it("does NOT credit idle for an identity-less terminal with stale 'idle' state", () => {
    const { byState, agentStates } = aggregateAgentStates([term({ agentState: "idle" })]);
    expect(byState.idle).toBe(1);
    expect(agentStates).toEqual([]);
  });

  it("does NOT credit completed for an identity-less terminal (no stale signal)", () => {
    const { byState, agentStates } = aggregateAgentStates([term({ agentState: "completed" })]);
    expect(byState.completed).toBe(0);
    expect(byState.idle).toBe(1);
    expect(agentStates).toEqual([]);
  });

  it("does NOT credit exited for an identity-less terminal", () => {
    const { byState, agentStates } = aggregateAgentStates([term({ agentState: "exited" })]);
    expect(byState.exited).toBe(0);
    expect(byState.idle).toBe(1);
    expect(agentStates).toEqual([]);
  });

  it("coerces live-agent idle/completed states to waiting for badge display", () => {
    const { byState, agentStates } = aggregateAgentStates([
      term({ launchAgentId: "claude", agentState: "working" }),
      term({ launchAgentId: "claude", agentState: "completed" }),
      term({ launchAgentId: "claude", agentState: "idle" }),
    ]);
    expect(byState.working).toBe(1);
    expect(byState.waiting).toBe(2);
    expect(byState.completed).toBe(0);
    expect(byState.idle).toBe(0);
    expect(agentStates).toEqual(["working", "waiting", "waiting"]);
  });

  it("treats a plain shell with no agentState as idle", () => {
    const { byState, agentStates } = aggregateAgentStates([term({})]);
    expect(byState.idle).toBe(1);
    expect(agentStates).toEqual([]);
  });

  describe("hand-backs (#13235)", () => {
    const agent = (id: string, overrides: Partial<PtyPanelData> = {}) =>
      term({ id, launchAgentId: "claude", agentState: "waiting", ...overrides });

    it("counts a read hand-back as completed and an unread one apart from waiting", () => {
      const states = new Map<string, "seen" | "unseen">([
        ["seen", "seen"],
        ["unseen", "unseen"],
      ]);
      const { byState, unread, agentStates } = aggregateAgentStates(
        [agent("seen"), agent("unseen", { agentState: "completed" }), agent("plain")],
        (id) => states.get(id) ?? "none"
      );
      expect(byState.completed).toBe(1);
      expect(unread).toBe(1);
      expect(byState.waiting).toBe(1);
      // The dominant state follows the observation, not the read state.
      expect(agentStates).toEqual(["waiting", "waiting", "waiting"]);
    });

    it("keeps an approval wait counted as waiting even with a read hand-back", () => {
      const { byState, unread } = aggregateAgentStates(
        [agent("a", { waitingReason: "approval" })],
        () => "seen"
      );
      expect(byState.waiting).toBe(1);
      expect(byState.completed).toBe(0);
      expect(unread).toBe(0);
    });

    it("counts nothing as unread without hand-back data", () => {
      const { byState, unread } = aggregateAgentStates([agent("a")]);
      expect(byState.waiting).toBe(1);
      expect(unread).toBe(0);
    });
  });

  describe("useWorktreeTerminals hand-back subscription", () => {
    afterEach(() => {
      usePanelStore.setState({ panelsById: {}, panelIdsByWorktreeId: {} });
      useFleetSnapshotStore.setState({ snapshot: null });
      vi.useRealTimers();
    });

    it("recounts when only the fleet snapshot changes", () => {
      vi.useFakeTimers();
      const panel = term({
        id: "hb-hook",
        worktreeId: "wt-hb",
        launchAgentId: "claude",
        agentState: "waiting",
      });
      usePanelStore.setState({
        panelsById: { [panel.id]: panel },
        panelIdsByWorktreeId: { "wt-hb": [panel.id] },
      });
      const setHandBack = (handBack: FleetRunRow["handBack"]) =>
        act(() => {
          useFleetSnapshotStore.setState({
            snapshot: {
              runs: [
                {
                  runId: panel.id,
                  workspaceId: "p1",
                  spawnedAt: 0,
                  cwd: "/x",
                  agentState: "waiting",
                  handBack,
                },
              ],
              changedAt: 0,
              degraded: false,
              lastSuccessfulAt: null,
            } satisfies FleetSnapshot,
          });
        });
      // A second act: the debounce timer is only scheduled once the first
      // act has flushed the re-render's effects.
      const settle = () =>
        act(() => {
          vi.advanceTimersByTime(300);
        });

      const { result } = renderHook(() => useWorktreeTerminals("wt-hb"));
      expect(result.current.counts.byState.waiting).toBe(1);
      expect(result.current.counts.unread).toBe(0);

      setHandBack({ stoppedAt: 1 });
      settle();
      expect(result.current.counts.unread).toBe(1);
      expect(result.current.counts.byState.waiting).toBe(0);

      setHandBack({ stoppedAt: 1, seenAt: 2 });
      settle();
      expect(result.current.counts.unread).toBe(0);
      expect(result.current.counts.byState.completed).toBe(1);
      // The dominant state follows the observation, not the read state.
      expect(result.current.dominantAgentState).toBe("waiting");
    });
  });
});
