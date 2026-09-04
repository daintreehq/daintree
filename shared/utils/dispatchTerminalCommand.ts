/**
 * The shell command a dispatch asks a new terminal to run, or `undefined` when
 * it asks for none. Only a non-empty string counts: an empty or non-string
 * `command` is rejected by the action's own schema or spawns a plain shell, so
 * gating on it would confirm a dispatch that runs nothing.
 *
 * Deliberately keyed on `command` alone. `cwd` opens a terminal somewhere the
 * caller chose but still runs only what the human types, which is the same
 * authority a plain `terminal.new` already has; `command` executes on the
 * caller's behalf, which is `recipe.run`'s tier.
 *
 * The single extraction point, for the same reason as
 * {@link readDispatchRecipeId}: it lives in `shared/` so a main-process guard
 * and the renderer's danger elevation resolve the gated dispatch by one rule
 * rather than two that can drift.
 */
export function readDispatchTerminalCommand(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (!("command" in args)) return undefined;
  const command = args.command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

/** Whether a dispatch asks a terminal to run a command. See {@link readDispatchTerminalCommand}. */
export function dispatchCarriesTerminalCommand(args: unknown): boolean {
  return readDispatchTerminalCommand(args) !== undefined;
}
