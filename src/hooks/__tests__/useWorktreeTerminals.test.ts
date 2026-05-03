/**
 * Tests for useWorktreeTerminals hook logic
 *
 * Tests the core filtering and counting logic without full React rendering.
 */

import { describe, it, expect } from "vitest";
import type { TerminalInstance, AgentState } from "../../types";
import { aggregateAgentStates } from "../useWorktreeTerminals";

/**
 * Helper function that implements the core logic of useWorktreeTerminals
 * This allows testing without React hooks infrastructure
 */
function calculateWorktreeCounts(terminals: TerminalInstance[], worktreeId: string) {
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
    const terminals: TerminalInstance[] = [
      {
        id: "term-1",
        worktreeId: "worktree-1",
        title: "Shell 1",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-2",
        worktreeId: "worktree-2",
        title: "Shell 2",
        cwd: "/path/2",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-3",
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
    const terminals: TerminalInstance[] = [
      {
        id: "term-1",
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
    const terminals: TerminalInstance[] = [
      {
        id: "term-1",
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
    const terminals: TerminalInstance[] = [
      {
        id: "term-1",
        title: "Shell",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        // No worktreeId
      },
      {
        id: "term-2",
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
    const terminals: TerminalInstance[] = [
      {
        id: "term-1",
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
    const terminals: TerminalInstance[] = [
      {
        id: "term-1",
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
  function term(overrides: Partial<TerminalInstance>): TerminalInstance {
    return {
      id: "t-" + Math.random().toString(36).slice(2),
      worktreeId: "wt-1",
      title: "T",
      cwd: "/x",
      cols: 80,
      rows: 24,
      location: "grid",
      ...overrides,
    } as TerminalInstance;
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

  it("counts a launchAgentId-anchored agent terminal across all states (canonical path unchanged)", () => {
    const { byState, agentStates } = aggregateAgentStates([
      term({ launchAgentId: "claude", agentState: "working" }),
      term({ launchAgentId: "claude", agentState: "completed" }),
      term({ launchAgentId: "claude", agentState: "idle" }),
    ]);
    expect(byState.working).toBe(1);
    expect(byState.completed).toBe(1);
    expect(byState.idle).toBe(1);
    expect(agentStates).toEqual(["working", "completed", "idle"]);
  });

  it("treats a plain shell with no agentState as idle", () => {
    const { byState, agentStates } = aggregateAgentStates([term({})]);
    expect(byState.idle).toBe(1);
    expect(agentStates).toEqual([]);
  });
});
