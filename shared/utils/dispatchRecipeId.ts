/**
 * The recipe a dispatch names, or `undefined` when it names none. Only a
 * non-empty string counts: an empty or non-string `recipeId` is rejected by the
 * action's own schema or resolves to no recipe, so gating on it would confirm a
 * dispatch that can never spawn anything.
 *
 * The single extraction point — the renderer's danger elevation, the confirm
 * preview and the main-process workspace-bound MCP guard all read it here, so
 * the dispatch that gets gated, the recipe that gets previewed and the call
 * that gets refused can never be resolved by three subtly different rules. It
 * lives in `shared/` for that reason: the bound-session guard runs in main and
 * cannot reach the renderer module that used to own it.
 */
export function readDispatchRecipeId(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (!("recipeId" in args)) return undefined;
  const recipeId = args.recipeId;
  return typeof recipeId === "string" && recipeId.length > 0 ? recipeId : undefined;
}

/** Whether a dispatch's arguments name a recipe. See {@link readDispatchRecipeId}. */
export function dispatchCarriesRecipeId(args: unknown): boolean {
  return readDispatchRecipeId(args) !== undefined;
}
