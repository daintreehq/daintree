import type { ActionDanger, ActionSource } from "../types/actions.js";
import { dispatchCarriesRecipeId } from "./dispatchRecipeId.js";
import {
  dispatchCarriesTerminalCommand,
  dispatchCarriesTerminalCwd,
  TERMINAL_LAUNCH_ACTION_ID,
} from "./dispatchTerminalCommand.js";

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
 * ONE function, read by every enforcement site — `ActionService.dispatch`, which
 * rejects, `useMcpBridge`, which decides whether to raise the modal, and the MCP
 * session server, which decides what the assistant's skip preference covers
 * (#12874). It lives in `shared/` so main can read it too. If the
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
  // `terminal.closeAll` from an agent (#12881). Declared safe because a person
  // clearing their own worktree has the undo toast and no need for a dialog;
  // an agent sweeping every panel — the user's shells and other agents' work
  // included — is the case a confirmation exists for. Only Daintree's own
  // assistant can reach it at all, so this is its gate.
  if (actionId === CLOSE_ALL_ACTION_ID && source === "agent") return "confirm";
  return declaredDanger;
}

/** The one close that sweeps panels the caller never named. */
export const CLOSE_ALL_ACTION_ID = "terminal.closeAll";
