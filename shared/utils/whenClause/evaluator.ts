import type { ASTNode, ContextKeyValue, WhenClauseContext } from "./types";

function resolve(path: string[], ctx: WhenClauseContext): unknown {
  let current: unknown = ctx;
  for (const segment of path) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveValue(node: ASTNode, ctx: WhenClauseContext): ContextKeyValue {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "identifier":
      return resolve(node.path, ctx) as ContextKeyValue;
    default:
      return evaluate(node, ctx);
  }
}

export function evaluate(node: ASTNode, ctx: WhenClauseContext): boolean {
  switch (node.kind) {
    case "literal": {
      if (typeof node.value === "boolean") return node.value;
      return node.value.length > 0;
    }
    case "identifier": {
      const val = resolve(node.path, ctx);
      if (val === true) return true;
      if (typeof val === "string") return val.length > 0;
      return false;
    }
    case "unary":
      return !evaluate(node.operand, ctx);
    case "binary": {
      switch (node.operator) {
        case "&&":
          return evaluate(node.left, ctx) && evaluate(node.right, ctx);
        case "||":
          return evaluate(node.left, ctx) || evaluate(node.right, ctx);
        case "==":
          return resolveValue(node.left, ctx) === resolveValue(node.right, ctx);
        case "!=":
          return resolveValue(node.left, ctx) !== resolveValue(node.right, ctx);
      }
    }
  }
}
