import type { ASTNode, WhenClauseContext } from "../../shared/utils/whenClause/types.js";
import { parse } from "../../shared/utils/whenClause/parser.js";
import { evaluate } from "../../shared/utils/whenClause/evaluator.js";

const astCache = new Map<string, ASTNode>();
const pluginExprs = new Map<string, Set<string>>();

export function compile(expr: string): ASTNode {
  const cached = astCache.get(expr);
  if (cached) return cached;
  const ast = parse(expr);
  astCache.set(expr, ast);
  return ast;
}

export function evaluateWhen(expr: string | undefined, ctx: WhenClauseContext): boolean {
  if (!expr) return true;
  try {
    return evaluate(compile(expr), ctx);
  } catch {
    return false;
  }
}

export function trackPluginExpression(pluginId: string, expr: string | undefined): void {
  if (!expr) return;
  compile(expr);
  const set = pluginExprs.get(pluginId) ?? new Set();
  set.add(expr);
  pluginExprs.set(pluginId, set);
}

export function unregisterPlugin(pluginId: string): void {
  pluginExprs.delete(pluginId);
}

export function clear(): void {
  astCache.clear();
  pluginExprs.clear();
}
