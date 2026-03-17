import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  compareValues,
  resolveJsonPath,
} from "../../workflow/ConditionEvaluator.js";
import type { WorkflowRun } from "../../../../shared/types/workflowRun.js";

function makeRun(nodeStates: Record<string, unknown> = {}): WorkflowRun {
  return {
    runId: "r1",
    workflowId: "w1",
    workflowVersion: "1.0.0",
    status: "running",
    startedAt: Date.now(),
    definition: { id: "w1", version: "1.0.0", name: "Test", nodes: [] },
    nodeStates: nodeStates as WorkflowRun["nodeStates"],
    taskMapping: {},
    scheduledNodes: new Set(),
    evaluatedConditions: [],
  };
}

describe("compareValues", () => {
  it("handles == and !=", () => {
    expect(compareValues("completed", "==", "completed")).toBe(true);
    expect(compareValues("completed", "==", "failed")).toBe(false);
    expect(compareValues("a", "!=", "b")).toBe(true);
    expect(compareValues("a", "!=", "a")).toBe(false);
  });

  it("handles numeric operators", () => {
    expect(compareValues(5, ">", 3)).toBe(true);
    expect(compareValues(3, ">", 5)).toBe(false);
    expect(compareValues(3, "<", 5)).toBe(true);
    expect(compareValues(5, ">=", 5)).toBe(true);
    expect(compareValues(4, ">=", 5)).toBe(false);
    expect(compareValues(5, "<=", 5)).toBe(true);
    expect(compareValues(6, "<=", 5)).toBe(false);
  });

  it("returns false for numeric ops with non-numbers", () => {
    expect(compareValues("a", ">", 3)).toBe(false);
    expect(compareValues(3, ">", "a")).toBe(false);
  });

  it("returns false for unknown operators", () => {
    expect(compareValues(1, "~=", 1)).toBe(false);
  });
});

describe("resolveJsonPath", () => {
  it("resolves simple dot notation", () => {
    expect(resolveJsonPath({ summary: "ok" }, "summary")).toBe("ok");
  });

  it("resolves nested paths", () => {
    expect(resolveJsonPath({ data: { count: 42 } }, "data.count")).toBe(42);
  });

  it("resolves array index notation", () => {
    expect(resolveJsonPath({ items: ["a", "b"] }, "items.0")).toBe("a");
  });

  it("returns undefined for empty path", () => {
    expect(resolveJsonPath({ a: 1 }, "")).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(resolveJsonPath(null, "a")).toBeUndefined();
    expect(resolveJsonPath("string", "a")).toBeUndefined();
  });

  it("returns undefined when traversal hits non-object", () => {
    expect(resolveJsonPath({ a: 42 }, "a.b")).toBeUndefined();
  });
});

describe("evaluateCondition", () => {
  it("evaluates status condition on current node", () => {
    const nodeState = { status: "completed" as const };
    const run = makeRun();
    expect(
      evaluateCondition({ type: "status", op: "==", value: "completed" }, nodeState, run)
    ).toBe(true);
  });

  it("evaluates status condition on a different node via taskId", () => {
    const nodeState = { status: "completed" as const };
    const run = makeRun({ "other-node": { status: "failed" } });
    expect(
      evaluateCondition(
        { type: "status", taskId: "other-node", op: "==", value: "failed" },
        nodeState,
        run
      )
    ).toBe(true);
  });

  it("returns false when target node is missing", () => {
    const nodeState = { status: "completed" as const };
    const run = makeRun();
    expect(
      evaluateCondition(
        { type: "status", taskId: "missing", op: "==", value: "completed" },
        nodeState,
        run
      )
    ).toBe(false);
  });

  it("evaluates result condition with JSONPath", () => {
    const nodeState = {
      status: "completed" as const,
      result: { summary: "done", data: { score: 95 } },
    };
    const run = makeRun();
    expect(
      evaluateCondition({ type: "result", path: "data.score", op: ">=", value: 90 }, nodeState, run)
    ).toBe(true);
  });

  it("returns false for result condition when no result", () => {
    const nodeState = { status: "running" as const };
    const run = makeRun();
    expect(
      evaluateCondition({ type: "result", path: "summary", op: "==", value: "x" }, nodeState, run)
    ).toBe(false);
  });
});
