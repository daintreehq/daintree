import type { ActionDanger, ActionSource } from "@shared/types/actions";
import { dispatchCarriesRecipeId } from "@shared/utils/dispatchRecipeId";
import {
  dispatchCarriesTerminalCommand,
  dispatchCarriesTerminalCwd,
} from "@shared/utils/dispatchTerminalCommand";

export { dispatchCarriesRecipeId, readDispatchRecipeId } from "@shared/utils/dispatchRecipeId";
export {
  dispatchCarriesTerminalCommand,
  dispatchCarriesTerminalCwd,
  readDispatchTerminalCommand,
  readDispatchTerminalCwd,
} from "@shared/utils/dispatchTerminalCommand";

/**
 * The one action whose `cwd`/`command` arguments spawn a shell (#12216). The
 * elevation below is scoped to it by id rather than keyed on the argument alone
 * — see {@link readDispatchTerminalCommand} for why `command` cannot be a
 * global signal the way `recipeId` is.
 */
const TERMINAL_LAUNCH_ACTION_ID = "terminal.new";

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
  actionId: string,
  declaredDanger: ActionDanger,
  source: ActionSource,
  args: unknown
): ActionDanger {
  if (declaredDanger !== "safe") return declaredDanger;
  if (source === "agent" && dispatchCarriesRecipeId(args)) return "confirm";
  // `terminal.new`'s launch arguments (#12216). Same raise-only, per-dispatch
  // shape, but scoped to the one action that spawns a shell from them rather
  // than keyed on the argument globally: `command` is an ordinary field name,
  // and gating every safe action that happens to take one would wrongly
  // confirm `system.checkCommand`, which explicitly runs nothing.
  //
  // Applies to PLUGIN dispatch as well as agent. `terminal.sendCommand` and
  // `terminal.paste` both carry `denyPluginDispatch` precisely because
  // injecting a command into a terminal is what the capability model gates,
  // and a `terminal.new` carrying a command is that same authority. Plugins
  // have no confirm bypass, so elevating here is what refuses them — and
  // unlike `denyPluginDispatch` it refuses only the dispatches that actually
  // carry a launch target, leaving a plugin's plain "open a terminal" working.
  //
  // `cwd` is elevated too: the shell is launched as a login shell, so
  // directory-sensitive startup hooks (direnv, auto-venv, PROMPT_COMMAND) can
  // run on entry. That makes an arbitrary caller-chosen directory not reliably
  // execution-free, which is the assumption gating `command` alone would rest on.
  if (
    actionId === TERMINAL_LAUNCH_ACTION_ID &&
    (source === "agent" || source === "plugin") &&
    (dispatchCarriesTerminalCommand(args) || dispatchCarriesTerminalCwd(args))
  ) {
    return "confirm";
  }
  return declaredDanger;
}

/**
 * Why a `terminal.new` dispatch was elevated, matching the resolver's own
 * precedence: a command is the stronger claim, so it wins when both are present.
 */
export function terminalLaunchDangerRationale(args: unknown): string | undefined {
  if (dispatchCarriesTerminalCommand(args)) return TERMINAL_COMMAND_DISPATCH_DANGER_RATIONALE;
  if (dispatchCarriesTerminalCwd(args)) return TERMINAL_CWD_DISPATCH_DANGER_RATIONALE;
  return undefined;
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

/** Counterpart for a dispatch that only chooses where the terminal opens. */
export const TERMINAL_CWD_DISPATCH_DANGER_RATIONALE =
  "This call opens a terminal in a directory it chose. The shell starts as a login shell there, so directory-sensitive startup hooks in your shell configuration can run on entry.";
