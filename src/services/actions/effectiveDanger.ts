import type { ActionDanger, ActionSource } from "@shared/types/actions";

/**
 * Host-derived confirmation tier for one dispatch (#11860).
 *
 * `ActionDefinition.danger` is static, so it can only describe an action's
 * worst case. Two composites — `worktree.createWithRecipe` and
 * `workflow.startWorkOnIssue` — are legitimately `"safe"` on their own (create
 * a worktree, fetch an issue) but spawn a recipe's terminals when the args
 * carry a `recipeId`. Raising their declared danger would confirmation-gate
 * every plain worktree creation, which is the over-gating #10577 rejected; not
 * raising it at all left `recipe.run`'s `"confirm"` tier with a documented way
 * around it.
 *
 * So the elevation is per-dispatch and keyed on the ARGUMENT, not on an action
 * allowlist: any agent-sourced dispatch carrying a non-empty `recipeId` is
 * treated as `"confirm"`. An allowlist would need updating for every future
 * composite and would silently under-gate the one someone forgets. The cost is
 * that two other recipeId-taking safe actions (`recipe.editor.open`,
 * `recipe.saveToRepo`) also gain an agent confirmation — correct for the second,
 * which writes into the repo, and cheap for the first.
 *
 * Raise-only: `"confirm"` and `"restricted"` are returned untouched, so this can
 * never lower a tier a definition declared for itself (#8331).
 *
 * ONE function, read by both enforcement sites — `ActionService.dispatch`, which
 * rejects, and `useMcpBridge`, which decides whether to raise the modal. If the
 * two ever disagreed, an agent would get `CONFIRMATION_REQUIRED` with no dialog
 * ever shown: not a bypass, but a dead end for every legitimate caller.
 */
export function resolveEffectiveActionDanger(
  declaredDanger: ActionDanger,
  source: ActionSource,
  args: unknown
): ActionDanger {
  if (declaredDanger !== "safe") return declaredDanger;
  if (source !== "agent") return declaredDanger;
  return dispatchCarriesRecipeId(args) ? "confirm" : declaredDanger;
}

/**
 * Whether a dispatch's arguments name a recipe to run. Only a non-empty string
 * counts: an empty or non-string `recipeId` is rejected by the action's own
 * schema or resolves to no recipe, so gating on it would confirm a dispatch
 * that can never spawn anything.
 */
export function dispatchCarriesRecipeId(args: unknown): boolean {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  if (!("recipeId" in args)) return false;
  const recipeId = args.recipeId;
  return typeof recipeId === "string" && recipeId.length > 0;
}

/**
 * Why a dispatch was elevated, surfaced in the host confirm dialog so the human
 * sees the same reasoning the model does. Used only when the elevation actually
 * fires — the action's own `dangerRationale` still wins when it has one.
 */
export const RECIPE_DISPATCH_DANGER_RATIONALE =
  "This call carries a recipe id, so it spawns the recipe's terminals — each running shell commands or launching agents. Agent-initiated runs are confirmation-gated wherever they happen, not only through recipe.run.";
