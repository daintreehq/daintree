/**
 * Typed provision failure surfaced through the IPC layer with a structured
 * code so the renderer can match-and-display without parsing prose. Used when
 * Daintree control is enabled but the in-process assistant services can't be
 * made ready, which would otherwise launch the assistant with broken wiring.
 *
 * The two failure modes are distinguished so the renderer can show distinct
 * recovery copy: `MCP_SERVER_NOT_STARTED` means the in-process server never
 * came up, while `MCP_PROBE_FAILED` means it bound a port and minted a session
 * but the readiness probe didn't respond in time. `MCP_NOT_READY` is retained
 * as a legacy alias the renderer still classifies (falling back to the
 * probe-failed shape) so older serialized errors keep displaying.
 *
 * `USER_CONTENT_SYNC_FAILED` means the user commands/skills mirror could not
 * reconcile the session dir — either a source folder was unreadable (desired
 * state unprovable) or a stale managed skill could not be removed. Launching
 * anyway would run the session with outdated or unowned skill instructions,
 * so provisioning fails closed and the renderer shows a retryable error.
 *
 * `UNSUPPORTED_ASSISTANT_AGENT` is a refusal rather than a failure: the agent
 * declares an `mcpInjection` mode Daintree has no implementation for, so a
 * session provisioned under it would launch with no MCP wiring at all. The
 * renderer has no dedicated copy for it yet and degrades to the generic
 * spawn-failed shape.
 */
export type HelpSessionErrorCode =
  | "MCP_NOT_READY"
  | "MCP_SERVER_NOT_STARTED"
  | "MCP_PROBE_FAILED"
  | "USER_CONTENT_SYNC_FAILED"
  | "LANE_OCCUPIED"
  | "UNSUPPORTED_ASSISTANT_AGENT";

export class HelpSessionError extends Error {
  readonly code: HelpSessionErrorCode;
  constructor(code: HelpSessionErrorCode, message: string) {
    super(message);
    this.name = "HelpSessionError";
    this.code = code;
  }
}
