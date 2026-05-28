/**
 * Default-deny `ClientOptions` for `@modelcontextprotocol/sdk` `Client`
 * instances spawned by the plugin-MCP supervisor. The empty `capabilities`
 * object signals to the connected server that this client does NOT advertise
 * `sampling` or `elicitation` — the SDK enforces the absence at the
 * protocol level, returning an error to the server if it attempts to use
 * either flow.
 *
 * `sampling` lets a server ask the host to run an LLM inference on its
 * behalf; `elicitation` lets it prompt the user for arbitrary structured
 * input. Both are powerful sidechannels that bypass Daintree's consent UI
 * and audit log entirely. They stay default-off until the host gains a
 * dedicated permission gate for them (out of scope for #9234).
 *
 * Wired by the plugin-MCP supervisor stub introduced in #9233 — this helper
 * is exported here so the supervisor's `Client` construction can stay a one-
 * line read with the security rationale colocated.
 */
export function buildPluginMcpClientOptions(): { capabilities: Record<string, never> } {
  return { capabilities: {} };
}
