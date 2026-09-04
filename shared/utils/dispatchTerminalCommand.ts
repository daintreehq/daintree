/**
 * The one action whose `cwd`/`command` arguments spawn a shell (#12216).
 *
 * Lives beside the readers rather than in the renderer, because three gates now
 * scope the same rule by this id: the renderer's danger elevation, the
 * main-process bound-session refusal, and the target-policy record's
 * `confirmationMayEscalate`. A copy per process is a copy that can be updated in
 * one place and forgotten in the other two.
 */
export const TERMINAL_LAUNCH_ACTION_ID = "terminal.new";

const TERMINAL_COMMAND_ARG = "command";
const TERMINAL_CWD_ARG = "cwd";

/**
 * The launch arguments the elevation keys on, named once here so a caller that
 * has no ARGS to read — the target-policy record is built at discovery time from
 * the declared input schema alone — still asks about the same two fields the
 * readers below do.
 */
export const TERMINAL_LAUNCH_ARGS: readonly string[] = [TERMINAL_COMMAND_ARG, TERMINAL_CWD_ARG];

/**
 * The launch target a `terminal.new` dispatch asks for: a command to run, a
 * directory to open in, or neither.
 *
 * Unlike {@link readDispatchRecipeId}, these are NOT safe to key on by
 * argument alone. `recipeId` means one thing everywhere, but `command` is an
 * ordinary field name — `system.checkCommand` takes one and explicitly does not
 * run it, and `terminal.sendCommand` takes one and is gated a different way. So
 * the caller matches the action id first and only then asks these; they live in
 * `shared/` for the same reason the recipe reader does, so a main-process guard
 * and the renderer's elevation resolve the same dispatch by one rule.
 */
export function readDispatchTerminalCommand(args: unknown): string | undefined {
  return readNonEmptyStringField(args, TERMINAL_COMMAND_ARG);
}

/** The directory a dispatch asks the new terminal to open in. */
export function readDispatchTerminalCwd(args: unknown): string | undefined {
  return readNonEmptyStringField(args, TERMINAL_CWD_ARG);
}

/** Whether a dispatch asks a terminal to run a command. */
export function dispatchCarriesTerminalCommand(args: unknown): boolean {
  return readDispatchTerminalCommand(args) !== undefined;
}

/** Whether a dispatch asks a terminal to open somewhere the caller chose. */
export function dispatchCarriesTerminalCwd(args: unknown): boolean {
  return readDispatchTerminalCwd(args) !== undefined;
}

/**
 * Only a non-empty string counts, and whitespace does not make one: a blank
 * `command` spawns a plain shell, so gating on it would confirm a dispatch that
 * runs nothing. Reads through the prototype chain deliberately — an inherited
 * value elevates rather than slipping past, since under-gating is the failure
 * that matters.
 */
function readNonEmptyStringField(args: unknown, field: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (!(field in args)) return undefined;
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
