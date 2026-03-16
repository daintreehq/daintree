import type { WorkflowCondition } from "../../../shared/types/workflow.js";
import type { NodeState, WorkflowRun } from "../../../shared/types/workflowRun.js";

export function evaluateCondition(
  condition: WorkflowCondition,
  nodeState: NodeState,
  run: WorkflowRun
): boolean {
  if (condition.type === "status") {
    const targetNodeId = condition.taskId || "";
    const targetState = targetNodeId ? run.nodeStates[targetNodeId] : nodeState;

    if (!targetState) {
      return false;
    }

    const actualValue = targetState.status;
    return compareValues(actualValue, condition.op, condition.value);
  }

  if (condition.type === "result") {
    const targetNodeId = condition.taskId || "";
    const targetState = targetNodeId ? run.nodeStates[targetNodeId] : nodeState;

    if (!targetState || !targetState.result) {
      return false;
    }

    const resolvedValue = resolveJsonPath(targetState.result, condition.path);
    return compareValues(resolvedValue, condition.op, condition.value);
  }

  return false;
}

export function compareValues(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "<":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case ">=":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "<=":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    default:
      return false;
  }
}

export function resolveJsonPath(obj: unknown, path: string): unknown {
  if (!path || !obj || typeof obj !== "object") {
    return undefined;
  }

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
