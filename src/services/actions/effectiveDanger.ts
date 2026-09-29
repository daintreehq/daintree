import { dispatchCarriesRecipeId } from "@shared/utils/dispatchRecipeId";
import {
  dispatchCarriesTerminalCommand,
  dispatchCarriesTerminalCwd,
} from "@shared/utils/dispatchTerminalCommand";
import { CLOSE_ALL_ACTION_ID } from "@shared/utils/effectiveActionDanger";

export { dispatchCarriesRecipeId, readDispatchRecipeId } from "@shared/utils/dispatchRecipeId";
export {
  CLOSE_ALL_ACTION_ID,
  resolveEffectiveActionDanger,
} from "@shared/utils/effectiveActionDanger";
export {
  dispatchCarriesTerminalCommand,
  dispatchCarriesTerminalCwd,
  readDispatchTerminalCommand,
  readDispatchTerminalCwd,
  TERMINAL_LAUNCH_ACTION_ID,
} from "@shared/utils/dispatchTerminalCommand";

/**
 * Why a safe dispatch was elevated, for the host confirm dialog. Only read
 * when the elevation actually fired. A close-all names its sweep whatever else
 * its arguments carry, since that is the consequence being approved.
 */
export function elevatedDangerRationale(actionId: string, args: unknown): string {
  if (actionId === CLOSE_ALL_ACTION_ID) return CLOSE_ALL_DISPATCH_DANGER_RATIONALE;
  if (dispatchCarriesRecipeId(args)) return RECIPE_DISPATCH_DANGER_RATIONALE;
  return terminalLaunchDangerRationale(args) ?? RECIPE_DISPATCH_DANGER_RATIONALE;
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

/** Counterpart for an agent closing every panel in the worktree. */
export const CLOSE_ALL_DISPATCH_DANGER_RATIONALE =
  "This closes every panel in the active worktree, including your own shells and other agents' terminals, not just ones the assistant opened. Most go to the trash briefly; after that their processes are gone.";

/** Counterpart for a dispatch that only chooses where the terminal opens. */
export const TERMINAL_CWD_DISPATCH_DANGER_RATIONALE =
  "This call opens a terminal in a directory it chose. The shell starts as a login shell there, so directory-sensitive startup hooks in your shell configuration can run on entry.";
