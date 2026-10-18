/**
 * Launch agents whose MCP session replays the context captured at launch
 * (#12486). Claude is the only one main binds to its launch workspace; the
 * Daintree Assistant keeps whatever its own caller supplies. Shared so the
 * host's viewless launch (#13495) captures it for the same agents a view does.
 */
export const LAUNCH_CONTEXT_AGENT_IDS: ReadonlySet<string> = new Set(["claude"]);
