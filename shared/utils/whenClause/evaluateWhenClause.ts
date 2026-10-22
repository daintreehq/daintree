import { parse } from "./parser.js";
import { evaluate } from "./evaluator.js";
import type { ASTNode, WhenClauseContext } from "./types.js";

const MAX_CACHED_EXPRESSIONS = 256;

// `null` records an expression that failed to parse, so a malformed clause on
// a re-rendering surface is rejected once rather than on every render.
const astCache = new Map<string, ASTNode | null>();

function compile(expression: string): ASTNode | null {
  const cached = astCache.get(expression);
  if (cached !== undefined) return cached;
  let ast: ASTNode | null;
  try {
    ast = parse(expression);
  } catch {
    ast = null;
  }
  if (astCache.size >= MAX_CACHED_EXPRESSIONS) {
    const oldest = astCache.keys().next().value;
    if (oldest !== undefined) astCache.delete(oldest);
  }
  astCache.set(expression, ast);
  return ast;
}

/**
 * Whether a contribution's `when` holds against `context`. A missing or empty
 * clause always holds; one that fails to parse never does. Unset keys evaluate
 * falsy, so `!unsetKey` holds — the documented permissive-negation caveat.
 */
export function evaluateWhenClause(
  expression: string | undefined,
  context: WhenClauseContext
): boolean {
  if (!expression) return true;
  const ast = compile(expression);
  return ast !== null && evaluate(ast, context);
}

/** Test-only: drop every cached parse. */
export function _resetWhenClauseCacheForTest(): void {
  astCache.clear();
}
