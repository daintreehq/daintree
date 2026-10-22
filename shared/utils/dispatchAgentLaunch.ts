/**
 * The action that starts an agent from a caller's arguments (#13762).
 *
 * Named here rather than in the renderer for the same reason as
 * `TERMINAL_LAUNCH_ACTION_ID`: the elevation is scoped by this id, and the
 * resolver that reads it runs in main as well.
 */
export const AGENT_LAUNCH_ACTION_ID = "agent.launch";

/**
 * Whether an `agent.launch` dispatch configures the agent rather than only
 * giving it a task: extra CLI flags, environment variables or a standing
 * system-prompt instruction. Those change what the agent is permitted to do and
 * how it runs, which is more than "a fresh agent the user can see" — the
 * contract the plugin path documents for `{ agentId, prompt }`.
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
    dispatchCarriesAgentSystemPrompt(args)
  );
}

/**
 * Any flag counts, blank ones included, since each entry reaches the CLI's argv.
 * Only an absent or empty list launches with the agent's own configuration.
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
  return value === null || typeof value !== "object" || Object.keys(value).length > 0;
}

/** A blank instruction maps to no launch arguments, so it does not count. */
export function dispatchCarriesAgentSystemPrompt(args: unknown): boolean {
  const value = readField(args, "systemPrompt");
  if (value === undefined) return false;
  return typeof value !== "string" || value.trim().length > 0;
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
