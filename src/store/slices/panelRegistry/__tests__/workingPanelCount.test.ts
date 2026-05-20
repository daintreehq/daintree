import { describe, it, expect } from "vitest";
import { computeWorkingGridAgentCount } from "../helpers";
import type { TerminalInstance } from "@shared/types";

// Selector-based fleet workload counter (issue #8596). Derived rather than
// maintained at write-time so listeners that bypass `updateAgentState`
// (identity reducers, raw setState, restart catch blocks) can't desync it.

function panel(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid",
    isVisible: true,
    ...overrides,
  } as TerminalInstance;
}

describe("computeWorkingGridAgentCount (#8596)", () => {
  it("returns 0 for an empty registry", () => {
    expect(computeWorkingGridAgentCount({})).toBe(0);
  });

  it("counts a single working grid panel", () => {
    expect(
      computeWorkingGridAgentCount({
        "t-1": panel("t-1", { agentState: "working" }),
      })
    ).toBe(1);
  });

  it("counts multiple working grid panels", () => {
    expect(
      computeWorkingGridAgentCount({
        "t-1": panel("t-1", { agentState: "working" }),
        "t-2": panel("t-2", { agentState: "working" }),
        "t-3": panel("t-3", { agentState: "working" }),
      })
    ).toBe(3);
  });

  it("excludes non-working panels", () => {
    expect(
      computeWorkingGridAgentCount({
        "t-1": panel("t-1", { agentState: "working" }),
        "t-2": panel("t-2", { agentState: "idle" }),
        "t-3": panel("t-3", { agentState: "waiting" }),
        "t-4": panel("t-4", { agentState: "completed" }),
        "t-5": panel("t-5", { agentState: "exited" }),
      })
    ).toBe(1);
  });

  it("excludes panels with undefined agentState", () => {
    expect(
      computeWorkingGridAgentCount({
        "t-1": panel("t-1", { agentState: undefined }),
      })
    ).toBe(0);
  });

  it("excludes dock-located working panels (not visible on screen)", () => {
    expect(
      computeWorkingGridAgentCount({
        "t-1": panel("t-1", { agentState: "working", location: "grid" }),
        "t-2": panel("t-2", { agentState: "working", location: "dock" }),
      })
    ).toBe(1);
  });

  it("excludes trashed working panels", () => {
    expect(
      computeWorkingGridAgentCount({
        "t-1": panel("t-1", { agentState: "working", location: "grid" }),
        "t-2": panel("t-2", { agentState: "working", location: "trash" }),
      })
    ).toBe(1);
  });

  it("excludes backgrounded working panels", () => {
    expect(
      computeWorkingGridAgentCount({
        "t-1": panel("t-1", { agentState: "working", location: "grid" }),
        "t-2": panel("t-2", { agentState: "working", location: "background" }),
      })
    ).toBe(1);
  });

  it("excludes explicitly invisible panels", () => {
    expect(
      computeWorkingGridAgentCount({
        "t-1": panel("t-1", { agentState: "working", isVisible: true }),
        "t-2": panel("t-2", { agentState: "working", isVisible: false }),
      })
    ).toBe(1);
  });

  it("treats undefined location as grid (legacy default)", () => {
    expect(
      computeWorkingGridAgentCount({
        "t-1": panel("t-1", { agentState: "working", location: undefined }),
      })
    ).toBe(1);
  });

  it("treats undefined isVisible as visible (legacy default)", () => {
    expect(
      computeWorkingGridAgentCount({
        "t-1": panel("t-1", { agentState: "working", isVisible: undefined }),
      })
    ).toBe(1);
  });
});
