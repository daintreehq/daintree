/**
 * Launch agents whose MCP session replays the context captured at launch
 * (#12486). Claude is the only one main binds to its launch workspace. Shared
 * so the host's viewless launch (#13495) captures it for the same agents a view
 * does.
 */
export const LAUNCH_CONTEXT_AGENT_IDS: ReadonlySet<string> = new Set(["claude"]);
