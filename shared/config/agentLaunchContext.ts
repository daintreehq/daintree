/**
 * Launch agents whose launch-time context is captured automatically for their
 * MCP session to replay (#12486). Shared so the host's viewless launch (#13495)
 * captures it for the same agents a view does.
 */
export const LAUNCH_CONTEXT_AGENT_IDS: ReadonlySet<string> = new Set(["claude"]);
