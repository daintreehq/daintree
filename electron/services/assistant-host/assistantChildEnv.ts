/**
 * The environment every Daintree-spawned assistant child starts from.
 *
 * Extracted from `AssistantHostService` when the account commands were found to be
 * inheriting `process.env` whole. Everything Daintree spawns from the vendored binary —
 * the engine, `auth status`, `auth login`, `auth logout` — has to strip the same names,
 * and a second copy of the list is how the two drift apart. It lives beside
 * `resolveBackendUrl`, which exists for exactly the same reason.
 */

/**
 * Assistant-control variables stripped from the inherited environment.
 *
 * `process.env` is spread into the child so it keeps PATH, HOME and the rest of a
 * normal environment. But these particular names are the engine's SAFETY surface — its
 * control plane, its bearer, its tier, and the switch that runs mutating tools with no
 * confirmation at all. Inheriting them means whatever is exported in the shell that
 * launched Electron silently outranks what Daintree decided: a stale `DAINTREE_MCP_URL`
 * survives a provisioning failure and points the engine at a dead endpoint, and an
 * ambient `DAINTREE_ASSISTANT_AUTO_APPROVE=1` turns approvals off for a user whose
 * settings say otherwise. Every one of them is re-set below from an authoritative
 * source, or deliberately left unset.
 */
export const ENGINE_CONTROLLED_ENV = [
  "DAINTREE_MCP_URL",
  "DAINTREE_MCP_TOKEN",
  "DAINTREE_ASSISTANT_TIER",
  "DAINTREE_ASSISTANT_AUTO_APPROVE",
  "DAINTREE_ASSISTANT_DEBUG_LOG",
  "DAINTREE_ASSISTANT_LOG_DIR",
  "DAINTREE_PROJECT_ID",
  "DAINTREE_WINDOW_ID",
  // The engine's UPSTREAM credential (internal/config/config.go), sent as the backend
  // bearer. There is no sign-in here and Daintree mints nothing, so the only way this
  // can be set is by inheritance — and an inherited key does not fail, it succeeds:
  // turns go through, billed to whoever the key belongs to, with nothing on screen to
  // say the session stopped being anonymous. Stripped and never re-set, which is what
  // "zero authentication" has to mean if it is to mean anything.
  "DAINTREE_API_KEY",
  // The endpoint. Not inherited raw — `resolveBackendUrl` decides it below, and letting
  // the parent's value through would sit in the environment beside the resolved one.
  "DAINTREE_BACKEND_URL",
] as const;

/**
 * Names to strip, upper-cased once.
 *
 * Windows environment variables are case-INSENSITIVE: a parent that exported
 * `daintree_assistant_auto_approve=1` reaches `process.env` under that spelling, an
 * exact-match filter keeps it, and the child then reads it under any casing. The one
 * variable where that matters most is the one that turns off every confirmation.
 */
const ENGINE_CONTROLLED_ENV_UPPER = new Set<string>(
  ENGINE_CONTROLLED_ENV.map((name) => name.toUpperCase())
);

/**
 * An inherited environment with the assistant-control variables removed.
 *
 * Shared with the account service, which spawns the same binary for `auth` commands and
 * had been inheriting `process.env` whole. That asymmetry was not academic: the engine
 * was carefully denied an ambient `DAINTREE_API_KEY` while the commands that report who
 * you are signed in as were handed it. One list, applied by everything Daintree spawns.
 */
export function assistantChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENGINE_CONTROLLED_ENV_UPPER.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return env;
}
