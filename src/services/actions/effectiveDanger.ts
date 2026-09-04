import type { ActionDanger, ActionSource } from "@shared/types/actions";
import { dispatchCarriesRecipeId } from "@shared/utils/dispatchRecipeId";
import { dispatchCarriesTerminalCommand } from "@shared/utils/dispatchTerminalCommand";

export { dispatchCarriesRecipeId, readDispatchRecipeId } from "@shared/utils/dispatchRecipeId";
export {
  dispatchCarriesTerminalCommand,
  readDispatchTerminalCommand,
} from "@shared/utils/dispatchTerminalCommand";

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
  if (dispatchCarriesRecipeId(args)) return "confirm";
  // Same argument-keyed shape for `terminal.new`'s `command` (#12216): opening
  // a terminal is safe, and opening one at a chosen `cwd` still only runs what
  // the human types — but a `command` executes on the agent's behalf, which is
  // the authority `recipe.run` gates. Raising the declared tier instead would
  // confirmation-gate every plain "New Terminal", the over-gating #10577
  // rejected.
  if (dispatchCarriesTerminalCommand(args)) return "confirm";
  return declaredDanger;
}

/**
 * Why a dispatch was elevated, surfaced in the host confirm dialog so the human
 * sees the same reasoning the model does. Used only when the elevation actually
 * fires — the action's own `dangerRationale` still wins when it has one.
 */
export const RECIPE_DISPATCH_DANGER_RATIONALE =
  "This call carries a recipe id, so it spawns the recipe's terminals — each running shell commands or launching agents. Agent-initiated runs are confirmation-gated wherever they happen, not only through recipe.run.";

/** Counterpart for a dispatch that asks a new terminal to run a command. */
export const TERMINAL_COMMAND_DISPATCH_DANGER_RATIONALE =
  "This call carries a command, so the new terminal runs it immediately rather than waiting for you to type. Agent-initiated shell execution is confirmation-gated wherever it happens.";
