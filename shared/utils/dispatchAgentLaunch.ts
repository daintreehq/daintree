/**
 * The action that starts an agent from a caller's arguments (#13762).
 *
 * Named here rather than in the renderer for the same reason as
 * `TERMINAL_LAUNCH_ACTION_ID`: the elevation is scoped by this id, and the
 * resolver that reads it runs in main as well.
 */
export const AGENT_LAUNCH_ACTION_ID = "agent.launch";

/**
 * Whether an `agent.launch` dispatch chooses how the agent runs rather than
 * only giving it a task: extra CLI flags, environment variables, a standing
 * system-prompt instruction, a launch preset, or a prompt the CLI would read as
 * an option. Those change what the agent is permitted to do and how it runs,
 * which is more than "a fresh agent the user can see" — the contract the plugin
 * path documents for `{ agentId, prompt }`.
 *
 * Like the terminal launch readers, these key on field names that are ordinary
 * elsewhere (`env`), so the caller matches the action id first. They read
 * through the prototype chain deliberately: an inherited value elevates rather
 * than slipping past, since under-gating is the failure that matters.
 */
export function dispatchConfiguresAgentLaunch(args: unknown): boolean {
  return (
    dispatchCarriesAgentLaunchFlags(args) ||
    dispatchCarriesAgentLaunchEnv(args) ||
    dispatchCarriesAgentSystemPrompt(args) ||
    dispatchCarriesAgentPreset(args) ||
    dispatchCarriesOptionLikePrompt(args)
  );
}

/**
 * Any flag counts, blank ones included. The launch plan drops empty entries, so
 * refusing them is conservative rather than necessary; only an absent or empty
 * list launches with the agent's own configuration.
 */
export function dispatchCarriesAgentLaunchFlags(args: unknown): boolean {
  const value = readField(args, "agentLaunchFlags");
  if (value === undefined) return false;
  return !Array.isArray(value) || value.length > 0;
}

/**
 * Any variable counts, an empty value included: setting one to `""` is not the
 * same as leaving it inherited.
 */
export function dispatchCarriesAgentLaunchEnv(args: unknown): boolean {
  const value = readField(args, "env");
  if (value === undefined) return false;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
  return Object.keys(value).length > 0;
}

/** A blank instruction maps to no launch arguments, so it does not count. */
export function dispatchCarriesAgentSystemPrompt(args: unknown): boolean {
  const value = readField(args, "systemPrompt");
  if (value === undefined) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

/**
 * Any explicit choice counts, `null` included. A preset carries its own args,
 * env and permission-bypass mode — some built-in presets turn bypass on — and
 * `null` drops the default preset, which may be the one vetoing a bypass the
 * agent's settings would otherwise apply. Only omitting it keeps the user's own
 * default.
 */
export function dispatchCarriesAgentPreset(args: unknown): boolean {
  return readField(args, "presetId") !== undefined;
}

/**
 * Most CLIs take the first turn as a positional argument, so a prompt that
 * starts with `-` is parsed as an option: `--dangerously-skip-permissions` as a
 * prompt is the bypass flag, not a task. Leading whitespace is trimmed before
 * the command is built, so it does not hide one.
 */
export function dispatchCarriesOptionLikePrompt(args: unknown): boolean {
  const value = readField(args, "prompt");
  return typeof value === "string" && value.trim().startsWith("-");
}

/**
 * Only `undefined` is absent. A value of the wrong type, `null` included, counts
 * as configuration: the kit draws controls from unvalidated arguments, and
 * dispatch refuses such a value on the schema regardless.
 */
function readField(args: unknown, field: string): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (!(field in args)) return undefined;
  return (args as Record<string, unknown>)[field];
}
