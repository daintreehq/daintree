/**
 * Tests for useWorktreeTerminals hook logic
 *
 * Tests the core filtering and counting logic without full React rendering.
 */

import { describe, it, expect } from "vitest";
import type { TerminalInstance, AgentState } from "../../types";

/**
 * Helper function that implements the core logic of useWorktreeTerminals
 * This allows testing without React hooks infrastructure
 */
function calculateWorktreeCounts(terminals: TerminalInstance[], worktreeId: string) {
  const worktreeTerminals = terminals.filter((t) => t.worktreeId === worktreeId);

  const byState: Record<AgentState, number> = {
    idle: 0,
    working: 0,
    running: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
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
      running: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
    });
  });

  it("filters terminals by worktreeId", () => {
    const terminals: TerminalInstance[] = [
      {
        id: "term-1",
        worktreeId: "worktree-1",
        type: "terminal",
        title: "Shell 1",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-2",
        worktreeId: "worktree-2",
        type: "terminal",
        title: "Shell 2",
        cwd: "/path/2",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-3",
        worktreeId: "worktree-1",
        type: "claude",
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
        type: "terminal",
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
        type: "terminal",
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
        type: "claude",
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
        type: "claude",
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
        type: "gemini",
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
        type: "claude",
        title: "Claude 3",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        agentState: "failed",
        error: "Test error",
      },
    ];

    const result = calculateWorktreeCounts(terminals, "worktree-1");

    expect(result.counts.total).toBe(4);
    expect(result.counts.byState.working).toBe(2);
    expect(result.counts.byState.idle).toBe(1);
    expect(result.counts.byState.failed).toBe(1);
    expect(result.counts.byState.waiting).toBe(0);
    expect(result.counts.byState.completed).toBe(0);
  });

  it("handles terminals without worktreeId", () => {
    const terminals: TerminalInstance[] = [
      {
        id: "term-1",
        type: "terminal",
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
        type: "terminal",
        title: "Shell 2",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ];

    const result = calculateWorktreeCounts(terminals, "worktree-1");

    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0].id).toBe("term-2");
    expect(result.counts.total).toBe(1);
  });

  it("handles mixed agent states", () => {
    const terminals: TerminalInstance[] = [
      {
        id: "term-1",
        worktreeId: "worktree-1",
        type: "claude",
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
        type: "terminal",
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
        type: "gemini",
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

  it("counts shell terminals in running state", () => {
    const terminals: TerminalInstance[] = [
      {
        id: "term-1",
        worktreeId: "worktree-1",
        type: "terminal",
        title: "Shell",
        cwd: "/path/1",
        cols: 80,
        rows: 24,
        location: "grid",
        agentState: "running",
      },
      {
        id: "term-2",
        worktreeId: "worktree-1",
        type: "terminal",
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
    expect(result.counts.byState.running).toBe(1);
    expect(result.counts.byState.idle).toBe(1);
  });
});
