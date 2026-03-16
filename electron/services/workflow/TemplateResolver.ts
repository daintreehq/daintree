import type { NodeState } from "../../../shared/types/workflowRun.js";
import { resolveJsonPath } from "./ConditionEvaluator.js";

const TEMPLATE_REGEX = /\{\{\s*([^}]+?)\s*\}\}/g;

export function hasTemplateExpressions(value: unknown): boolean {
  if (typeof value === "string") {
    TEMPLATE_REGEX.lastIndex = 0;
    return TEMPLATE_REGEX.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasTemplateExpressions(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => hasTemplateExpressions(v));
  }
  return false;
}

export function resolveTemplateArgs(
  args: Record<string, unknown>,
  nodeStates: Record<string, NodeState>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    resolved[key] = resolveTemplateValue(value, nodeStates);
  }

  return resolved;
}

export function resolveTemplateValue(
  value: unknown,
  nodeStates: Record<string, NodeState>
): unknown {
  if (typeof value === "string") {
    return resolveTemplateString(value, nodeStates);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, nodeStates));
  }

  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      resolved[k] = resolveTemplateValue(v, nodeStates);
    }
    return resolved;
  }

  return value;
}

export function resolveTemplateString(
  value: string,
  nodeStates: Record<string, NodeState>
): unknown {
  const pureMatch = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (pureMatch) {
    return resolveExpression(pureMatch[1], nodeStates);
  }

  TEMPLATE_REGEX.lastIndex = 0;
  if (!TEMPLATE_REGEX.test(value)) {
    return value;
  }

  TEMPLATE_REGEX.lastIndex = 0;
  return value.replace(TEMPLATE_REGEX, (_match, expression: string) => {
    const resolved = resolveExpression(expression, nodeStates);
    if (typeof resolved === "string") {
      return resolved;
    }
    return JSON.stringify(resolved);
  });
}

export function resolveExpression(
  expression: string,
  nodeStates: Record<string, NodeState>
): unknown {
  const dotIndex = expression.indexOf(".");
  if (dotIndex === -1) {
    throw new Error(
      `Invalid template expression "{{${expression}}}": must be in format {{nodeId.path}}`
    );
  }

  const nodeId = expression.substring(0, dotIndex);
  const path = expression.substring(dotIndex + 1);

  const nodeState = nodeStates[nodeId];
  if (!nodeState) {
    throw new Error(
      `Template expression "{{${expression}}}": node "${nodeId}" not found in workflow`
    );
  }

  if (nodeState.status !== "completed" || !nodeState.result) {
    throw new Error(
      `Template expression "{{${expression}}}": node "${nodeId}" has not completed (status: ${nodeState.status})`
    );
  }

  return resolveJsonPath(nodeState.result, path);
}
